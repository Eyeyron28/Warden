# Test evidence

This file says how to run every test and check script, what each one proves, and what we could not verify on the live site.

## Counts at the last full run

| Suite | Result | Command |
|---|---|---|
| Server tests | **549 passed, 0 failed, 0 skipped** | `cd server && npm test` |
| Client tests | **594 passed, 0 failed** | `cd client && npm test` |
| Main client bundle | 122.12 KB gzip (376.00 KB raw) | `cd client && npm run build` |

These were the numbers from the last full run, done alone, with a local throwaway MongoDB running. The counts change when
tests are added. Run the commands again to get the current totals. We did not re-run the suites while writing this document,
because the server suite needs a local MongoDB and this was a docs-only task.

Lint: `cd client && npm run lint` and `cd server && npm run lint` (ESLint, recommended rules only). They report no errors. The server
has some old warnings (unused variables) that we left alone on purpose (see `docs/KNOWN-LIMITS.md`).

## What the tests need

Most server tests use in-memory fakes. Some need a **real MongoDB**, because fakes cannot show parallel requests on one counter or
the whole app answering real HTTP as two accounts. They use a **local throwaway MongoDB only**, at `mongodb://127.0.0.1:27099/` as a
replica set, or the address in `WARDEN_TEST_MONGO` (it must be 127.0.0.1 or localhost; anything else is refused). Each test file
makes and drops its own database. Mail is captured and never sent. No `.env` file is read, and Atlas is never contacted. With no
local MongoDB, those tests are skipped with the reason, not failed (see `README.md` and `server/test/helpers/realMongo.js`).

The browser checks need a built client (`cd client && npm run build`) and Chrome or Edge (or Chromium found through
`PLAYWRIGHT_BROWSERS_PATH` or `PW_CHROMIUM_PATH`). They download nothing. They start their own copy of the real app on a local
throwaway MongoDB and serve the client with the production Content-Security-Policy from `vercel.json`, then check for CSP
violations.

## Server tests (`cd server && npm test`)

You can run one file with `node --test test/<file>.test.js` from `server`.

| Area | Files | What they prove |
|---|---|---|
| Authorization | `cross-user.test.js`, `cross-user-tokens.test.js` | Every session-guarded route, called as another account, changes nothing and leaks nothing. A new route without a plan fails the test. Emergency tokens are refused on owner-only routes. |
| Emergency Access | `emergency.test.js`, `emergency-allowlist.test.js`, `emergency-hardening.test.js`, `emergency-privacy.test.js` | The key split, the waiting period, owner denial, exactly 8 allowed routes, read-only sessions, scope limits, no leaks of names. Also that only `createSession` makes a session. |
| Sign-up and login | `signup-flow.test.js`, `auth-email.test.js`, `invite.test.js`, `otp.test.js`, `code-emails.test.js`, `login-lockout.test.js`, `login-limiter.test.js`, `enumeration-timing.test.js` | No account before the code, consent stored with the policy version, invite gate, code limits, lockout under parallel requests, same answer for real and unknown addresses. |
| Sessions and devices | `session-parallel.test.js`, `session-lifetime.test.js`, `session-error.test.js`, `trusted-devices.test.js`, `devices-audit.test.js` | Idle and absolute limits, parallel safety, trusted browser cookies, device list, the HMAC activity log. |
| Account | `account.test.js`, `password-reset.test.js` | Delete account removes everything, reset ends sessions, recovery key flows. |
| Errors and logs | `error-handler.test.js`, `log-privacy.test.js`, `security-log.test.js` | A 500 has a fixed message and a request id. Logs and security events hold no email, token, IP or file name. |
| Rate limits | `rate-limit-headroom.test.js`, `rate-limit-keys.test.js`, `upload-limits.test.js`, `consent-mailcap.test.js` | Pages do not use up each other's budgets, IP keying, upload speed limits and the document cap, the daily mail budget. |
| Quarantine | `file-scanner.test.js`, `quarantine.test.js`, `quarantine-emergency.test.js` | Rules and weights, blocked and held verdicts, 409 `QUARANTINED`, release needs RELEASE, held files stay out of lists and exports, zips only through Export / Import. |
| Files | `filenames.test.js`, `unique-names.test.js`, `trash.test.js`, `notes-versions.test.js`, `drive-basics.test.js`, `removed-and-previews.test.js` | Safe names, numbered duplicates, Trash and purge, notes and versions, starring and recent, removed features answering 410. |
| Sharing | `shares.test.js`, `share-gates.test.js`, `share-fragment.test.js` | Gates, limits, expiry, keys only in the link fragment. |
| Deployment | `deploy.test.js`, `public-app-url.test.js`, `index-coverage.test.js`, `perf-server.test.js` | Production config checks, `vercel.json` headers and CSP hash, cron protection, every declared index is built, the performance of key queries. |
| Mail and health | `email.test.js`, `email-templates.test.js`, `expiry-health.test.js`, `audit-limits.test.js` | Mail templates and sending, expiry reminders, the vault health score, the activity log limits. |

## Client tests (`cd client && npm test`)

Plain Node tests in `client/src/**/*.test.js`. They cover the zip import and export (`zipImport.test.js`, `zipExport.test.js`), the
transfer tray and its states (`transferTray.render.test.js`, `uploadLimits.test.js`, `upload-dialogs.test.js`,
`uploadSelection.test.js`), Quarantine screens (`quarantineUi.test.js`), tooltips (`tooltip.test.js`), share crypto and links
(`shareCrypto.test.js`, `shareLinks.test.js`, `sharePassword.test.js`), the redirect guard and router advisory
(`safeRedirect.test.js`, `router-advisory.test.js`), privacy text and version (`privacy.test.js`, `resetPrivacy.test.js`), and more.

## Browser check scripts (`cd client`, after `npm run build`)

| Command | What it checks |
|---|---|
| `npm run check:responsive` | Public and signed-in pages and dialogs at 360, 768, 1280 and 1366 px, light and dark (`THEME=dark`). Fails on sideways scrolling, overlapping fixed bars, or a dialog that does not fit. Also counts requests per page (Files 7, Overview 8 at the last run). |
| `npm run check:import` | The background zip import: progress in the tray, report, memory-only state, chosen zip kept across pages. |
| `npm run check:transfers` | The transfer tray: running, waiting, failed and retried rows, cancel, sign-out prompt. |
| `npm run check:quarantine` | Held and refused files, the Quarantine page, Release, status icon tooltips. |
| `npm run check:multiupload` | The Upload dialog with up to 10 files, per-file errors, drop zone. |
| `npm run check:tooltips` | Every icon-only control has an accessible name, and the shared tooltip behaves. |
| `npm run check:limits` | The upload speed limit and the document cap in a real browser, with small limits. |
| `npm run check:logout` | Sign-in and sign-out through the real login page. |
| `node scripts/check-scan.mjs` | The Scan dialog (camera to PDF). **Flaky:** in a final run it failed on 2 of 4 attempts, then passed. It reads the document list right after the row appears, so it can read too early. It is a timing problem in the script, not known to be an app bug. |
| `node scripts/check-upload.mjs` | A 4 MB PDF through the real Upload dialog. |

`check-scan.mjs` and `check-upload.mjs` have no npm script name. Run them with `node` from `client`.

## Other evidence

- `docs/SCORING-AUDIT.md`: a read-only audit on 15 October 2026 with route tables, the 25 hostile requests, the orphan check after
  account deletion, secret scans of the working tree and all 96 commits, and the performance numbers. Some of its gaps were closed
  later (see the end of `docs/RUBRIC-MAP.md`).
- An independent review on 10 October with no critical issue, no cross-user access found and 16 findings fixed was reported to us.
  We could not find a written report of it in the repo [to confirm]. The commit `d7543a6` ("fix: security review findings") is the
  fix commit we can point to.

## What we could not verify on the live site

We did not test any of these against the real deployment, and we did not run the app while writing this document:

- Vercel's real routing, headers and the 4.5 MB body limit as Vercel enforces it.
- HSTS and the `Secure` flag of the cookies on the live site. `vercel.json` does not set HSTS itself. The API sets it with helmet, and a
  test checks the cookie flag. [to confirm with `curl -I` on the live URL]
- Real cold start time on Vercel.
- Atlas M0 itself: connection counts, transactions, write speed, and the region.
- Real Gmail delivery. Codes may land in Spam for new senders (see `DEPLOY.md` 9d).
- Vercel Cron: whether both jobs ran on schedule in production.
- Any browser other than Chrome (and Edge for the scripts). We did not test Firefox or Safari.
- A load test. We did not do one.
- Phone browsers: checked only by narrow window sizes and touch emulation, not on real devices.
- A run that crosses the 12 hour session limit, and closing a real tab during an import.
