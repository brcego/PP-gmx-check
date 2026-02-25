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

  // Block images/fonts to save proxy bandwidth
  await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf}", (route) =>
    route.abort()
  );

  try {
    // Navigate to GMX — don't wait for load, start watching for elements immediately
    console.log(`[${account.email}] Navigating to gmx.com...`);
    page.goto("https://www.gmx.com/", { timeout: 60000 }).catch(() => {});

    // Wait for login button or consent page (button may be in an iframe)
    let found;
    try {
      found = await Promise.any([
        page.locator("#login-button")
          .waitFor({ state: "visible", timeout: 30000 })
          .then(() => "login"),
        // Poll all frames for the onetrust accept button
        new Promise((resolve, reject) => {
          let done = false;
          const interval = setInterval(async () => {
            if (done) return;
            for (const frame of page.frames()) {
              try {
                const btn = frame.locator("#onetrust-accept-btn-handler");
                if (await btn.count() > 0 && await btn.isVisible()) {
                  done = true;
                  clearInterval(interval);
                  resolve("onetrust");
                  return;
                }
              } catch {}
            }
          }, 500);
          setTimeout(() => { clearInterval(interval); if (!done) reject(new Error("timeout")); }, 30000);
        }),
      ]);
    } catch {
      console.log(`[${account.email}] Page slow, reloading...`);
      page.reload({ timeout: 60000 }).catch(() => {});
      try {
        found = await Promise.any([
          page.locator("#login-button")
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => "login"),
          new Promise((resolve, reject) => {
            let done = false;
            const interval = setInterval(async () => {
              if (done) return;
              for (const frame of page.frames()) {
                try {
                  const btn = frame.locator("#onetrust-accept-btn-handler");
                  if (await btn.count() > 0 && await btn.isVisible()) {
                    done = true;
                    clearInterval(interval);
                    resolve("onetrust");
                    return;
                  }
                } catch {}
              }
            }, 500);
            setTimeout(() => { clearInterval(interval); if (!done) reject(new Error("timeout")); }, 30000);
          }),
        ]);
      } catch {
        throw new Error("Timeout: page failed to load after retry");
      }
    }

    if (found === "onetrust") {
      console.log(`[${account.email}] Consent found, clicking accept...`);
      // Click in whichever frame has it
      for (const frame of page.frames()) {
        try {
          const btn = frame.locator("#onetrust-accept-btn-handler");
          if (await btn.count() > 0 && await btn.isVisible()) {
            await btn.click();
            break;
          }
        } catch {}
      }
      await page.locator("#login-button").waitFor({ state: "visible", timeout: 30000 });
    }

    // Click login button to open login form
    console.log(`[${account.email}] Opening login form...`);
    await page.locator("#login-button").click({ timeout: 10000 });

    // Fill credentials
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 5000 });
    console.log(`[${account.email}] Entering credentials...`);
    await page.locator("#login-email").fill(account.email);
    await page.locator("#login-password").fill(account.password);

    // Submit
    await page.locator("button.login-submit").click();
    console.log(`[${account.email}] Submitted login...`);

    // Detect outcome by page content (not URL)
    const result = await Promise.race([
      // Account Active: mail dashboard nav appears
      page.locator("#actions-menu-primary")
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "Account Active"),

      // Deleted: "invalid email address" text appears
      page.getByText("invalid email address", { exact: false })
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "Deleted"),

      // Timeout: neither detected in 30s
      new Promise((resolve) => setTimeout(() => resolve("Unknown"), 30000)),
    ]);

    account.status = result;
    console.log(`[${account.email}] => ${result}`);
    // Brief delay before closing to let page settle
    await page.waitForTimeout(3000);
    return result;
  } catch (error) {
    const msg = error.message || "";
    console.error(`[${account.email}] Error: ${msg}`);
    if (msg.includes("net::ERR_") || msg.includes("Timeout") || msg.includes("ABORTED")) {
      return "Retry";
    }
    account.status = "Error";
    return "Error";
  } finally {
    await context.close();
  }
}

// --- Proxy Rotation ---

async function rotateProxy(rotateUrl, browser, config) {
  console.log("Rotating proxy IP...");
  try {
    const res = await fetch(rotateUrl);
    const text = await res.text();
    console.log(`Rotate response: ${text.trim()}`);
  } catch (err) {
    console.log(`Rotate request sent (${err.message})`);
  }

  // Wait for proxy to come back online — check IP through the proxy via browser
  console.log("Waiting for proxy to come back online...");
  await new Promise((r) => setTimeout(r, 5000)); // initial wait for rotation

  for (let i = 0; i < 20; i++) {
    const ctx = await browser.newContext({
      proxy: config.proxy.server
        ? { server: config.proxy.server, username: config.proxy.username, password: config.proxy.password }
        : undefined,
    });
    try {
      const pg = await ctx.newPage();
      await pg.goto("https://httpbin.org/ip", { timeout: 10000 });
      const body = await pg.locator("body").textContent();
      const ip = JSON.parse(body).origin;
      console.log(`Proxy online — IP: ${ip}`);
      await fs.appendFile("IPs.txt", `${new Date().toISOString()} — ${ip}\n`);
      await ctx.close();
      return;
    } catch {
      await ctx.close();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log("Warning: proxy may not be ready, continuing anyway...");
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
  const doneStatuses = ["Account Active", "Deleted"];
  const toCheck = accounts.filter((a) => !doneStatuses.includes(a.status));
  const skipped = accounts.length - toCheck.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} accounts already marked as Active/Deleted.`);
  }
  console.log(`Checking ${toCheck.length} accounts...\n`);

  if (toCheck.length === 0) {
    console.log("All accounts already processed. Nothing to do.");
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
    const batchSize = config.concurrency;

    // Process in batches — rotate IP between each batch
    for (let i = 0; i < toCheck.length; i += batchSize) {
      // Rotate proxy before each batch (except the first)
      if (i > 0 && config.rotateUrl) {
        await rotateProxy(config.rotateUrl, browser, config);
      }

      const batch = toCheck.slice(i, i + batchSize);
      console.log(`\n--- Batch ${Math.floor(i / batchSize) + 1}: ${batch.map(a => a.email).join(", ")} ---`);

      // Process batch concurrently
      await Promise.all(batch.map(async (account) => {
        await checkAccount(browser, account, config);
        processed++;
        await writeAccounts(config.accountsFile, accounts);
        console.log(`  Progress: ${processed}/${toCheck.length}`);
      }));
    }

    // Final summary
    const active = accounts.filter((a) => a.status === "Account Active").length;
    const deleted = accounts.filter((a) => a.status === "Deleted").length;
    const unknown = accounts.filter((a) => a.status === "Unknown").length;
    const errors = accounts.filter((a) => a.status === "Error").length;

    console.log("\n=== DONE ===");
    console.log(`Active: ${active}`);
    console.log(`Deleted: ${deleted}`);
    console.log(`Unknown: ${unknown}`);
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
