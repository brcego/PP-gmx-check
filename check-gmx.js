import { promises as fs } from "node:fs";

// --- CSV Utilities ---

export async function readAccounts(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return data
      .split("\n")
      .slice(1) // skip header
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const parts = line.split(",");
        return {
          email: parts[0]?.trim() || "",
          password: parts[1]?.trim() || "",
          status: parts[2]?.trim() || "",
        };
      });
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`File not found: ${filePath}`);
      return [];
    }
    throw error;
  }
}

export async function writeAccounts(filePath, accounts) {
  const header = "email,password,status";
  const lines = accounts.map((a) => `${a.email},${a.password},${a.status}`);
  await fs.writeFile(filePath, [header, ...lines].join("\n"), "utf-8");
}

// --- Worker Pool ---

export async function runWithConcurrency(items, maxConcurrent, fn) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        await fn(items[currentIndex]);
      } catch (error) {
        console.error(`Error processing item ${currentIndex}:`, error.message);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, items.length) },
    () => worker()
  );
  await Promise.all(workers);
}

// --- Browser Automation ---

async function checkAccount(browser, account, config) {
  const context = await browser.newContext({
    proxy: config.proxy.server
      ? {
          server: config.proxy.server,
          username: config.proxy.username,
          password: config.proxy.password,
        }
      : undefined,
  });

  const page = await context.newPage();

  try {
    // Set consent bypass cookie to skip GDPR popup
    await context.addCookies([
      {
        name: "euconsent-bypass",
        value: "1",
        domain: ".gmx.com",
        path: "/",
      },
    ]);

    // Navigate to GMX
    console.log(`[${account.email}] Navigating to gmx.com...`);
    await page.goto("https://www.gmx.com/", {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });

    // Click the login button to open login layer
    console.log(`[${account.email}] Opening login form...`);
    const loginTrigger = page.locator(
      'a.button-login, button.button-login, .nav-login, [data-target="login"]'
    );
    await loginTrigger.first().click({ timeout: 10000 });

    // Wait for the login form to appear
    // It may be in the main page or inside an iframe from auth.gmx.net
    await page.waitForTimeout(1500);

    // Try to find login fields — check iframes first, then main page
    let loginFrame = page;
    const frames = page.frames();
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes("auth.gmx") || url.includes("login")) {
        const emailField = await frame.locator('input[type="email"], input[name="username"], input[placeholder*="mail" i]').count();
        if (emailField > 0) {
          loginFrame = frame;
          console.log(`[${account.email}] Found login form in iframe: ${url}`);
          break;
        }
      }
    }

    // Fill credentials
    console.log(`[${account.email}] Entering credentials...`);
    const emailInput = loginFrame.locator(
      'input[type="email"], input[name="username"], input[placeholder*="mail" i], input[id*="email" i]'
    );
    const passwordInput = loginFrame.locator(
      'input[type="password"], input[name="password"], input[placeholder*="assword" i]'
    );

    await emailInput.first().fill(account.email, { timeout: 5000 });
    await passwordInput.first().fill(account.password, { timeout: 5000 });

    // Submit the form
    const submitButton = loginFrame.locator(
      'button[type="submit"], form button, .login-box button, button.btn-login'
    );
    await submitButton.first().click({ timeout: 5000 });
    console.log(`[${account.email}] Submitted login...`);

    // Detect login outcome
    const result = await Promise.race([
      // Success: redirected to mail dashboard
      page
        .waitForURL("**/navigator-bs.gmx.com/**", {
          timeout: config.timeouts.loginResult,
        })
        .then(() => "Account Active"),

      // CAPTCHA triggered
      page
        .locator(".captchafox, [class*='captcha' i]")
        .first()
        .waitFor({ state: "visible", timeout: config.timeouts.loginResult })
        .then(() => "CAPTCHA Blocked"),

      // Error banner (banned/deleted/wrong password)
      page
        .locator("div.error, .login-error, [class*='error' i]")
        .first()
        .waitFor({ state: "visible", timeout: config.timeouts.loginResult })
        .then(async () => {
          const errorText = await page
            .locator("div.error, .login-error, [class*='error' i]")
            .first()
            .textContent()
            .catch(() => "");
          const upper = (errorText || "").toUpperCase();
          if (upper.includes("TRY AGAIN") || upper.includes("NOT FOUND") || upper.includes("DOES NOT EXIST")) {
            return "Banned";
          }
          if (upper.includes("PASSWORD") || upper.includes("CREDENTIAL") || upper.includes("INCORRECT")) {
            return "Wrong Password";
          }
          if (upper.includes("IRREGULARITY") || upper.includes("SUSPICIOUS") || upper.includes("SECURITY")) {
            return "Irregularity";
          }
          return "Banned";
        }),

      // Overall timeout
      new Promise((resolve) =>
        setTimeout(() => resolve("Error"), config.timeouts.loginResult + 2000)
      ),
    ]);

    account.status = result;
    console.log(`[${account.email}] => ${result}`);
  } catch (error) {
    console.error(`[${account.email}] Error: ${error.message}`);
    account.status = "Error";
  } finally {
    await context.close();
  }
}

// --- Main ---

async function main(configPath = "config.json") {
  // Load config
  const configData = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(configData);

  console.log(`GMX Account Checker v2.0`);
  console.log(`Concurrency: ${config.concurrency}`);
  console.log(`Proxy: ${config.proxy.server || "none"}`);
  console.log(`Headless: ${config.headless}`);
  console.log("---");

  // Read accounts
  const accounts = await readAccounts(config.accountsFile);
  if (accounts.length === 0) {
    console.log("No accounts found. Exiting.");
    return;
  }

  // Filter to accounts that need checking (resumability)
  const toCheck = accounts.filter((a) => a.status !== "Account Active");
  const skipped = accounts.length - toCheck.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} accounts already marked as Active.`);
  }
  console.log(`Checking ${toCheck.length} accounts...\n`);

  if (toCheck.length === 0) {
    console.log("All accounts already active. Nothing to do.");
    return;
  }

  // Launch browser with stealth
  const { chromium } = await import("playwright-extra");
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  chromium.use(StealthPlugin());

  const browser = await chromium.launch({
    headless: config.headless,
  });

  try {
    let processed = 0;

    await runWithConcurrency(toCheck, config.concurrency, async (account) => {
      await checkAccount(browser, account, config);
      processed++;

      // Write CSV after every account (for resumability)
      await writeAccounts(config.accountsFile, accounts);

      // Progress
      console.log(`  Progress: ${processed}/${toCheck.length}\n`);

      // Delay between accounts
      if (config.timeouts.betweenAccounts > 0) {
        await new Promise((r) => setTimeout(r, config.timeouts.betweenAccounts));
      }
    });

    // Final summary
    const active = accounts.filter((a) => a.status === "Account Active").length;
    const banned = accounts.filter((a) => a.status === "Banned").length;
    const errors = accounts.filter((a) => a.status === "Error").length;
    const captcha = accounts.filter((a) => a.status === "CAPTCHA Blocked").length;
    const wrongPw = accounts.filter((a) => a.status === "Wrong Password").length;
    const irregular = accounts.filter((a) => a.status === "Irregularity").length;

    console.log("\n=== DONE ===");
    console.log(`Active: ${active}`);
    console.log(`Banned: ${banned}`);
    console.log(`Wrong Password: ${wrongPw}`);
    console.log(`CAPTCHA Blocked: ${captcha}`);
    console.log(`Irregularity: ${irregular}`);
    console.log(`Errors: ${errors}`);
    console.log(`Total: ${accounts.length}`);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

// Only run main() when executed directly (not imported by tests)
const isDirectRun = process.argv[1]?.endsWith("check-gmx.js");
if (isDirectRun) {
  const configPath = process.argv[2] || "config.json";
  main(configPath).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
