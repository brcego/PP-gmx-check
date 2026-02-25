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
  const maxRetries = config.maxRetries || 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await attemptCheckAccount(browser, account, config);
    if (result !== "Retry") return;
    console.log(`[${account.email}] Retrying (${attempt}/${maxRetries})...`);
  }
  // All retries exhausted
  account.status = "Error";
  console.log(`[${account.email}] => Error (max retries exhausted)`);
}

async function attemptCheckAccount(browser, account, config) {
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

  // Block images to save proxy bandwidth
  await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,ico}", (route) =>
    route.abort()
  );

  try {
    // Navigate to GMX
    console.log(`[${account.email}] Navigating to gmx.com...`);
    try {
      await page.goto("https://www.gmx.com/", {
        waitUntil: "load",
        timeout: config.timeouts.navigation,
      });
    } catch {
      await page.goto("https://www.gmx.com/", {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
    }

    // Handle consent page if redirected there
    if (page.url().includes("consent")) {
      console.log(`[${account.email}] Handling consent page...`);
      await page.waitForTimeout(3000);
      for (const frame of page.frames()) {
        try {
          const agreeBtn = frame.locator('button:has-text("Agree and continue")');
          if (await agreeBtn.count() > 0 && await agreeBtn.first().isVisible()) {
            await agreeBtn.first().click();
            break;
          }
        } catch {}
      }
      await page.waitForURL("**/www.gmx.com/", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Click the login button to open login layer
    console.log(`[${account.email}] Opening login form...`);
    await page.locator(".button-login").first().click({ timeout: 10000 });

    // Wait for login form inputs to become visible
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 5000 });

    // Fill credentials
    console.log(`[${account.email}] Entering credentials...`);
    await page.locator("#login-email").fill(account.email);
    await page.locator("#login-password").fill(account.password);

    // Submit the form
    await page.locator("button.login-submit").click();
    console.log(`[${account.email}] Submitted login...`);

    // Detect login outcome by watching for URL changes
    const result = await Promise.race([
      // Success: redirected to mail dashboard
      page
        .waitForURL("**/navigator-bs.gmx.com/**", {
          timeout: config.timeouts.loginResult,
        })
        .then(() => "Account Active"),

      // Failed login: redirected to /logout/ page with error
      page
        .waitForURL("**/logout/**", {
          timeout: config.timeouts.loginResult,
        })
        .then(async () => {
          const errorText = await page
            .locator("div.error")
            .first()
            .textContent()
            .catch(() => "");
          const upper = (errorText || "").toUpperCase();
          if (upper.includes("TRY AGAIN") || upper.includes("INVALID")) {
            return "Wrong Password";
          }
          if (upper.includes("NOT FOUND") || upper.includes("DOES NOT EXIST")) {
            return "Banned";
          }
          if (upper.includes("IRREGULARITY") || upper.includes("SUSPICIOUS") || upper.includes("SECURITY")) {
            return "Irregularity";
          }
          return "Wrong Password";
        }),

      // CAPTCHA triggered
      page
        .locator(".captchafox, [class*='captcha' i]")
        .first()
        .waitFor({ state: "visible", timeout: config.timeouts.loginResult })
        .then(() => "CAPTCHA Blocked"),

      // Overall timeout
      new Promise((resolve) =>
        setTimeout(() => resolve("Error"), config.timeouts.loginResult + 2000)
      ),
    ]);

    account.status = result;
    console.log(`[${account.email}] => ${result}`);
    return result;
  } catch (error) {
    const msg = error.message || "";
    console.error(`[${account.email}] Error: ${msg}`);
    // Retry on navigation/proxy timeouts (slow proxy rotation)
    if (msg.includes("net::ERR_") || msg.includes("Timeout") || msg.includes("ABORTED")) {
      return "Retry";
    }
    account.status = "Error";
    return "Error";
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
