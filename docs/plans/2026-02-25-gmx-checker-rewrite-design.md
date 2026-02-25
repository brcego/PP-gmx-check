# GMX Account Checker — Rewrite Design

**Date:** 2026-02-25
**Status:** Approved

## Goal

Rewrite the GMX account keep-alive checker to use Playwright + stealth plugin instead of GoLogin + Puppeteer. Process ~500 GMX accounts (scaling to 1,000+) with configurable concurrency and rotating proxy support. Must run on both Windows Server and macOS.

## Architecture

Single-file Node.js script with an external config file.

```
PP-gmx-check/
├── config.json          # Proxy, concurrency, timeouts
├── accounts.csv         # Input/output: email,password,status
├── check-gmx.js         # Main script (complete rewrite)
├── package.json         # playwright-extra, stealth, playwright
└── node_modules/
```

### Dependencies

- `playwright-extra` — Playwright with plugin support
- `puppeteer-extra-plugin-stealth` — stealth plugin (compatible with playwright-extra)
- `playwright` — browser engine (Chromium)

### Config (`config.json`)

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

## Login Flow (per account)

1. Create fresh browser context with proxy and clean cookies
2. Set consent bypass cookie (`euconsent-bypass=1` on `.gmx.com`)
3. Navigate to `https://www.gmx.com/`
4. Click login button to reveal login form
5. Handle potential iframe from `auth.gmx.net`
6. Fill email + password, submit form
7. Detect outcome via `Promise.race`:
   - **Success**: URL contains `navigator-bs.gmx.com`
   - **Banned/Deleted**: Error page text
   - **CAPTCHA**: `.captchafox` div present
   - **Irregularity**: Security warning page
   - **Timeout**: No indicator within 20s
8. Update CSV status immediately
9. Close browser context (implicit logout)

## Status Values

| Status | Meaning |
|--------|---------|
| `Account Active` | Successful login |
| `Banned` | Account deleted/suspended |
| `CAPTCHA Blocked` | CAPTCHAFox triggered |
| `Irregularity` | Security warning detected |
| `Error` | Script error during processing |
| `Wrong Password` | Credential rejection |

## Concurrency Model

- One shared Chromium browser instance
- N isolated browser contexts in parallel (N from config, default 3)
- Worker pool pattern: maintain N active workers, grab next account when one finishes
- Each context: own cookies, own proxy session (rotating proxy gives fresh IP)

## Resumability

- On startup, skip accounts with status `Account Active`
- To force full recheck: clear the status column in CSV

## Error Handling

- Single account error: log, mark `Error`, continue
- Browser crash: reconnect, resume (CSV already saved after each account)
- Proxy failure: retry once with 10s delay, then mark `Error`
- Wrong password: mark immediately, no retry

## Cross-Platform

- Playwright manages its own Chromium — identical on Windows and macOS
- Setup: `npm install && npx playwright install chromium`
- Run: `node check-gmx.js`

## GMX Technical Notes

- Login form is in page header behind `.login-layer` toggle
- Auth may use cross-origin iframe from `auth.gmx.net`
- Cookie consent uses TCF v2; bypassed with `euconsent-bypass=1` cookie
- CAPTCHAFox (replaced reCAPTCHA) may trigger under suspicious conditions
- Successful login redirects to `navigator-bs.gmx.com`

## What Gets Removed

- `gologin` dependency and all GoLogin API code
- `puppeteer-core` and `puppeteer` dependencies
- `template_script.js` (unrelated Reddit template)
- Existing `check-gmx.js` is fully replaced
