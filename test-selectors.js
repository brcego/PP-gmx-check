import { promises as fs } from "node:fs";

const configData = await fs.readFile("config.json", "utf-8");
const config = JSON.parse(configData);

const email = "Milagro.Melchio@gmx.com";
const password = "84493962z256Z";
console.log(`Test account: ${email}`);

const { chromium } = await import("playwright-extra");
const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
chromium.use(StealthPlugin());

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  proxy: config.proxy.server
    ? { server: config.proxy.server, username: config.proxy.username, password: config.proxy.password }
    : undefined,
});

const page = await context.newPage();
await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf}", (route) => route.abort());

// Check IP
console.log("\n--- Checking IP ---");
try {
  await page.goto("https://httpbin.org/ip", { timeout: 15000 });
  const ipText = await page.locator("body").textContent();
  console.log(`Current IP: ${ipText.trim()}`);
} catch (e) {
  console.log(`IP check failed: ${e.message}`);
}

console.log("\n--- Navigating to gmx.com ---");
page.goto("https://www.gmx.com/", { timeout: 60000 }).catch(() => {});

// Handle consent (poll frames)
console.log("Waiting for consent or login button...");
const found = await Promise.any([
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

if (found === "onetrust") {
  console.log("Consent found, clicking...");
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

console.log("Clicking login button...");
await page.locator("#login-button").click({ timeout: 10000 });

await page.locator("#login-email").waitFor({ state: "visible", timeout: 5000 });
await page.locator("#login-email").fill(email);
await page.locator("#login-password").fill(password);

console.log("Submitting login...");
await page.locator("button.login-submit").click();

console.log("Waiting for mail dashboard to load...");
await page.waitForTimeout(15000);
console.log(`URL: ${page.url()}`);

console.log("\n>>> PAUSED — Tell me which element confirms account is active.\n");
await new Promise(() => {});
