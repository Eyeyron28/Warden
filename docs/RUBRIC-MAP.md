# Rubric map (IAS 3rd Milestone)

This file maps each criterion of the IAS 3rd Milestone rubric to where it is in our code, the test that proves it, the document that
explains it, and the honest gap. We did not have the official rubric wording when we wrote this, so the criterion names and weights
are the ones we were given. Please check them against the official sheet before the defense.

We use file paths, not line numbers, because line numbers move. Test files are in `server/test/` unless the path says `client/`.
The older `docs/SCORING-AUDIT.md` has line numbers from 15 October 2026. Some of its gaps were closed later (see the notes below).

| Criterion | Weight |
|---|---|
| Input Validation | 15 |
| Authentication and MFA | 15 |
| Authorization and Access Control | 15 |
| Error Handling | 15 |
| Data Protection | 15 |
| Privacy Controls | 15 |
| Session and Account Security | 10 |

## 1. Input Validation (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| `server/server.js`: JSON body limit 100 KB, `express-mongo-sanitize` strips `$` and `.` keys from body, query and params. | `auth-email.test.js` and `invite.test.js` (operator objects as email or code), `otp.test.js`. | `docs/SCORING-AUDIT.md` section 3.1 (route table and the 25 hostile requests). | Validation is written by hand in each controller. There is no central validator. HTTP-level injection tests exist for sign-up, login, invite and OTP only, not for every owner route. |
| `server/routes/documents.routes.js`: multer memory storage, 4 MB cap per file. Names are cleaned in `server/utils/fileNames.js`. IDs are checked with `assertValidId` in `server/controllers/documents.controller.js`. | `filenames.test.js`, `trash.test.js`, `unique-names.test.js`. | `docs/QUARANTINE.md`, `docs/KNOWN-LIMITS.md`. | A name such as `../../etc/passwd` is stored as plain metadata. This is safe because files live in MongoDB as ciphertext, not on a disk path, but we state it. |
| **Files:** Warden accepts any file type up to 4 MB. We do not keep a list of allowed types. The real file type is sniffed from the bytes (`server/utils/sniff.js`). Risky files are held in Quarantine by simple rules (`server/utils/fileScanner.js`). A program in disguise and the standard test string are refused. | `file-scanner.test.js`, `quarantine.test.js`, `quarantine-emergency.test.js`. | `docs/QUARANTINE.md`. | The scanner is simple rules. It is not an antivirus. It catches little real malware. Files uploaded before the scanner existed were not scanned. |
| Upload limits: 10 files per upload dialog (client), 120 uploads per minute and 600 per hour per account, 2,000 documents per account. `server/utils/uploadLimits.js`. | `upload-limits.test.js`, `client/src/utils/uploadLimits.test.js`, `client/src/utils/uploadSelection.test.js`. | `docs/KNOWN-LIMITS.md` (Upload limits). | The document cap is checked just before encrypting. A few uploads in flight at the same moment can pass it by a small amount. |
| Zip import checks in the browser (path traversal, bombs, depth, nested zips): `client/src/utils/zipImport.js`. | `client/src/utils/zipImport.test.js`. | `docs/KNOWN-LIMITS.md` (Zip import). | Import is not atomic. Files already imported stay if it stops. |
| Router redirect guard: `client/src/utils/safeRedirect.js`. | `client/src/utils/safeRedirect.test.js`, `client/src/utils/router-advisory.test.js`. | `docs/KNOWN-LIMITS.md` (Dependency advisories). | Two moderate react-router advisories remain. We checked that the app is not exposed. The fix needs a major upgrade. |

## 2. Authentication and MFA (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| `server/utils/crypto.js`: password hashing with scrypt and a random salt. `server/utils/passwordPolicy.js`: minimum length 12. | `auth-email.test.js`, `signup-flow.test.js`. | `docs/SCORING-AUDIT.md` section 3.2. | No check against lists of leaked passwords [to confirm]. |
| Login code by email: `server/utils/otp.js`, `server/utils/otpChallenge.js`, `server/utils/otpConfig.js`. Six digits, 5 minute life, 5 guesses, 3 resends, 60 second gap, 5 code emails per hour per account. The code cannot be switched off in production. | `otp.test.js`, `deploy.test.js`, `code-emails.test.js`. | `docs/SCORING-AUDIT.md` section 3.2, `DEPLOY.md`. | The second factor is email only. There is no authenticator app or passkey (see `docs/FUTURE-WORK.md`). |
| Lockout after 3 failures in 5 minutes, then 5 minutes locked: `server/utils/loginLimiter.js`. Real and unknown addresses answer the same way. | `login-lockout.test.js`, `login-limiter.test.js`, `enumeration-timing.test.js`. | `docs/ROLES-AND-RATE-LIMITS.md`. | The lock is by address, so someone who knows an address can keep it locked by retrying. This is a trade-off against guessing. |
| Sign-up needs the emailed code first. No account exists until the code is right: `server/controllers/signup.controller.js`, `server/utils/signupCodes.js`. MX check, invite switch, anti-enumeration. | `signup-flow.test.js`, `invite.test.js`, `consent-mailcap.test.js`. | `DEPLOY.md`. | With `SIGNUP_MODE=open`, anyone can ask for sign-up codes. The daily mail cap limits the harm (see `docs/SCALABILITY-AND-GOVERNANCE.md`). |
| Trusted browsers for 30 days: `server/utils/trustedDevice.js`. | `trusted-devices.test.js`. | `docs/SCORING-AUDIT.md` section 3.2. | The cookie `Secure` flag is proven by a test, not by a live check of the deployed site [to confirm]. |
| Password reset by emailed code and recovery key: `server/controllers/passwordReset.controller.js`, `server/utils/accountReset.js`. | `password-reset.test.js`. | `docs/THREAT-MODEL.md`. | Losing both the password and the recovery key loses the vault. We say this on the privacy page. |

## 3. Authorization and Access Control (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| `server/middleware/requireSession.js` sets `req.userId` from the server-side session. Every owner query filters by `userId`. The client never sends a user id as authority. | `cross-user.test.js` calls every session-guarded route as another account and checks the first account's rows did not change. A route added without a plan fails the test. | `docs/ROLES-AND-RATE-LIMITS.md`, `docs/SCORING-AUDIT.md` section 3.3. | There is no admin role, on purpose. There is no per-file permission. |
| Emergency contact: read-only, 8 allowed routes, deny by default: `server/middleware/emergencyGuard.js`, `server/utils/emergency/`. | `emergency-allowlist.test.js`, `emergency-hardening.test.js`, `emergency-privacy.test.js`, `cross-user-tokens.test.js`. | `docs/DEMO-EMERGENCY.md`, `docs/THREAT-MODEL.md`. | Folder scope is server policy, not cryptography. A leaked database plus the printed kit opens the vault. |
| Share links with gates (email code, password, download limit, expiry): `server/controllers/sharedView.controller.js`, `server/utils/shareGate.js`. | `share-gates.test.js`, `shares.test.js`, `share-fragment.test.js`. | `docs/ROLES-AND-RATE-LIMITS.md`. | We have no named test for "a token for share A is refused on share B". The code binds it, but we did not cite a test for it. |
| Cron routes need `CRON_SECRET`: `server/routes/cron.routes.js`. | `deploy.test.js` ("cron route: absent without CRON_SECRET, 401 without the right bearer token" and the cron rate limit case). | `DEPLOY.md`. | None known. |

## 4. Error Handling (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| `server/middleware/errorHandler.js`: one JSON error shape. A 500 answer has a fixed message and a request id, never a stack, address or connection string. Only a short list of error codes is sent to the client. | `error-handler.test.js`, `session-error.test.js`. | `docs/SCORING-AUDIT.md` section 3.1. | We forced a fault to see a 500. Our 25 hostile requests did not cause a natural one. |
| Logs without secrets: `server/utils/logSafe.js`, `server/utils/securityLog.js`. Security events (lockout, wrong code bursts, 429, held file, mail cap, document limit) are one JSON line each with a short keyed hash. | `log-privacy.test.js`, `security-log.test.js`. | `DEPLOY.md` (Security events in the log). | Vercel keeps logs for a limited time [to confirm the plan limit]. |
| Production start-up refuses bad config and names only the variables: `server/utils/productionConfig.js`. | `deploy.test.js`. | `DEPLOY.md`. | None known. |
| Client: error boundary and a clear message for 401, 413, 429 and limit errors. | `client/src/utils/uploadLimits.test.js`, `client/src/utils/upload-dialogs.test.js`. | `docs/KNOWN-LIMITS.md`. | Manual checks were done in Chrome only. |

## 5. Data Protection (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| Files are encrypted with AES-256-GCM, a random 12 byte IV each time, the tag is checked on decrypt: `server/utils/crypto.js`. One random 32 byte vault key per account, stored only wrapped. | No single crypto test file. Round trips of encrypted files, keys and notes are covered inside `account.test.js`, `otp.test.js`, `password-reset.test.js`, `shares.test.js`, `trash.test.js` and `notes-versions.test.js`. [to confirm: a direct unit test of `crypto.js`] | `docs/PRIVACY-AND-DPA.md`, `docs/THREAT-MODEL.md`. | **Warden is not end-to-end.** The server encrypts and decrypts, so it sees file content while it works. It can read file names, folder names, dates and sizes. |
| Key wrapping under scrypt keys from the password and from the recovery key. A session holds the vault key only wrapped under half of the bearer token: `server/utils/sessionStore.js`. | `session-parallel.test.js`, `session-lifetime.test.js`. | `docs/DESIGN-JUSTIFICATION.md`. | A running, compromised server can read what a signed-in user opens. |
| Headers and CSP in `vercel.json` and helmet in `server/server.js`. | `deploy.test.js` ("vercel.json: cache rules, headers and the CSP script hash match the real page"). | `DEPLOY.md`. | HSTS on the HTML host was not verified on the live site [to confirm]. |
| Activity log chained with HMAC: `server/utils/audit.js`, `server/utils/auditConfig.js`. | `audit-limits.test.js`, `devices-audit.test.js`. | `docs/THREAT-MODEL.md`. | It detects edits and gaps. It cannot detect the removal of the newest events by someone who can write to the database. |
| Secrets are never in the repo. `.env` is ignored by git. | Secret scans are described in `docs/SCORING-AUDIT.md` section 3.4. | `DEPLOY.md`. | The scan was run on 15 October. We did not repeat it for this document. |

## 6. Privacy Controls (15)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| Consent at sign-up with the policy version, stored on the user as `consent.acceptedAt` and `consent.policyVersion`: `server/controllers/signup.controller.js`, `server/utils/policyVersion.js`, `server/models/User.js`. | `consent-mailcap.test.js`, `signup-flow.test.js`. | `docs/PRIVACY-AND-DPA.md`. | Accounts made before consent was recorded have no `consent` field. |
| Privacy and Terms pages: `client/src/pages/public/PrivacyPage.jsx`, `TermsPage.jsx`. They list what we collect, who can read what, retention, rights and the right to complain to the National Privacy Commission. | `client/src/utils/privacy.test.js`, `client/src/utils/resetPrivacy.test.js`. | `docs/PRIVACY-AND-DPA.md`. | The page says it is a draft and not a reviewed legal document. We have no named data protection officer [to confirm]. |
| Export your files as a zip, built in the browser: `client/src/utils/zipExport.js`. Delete your account: `server/controllers/account.controller.js`, `server/utils/accountDeletion.js`. | `account.test.js`, `client/src/utils/zipExport.test.js`. | `docs/PRIVACY-AND-DPA.md`. | Export leaves out held files, private notes and old versions. The export zip is not encrypted. IP-keyed rate-limit rows are not removed on deletion; they expire by themselves. |
| Retention: activity events 30 days, Trash 30 days, old file versions 30 days, sessions 30 minutes idle. | `trash.test.js`, `audit-limits.test.js`, `notes-versions.test.js`. | `docs/PRIVACY-AND-DPA.md`. | None known. |

## 7. Session and Account Security (10)

| Where in the code | Test that proves it | Doc | Honest gap |
|---|---|---|---|
| Sessions stored in MongoDB: `server/models/Session.js`, `server/utils/sessionStore.js`. 30 minute idle, 12 hour absolute (`SESSION_ABSOLUTE_HOURS`). Logout deletes the row. | `session-parallel.test.js`, `session-lifetime.test.js`, `session-error.test.js`. | `docs/DESIGN-JUSTIFICATION.md`. | The bearer token lives in `sessionStorage`, so injected script could read it. We use a strict CSP and no third-party scripts to reduce that risk. |
| Only `createSession` makes a session, and only login and Emergency Access call it. | `emergency-allowlist.test.js` (test name: "nothing but createSession makes a session..."). | `docs/THREAT-MODEL.md`. | None known. |
| Devices and activity page, sign out other devices, trusted browser list: `server/controllers/security.controller.js`. | `devices-audit.test.js`, `trusted-devices.test.js`. | `docs/DEMO-SCRIPT.md`. | Device names come from the user agent and are only a label. |
| Account deletion needs the password, an emailed code and the typed email. Password reset ends all sessions and trusted browsers. | `account.test.js`, `password-reset.test.js`. | `docs/PRIVACY-AND-DPA.md`. | None known. |

## Things in the audit that are now out of date

`docs/SCORING-AUDIT.md` was written on 15 October 2026. Since then:

- Consent and the policy version are now stored on new accounts. The audit listed this as a gap.
- The privacy page now has the right to complain to the National Privacy Commission, withdrawing consent and data portability.
- There is a daily mail cap (`MAIL_DAILY_CAP`, default 300) that the audit listed as missing.
- Lockouts, wrong code bursts and 429 answers are now written to the security log. The audit listed this as missing.
- ESLint is set up in `client` and `server`. The audit said there was none.
- Quarantine, the transfer tray and the upload limits were added.
