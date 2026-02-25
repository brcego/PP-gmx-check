# GMX Account Checker Rewrite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the GMX account keep-alive checker using Playwright + stealth plugin with configurable concurrency and rotating proxy support.

**Architecture:** Single Node.js script (`check-gmx.js`) with external config (`config.json`). Playwright launches one Chromium instance, creates N isolated browser contexts in parallel (worker pool), each with its own proxy session. CSV is read at start, updated after every account.

**Tech Stack:** Node.js (ESM), Playwright, playwright-extra, puppeteer-extra-plugin-stealth

---

### Task 1: Project Setup — Clean Dependencies

**Files:**
- Modify: `package.json`
- Create: `config.json`
- Delete: `template_script.js`

**Step 1: Remove old dependencies and install new ones**

Replace `package.json` with:

```json
{
  "name": "pp-gmx-check",
  "version": "2.0.0",
  "type": "module",
  "main": "check-gmx.js",
  "scripts": {
    "start": "node check-gmx.js",
    "test": "node --test test.js"
  },
  "dependencies": {
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2"
  }
}
```

Run:
```bash
rm -rf node_modules package-lock.json
npm install
npx playwright install chromium
```

Expected: Clean install with playwright-extra, stealth plugin, and Chromium browser downloaded.

**Step 2: Create config.json**

```json
{
  "proxy": {
    "server": "http://lb.proxyfog.com:8443",
    "username": "1003_UKprx",
    "password": "bekumedia5512"
  },
  "concurrency": 3,
  "accountsFile": "accounts.csv",
  "headless": true,
  "timeouts": {
    "navigation": 15000,
    "loginResult": 20000,
    "betweenAccounts": 3000
  }
}
```

**Step 3: Delete template_script.js**

```bash
rm template_script.js
```

**Step 4: Commit**

```bash
git init
git add package.json config.json
git commit -m "chore: replace GoLogin/Puppeteer deps with Playwright + stealth"
```

---

### Task 2: CSV Read/Write Utilities + Tests

**Files:**
- Create: `check-gmx.js` (initial skeleton with CSV functions only)
- Create: `test.js` (unit tests for CSV functions)

**Step 1: Write CSV utility tests**

Create `test.js`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readAccounts, writeAccounts } from "./check-gmx.js";

describe("readAccounts", () => {
  it("parses CSV with header row", async () => {
    const tmpFile = "test-accounts-read.csv";
    await fs.writeFile(tmpFile, "email,password,status\na@gmx.com,pass1,\nb@gmx.com,pass2,Active\n");
    const accounts = await readAccounts(tmpFile);
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].email, "a@gmx.com");
    assert.equal(accounts[0].password, "pass1");
    assert.equal(accounts[0].status, "");
    assert.equal(accounts[1].status, "Active");
    await fs.unlink(tmpFile);
  });

  it("returns empty array for missing file", async () => {
    const accounts = await readAccounts("nonexistent.csv");
    assert.equal(accounts.length, 0);
  });

  it("skips empty lines", async () => {
    const tmpFile = "test-accounts-empty.csv";
    await fs.writeFile(tmpFile, "email,password,status\na@gmx.com,pass1,\n\n\nb@gmx.com,pass2,\n");
    const accounts = await readAccounts(tmpFile);
    assert.equal(accounts.length, 2);
    await fs.unlink(tmpFile);
  });
});

describe("writeAccounts", () => {
  it("writes accounts back to CSV with header", async () => {
    const tmpFile = "test-accounts-write.csv";
    const accounts = [
      { email: "a@gmx.com", password: "pass1", status: "Account Active" },
      { email: "b@gmx.com", password: "pass2", status: "Banned" },
    ];
    await writeAccounts(tmpFile, accounts);
    const content = await fs.readFile(tmpFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    assert.equal(lines[0], "email,password,status");
    assert.equal(lines[1], "a@gmx.com,pass1,Account Active");
    assert.equal(lines[2], "b@gmx.com,pass2,Banned");
    await fs.unlink(tmpFile);
  });
});
```

**Step 2: Run tests — expect FAIL (module not found)**

```bash
node --test test.js
```

Expected: FAIL — `check-gmx.js` doesn't export readAccounts/writeAccounts yet.

**Step 3: Write CSV utilities in check-gmx.js**

Create `check-gmx.js` (initial skeleton):

```javascript
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
```

**Step 4: Run tests — expect PASS**

```bash
node --test test.js
```

Expected: All 4 tests pass.

**Step 5: Commit**

```bash
git add check-gmx.js test.js
git commit -m "feat: add CSV read/write utilities with tests"
```

---

### Task 3: Worker Pool + Tests

**Files:**
- Modify: `check-gmx.js` — add `runWithConcurrency` function
- Modify: `test.js` — add worker pool tests

**Step 1: Add worker pool test to test.js**

Append to `test.js`:

```javascript
import { runWithConcurrency } from "./check-gmx.js";

describe("runWithConcurrency", () => {
  it("processes all items with limited concurrency", async () => {
    const results = [];
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const items = [1, 2, 3, 4, 5];
    await runWithConcurrency(items, 2, async (item) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 50));
      results.push(item);
      currentConcurrent--;
    });

    assert.equal(results.length, 5);
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
  });

  it("handles empty array", async () => {
    let called = false;
    await runWithConcurrency([], 3, async () => { called = true; });
    assert.equal(called, false);
  });

  it("continues on individual item failure", async () => {
    const results = [];
    await runWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("fail");
      results.push(item);
    });
    assert.deepEqual(results, [1, 3]);
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
node --test test.js
```

Expected: New tests fail (runWithConcurrency not exported).

**Step 3: Add runWithConcurrency to check-gmx.js**

Add after the CSV utilities:

```javascript
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
```

**Step 4: Run tests — expect PASS**

```bash
node --test test.js
```

Expected: All tests pass (CSV + worker pool).

**Step 5: Commit**

```bash
git add check-gmx.js test.js
git commit -m "feat: add concurrent worker pool with tests"
```

---

### Task 4: Core Login Function — checkAccount()

**Files:**
- Modify: `check-gmx.js` — add `checkAccount` function

This is the main browser automation logic. It cannot be unit tested — it will be verified manually against real GMX in Task 6.

**Step 1: Add the checkAccount function to check-gmx.js**

Add after the worker pool:

```javascript
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
```

**Step 2: Verify existing tests still pass**

```bash
node --test test.js
```

Expected: All existing tests still pass (the new function isn't tested by unit tests).

**Step 3: Commit**

```bash
git add check-gmx.js
git commit -m "feat: add checkAccount browser automation function"
```

---

### Task 5: Main Orchestrator

**Files:**
- Modify: `check-gmx.js` — add main() function and entry point

**Step 1: Add the main orchestrator to check-gmx.js**

Add at the bottom of the file:

```javascript
// --- Main ---

async function main() {
  // Load config
  const configData = await fs.readFile("config.json", "utf-8");
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
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
```

**Step 2: Verify tests still pass**

```bash
node --test test.js
```

Expected: All tests still pass. The `if (isDirectRun)` guard prevents main() from executing during test imports.

**Step 3: Commit**

```bash
git add check-gmx.js
git commit -m "feat: add main orchestrator with resumability and progress"
```

---

### Task 6: Live Smoke Test & Selector Tuning

**Files:**
- Modify: `check-gmx.js` — adjust selectors as needed based on live testing

This task requires manual interaction. Run the script in headed mode against 1-2 real accounts to verify the login flow works and tune selectors.

**Step 1: Create a test CSV with 1-2 accounts**

```bash
head -3 accounts.csv > test-accounts.csv
```

**Step 2: Create a test config**

Create `config.test.json`:
```json
{
  "proxy": {
    "server": "http://lb.proxyfog.com:8443",
    "username": "1003_UKprx",
    "password": "bekumedia5512"
  },
  "concurrency": 1,
  "accountsFile": "test-accounts.csv",
  "headless": false,
  "timeouts": {
    "navigation": 30000,
    "loginResult": 30000,
    "betweenAccounts": 5000
  }
}
```

**Step 3: Temporarily modify main() to accept a config path argument**

Update the `isDirectRun` block at the bottom:

```javascript
if (isDirectRun) {
  const configPath = process.argv[2] || "config.json";
  main(configPath).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
```

And update `main()` signature to accept the config path:

```javascript
async function main(configPath = "config.json") {
  const configData = await fs.readFile(configPath, "utf-8");
  // ... rest unchanged
```

**Step 4: Run in headed mode and observe**

```bash
node check-gmx.js config.test.json
```

Watch the browser. Check:
- Does the consent popup get bypassed?
- Does the login layer open?
- Are the email/password fields found (in main page or iframe)?
- Does the form submit?
- Is the success/failure detected correctly?

**Step 5: Adjust selectors based on what you see**

Common adjustments needed:
- The login button selector may need updating based on actual class/id
- The email/password input selectors may need iframe handling adjustments
- The error text matching may need additional patterns

After each adjustment, re-run `node check-gmx.js config.test.json` and verify.

**Step 6: Clean up test files and commit**

```bash
rm test-accounts.csv config.test.json
git add check-gmx.js
git commit -m "fix: tune GMX selectors based on live testing"
```

---

### Task 7: Final Cleanup & Verification

**Files:**
- Modify: `check-gmx.js` — any final polish
- Delete: `accounts 2.csv` (duplicate file)

**Step 1: Run unit tests one final time**

```bash
node --test test.js
```

Expected: All pass.

**Step 2: Run a quick headless test with proxy against 2-3 accounts**

```bash
# Edit config.json to set concurrency: 1, then:
node check-gmx.js
# Ctrl+C after 2-3 accounts to verify it works headless with proxy
```

**Step 3: Verify CSV was updated correctly**

```bash
head -5 accounts.csv
```

Expected: First few accounts should have status values.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: GMX account checker v2.0 — Playwright + stealth rewrite"
```

---

## Selector Discovery Reference

The login flow selectors are educated guesses from research. During Task 6, use these Playwright debugging techniques:

```javascript
// Take a screenshot at any point
await page.screenshot({ path: "debug.png", fullPage: true });

// Log all visible text on page
const text = await page.locator("body").textContent();
console.log(text.slice(0, 2000));

// List all iframes
for (const frame of page.frames()) {
  console.log("Frame:", frame.url());
}

// Find all input fields on page + all frames
for (const frame of page.frames()) {
  const inputs = await frame.locator("input").all();
  for (const input of inputs) {
    const type = await input.getAttribute("type");
    const name = await input.getAttribute("name");
    const placeholder = await input.getAttribute("placeholder");
    console.log(`Input: type=${type} name=${name} placeholder=${placeholder} frame=${frame.url()}`);
  }
}
```

## Full Dependency Summary

| Package | Purpose |
|---------|---------|
| `playwright-extra` | Playwright with plugin support |
| `puppeteer-extra-plugin-stealth` | Anti-detection evasion |
| `playwright` (auto-installed) | Browser engine |
