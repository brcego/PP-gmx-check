# GMX Account Checker v2.0

Bulk GMX email account checker using Playwright with stealth plugin and proxy rotation.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node check-gmx.js
node check-gmx.js config.test.json  # custom config
```

## How It Works

1. Reads accounts from `accounts.csv` (email, password, status)
2. Launches Chromium with stealth plugin (anti-detection)
3. Processes accounts in **batches** (concurrency size per batch)
4. For each account:
   - Navigates to gmx.com (fires navigation, doesn't wait for full load)
   - Handles OneTrust consent banner if present (polls all iframes to find the button)
   - Clicks `#login-button`, fills `#login-email` + `#login-password`, submits via `button.login-submit`
   - Detects outcome by **page content** (not URL):
     - `#actions-menu-primary` visible → **Account Active**
     - "invalid email address" text visible → **Deleted**
     - Neither detected within 30s → **Unknown**
   - 3s delay after detection before closing context
5. After each batch completes:
   - Hits the `rotateUrl` API to change proxy IP
   - Waits 5s initial, then verifies new IP **through the proxy** via browser
   - Logs new IP with timestamp to `IPs.txt`
6. Saves results to CSV after every account (resumable)

## Resumability

Re-running skips accounts already marked as `Account Active` or `Deleted`. Accounts with `Unknown` or `Error` are retried.

## Config

`config.json`:

```json
{
  "proxy": {
    "server": "http://host:port",
    "username": "user",
    "password": "pass"
  },
  "rotateUrl": "https://your-provider/changeip/...",
  "concurrency": 3,
  "accountsFile": "accounts.csv",
  "headless": false,
  "maxRetries": 2,
  "timeouts": {
    "navigation": 60000,
    "loginResult": 30000,
    "betweenAccounts": 3000
  }
}
```

| Option | Description |
|--------|-------------|
| `proxy.server` | HTTP proxy address |
| `proxy.username/password` | Proxy auth credentials |
| `rotateUrl` | GET endpoint to rotate proxy IP between batches |
| `concurrency` | Accounts per batch (processed simultaneously) |
| `headless` | `true` for background, `false` to watch browsers |
| `maxRetries` | Retries per account on timeout/proxy failure |

## Accounts CSV

```
email,password,status
user@gmx.com,password123,
Another@gmx.com,pass456,Account Active
```

Leave status empty for unchecked accounts.

## Statuses

| Status | Meaning |
|--------|---------|
| `Account Active` | Login succeeded, mail inbox loaded |
| `Deleted` | "Invalid email address" error — account doesn't exist |
| `Unknown` | Neither detected within 30s — retried on next run |
| `Error` | Navigation/proxy failure after max retries |

## Output Files

| File | Purpose |
|------|---------|
| `accounts.csv` | Updated with statuses after each account |
| `IPs.txt` | Timestamped log of proxy IPs after each rotation |

## Proxy Notes

- IP rotates between each batch via the `rotateUrl` API
- New IP is verified through the proxy before starting next batch
- Images and fonts are blocked to save proxy bandwidth
- On proxy timeout/failure: context is killed and account is retried

## Tests

```bash
npm test
```

## Files

| File | Purpose |
|------|---------|
| `check-gmx.js` | Main script — CSV utils, browser automation, batch orchestrator |
| `test.js` | Unit tests (node:test) |
| `config.json` | Runtime config |
| `accounts.csv` | Input/output accounts file |
| `test-selectors.js` | Dev helper for testing selectors |
