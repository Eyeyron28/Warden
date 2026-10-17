# Roles and rate limits

## Why there is no admin role

Warden has no `role` field and no admin account. We did this on purpose.

- An admin who can see or fix every account is also a target. If an attacker gets that account, they get everything we can reach.
- The server cannot read file contents without a user's session or an Emergency Kit. An admin role would have nothing safe to
  show, and a "reset this user's vault" button would be a back door.
- Access is decided by **the situation of the caller**: who holds a session, a share link, an Emergency Kit, or nothing.
- Every owner query adds `userId: req.userId` from the server-side session. The client never sends a user id that the server
  trusts. `server/test/cross-user.test.js` proves this by calling every session-guarded route as a second account.

The cost: nobody can recover a vault for a user who lost both the password and the recovery key. We say this on the privacy page.
Also, nobody can look inside an account to help with a problem. A "totals-only admin page" is listed in `docs/FUTURE-WORK.md` and is
not built.

## Role matrix, by situation

| Situation | How the server knows | What it can do |
|---|---|---|
| **Owner** | A valid session (`server/middleware/requireSession.js`) | Everything on their own account: files, folders, Trash, shares, devices, activity, Emergency setup, account deletion. Nothing on other accounts. |
| **Emergency contact** | An emergency session, after the kit, an emailed code and the waiting period (`server/middleware/emergencyGuard.js`) | Read-only. Only 8 allowed routes: check the session, log out, list files and folders inside the chosen scope, view and download inside that scope, and read the session info. Everything else is refused (403 `EMERGENCY_READ_ONLY`, or 404 for things outside the scope and for held files). The session lasts 4 hours at most. |
| **Share-link viewer** | The share id and key in the link, plus the gates the owner chose (`server/controllers/sharedView.controller.js`) | Open only that share's copies while it is live and under the download limit. If the owner set an email gate, a code sent to that one address is needed. If they set a password, the password is needed. |
| **Public** | Nothing | Sign up, log in, reset password, read the public pages, the emergency contact entry steps (every answer is neutral), `GET /api/health`, `GET /api/auth/config`. Each of these is behind a limiter except the two read-only ones. |
| **System (cron)** | `Authorization: Bearer <CRON_SECRET>` | Run the Trash purge and the reminders. Without `CRON_SECRET` the routes do not exist (404). |

### Which routes each situation reaches

| Group of routes | Owner | Emergency contact | Share viewer | Public |
|---|---|---|---|---|
| `/api/auth/*` sign-up, login, reset | n/a | n/a | n/a | yes, limited |
| `/api/auth/me`, `/api/auth/logout` | yes | yes (allowed) | no | no |
| `/api/documents` list, folders, view, thumbnail | own | only inside the scope, read-only | no | no |
| `/api/documents` upload, rename, move, delete | own | no | no | no |
| `/api/quarantine` and release | own | no | no | no |
| `/api/trash`, `/api/insights`, `/api/account`, `/api/security` | own | no | no | no |
| `/api/shares` (manage links) | own | no | no | no |
| `/api/shared/:id` (open a link) | n/a | n/a | yes, after the gates | only with the link |
| `/api/emergency/*` owner setup | own | no | no | no |
| `/api/emergency/public/*` | n/a | yes, kit and code | n/a | yes, neutral answers |
| `/api/cron/*` | no | no | no | no (system only) |

The full per-route proof is in `server/test/cross-user.test.js` and `server/test/emergency-allowlist.test.js`. The longer matrix is
in `docs/SCORING-AUDIT.md` section 3.3.

## Rate limiters

All counters live in MongoDB (the `RateLimit` model, `server/middleware/rateLimit.js`), not in memory, so every serverless instance
sees the same count. Each counter is one atomic update. A TTL index removes old counters. The IP key is made by one helper
(`server/utils/clientIp.js`) that counts an IPv6 address by its first 64 bits.

When a request is refused with 429, the server writes one security log line with the limiter's name and a short keyed hash. It does
not write the address, token or any file name.

The "Where" column gives a file, not a line number. Names in the "Bucket" column are the real `name` values in the code.

| Bucket | Route or action | Key | Limit | Window | Where |
|---|---|---|---|---|---|
| `signup-ip` | `POST /api/auth/signup/start` | IP | 10 | 1 hour | `server/routes/auth.routes.js` |
| `signup-email` | `POST /api/auth/signup/start` | email | 5 | 1 hour | `server/routes/auth.routes.js` |
| `signup-code-address` | sign-up code emails (start and resend) | address | 5 | 1 hour | `server/controllers/signup.controller.js` |
| `signup-verify-ip` | `POST /api/auth/signup/verify` | IP | 30 | 15 minutes | `server/routes/auth.routes.js` |
| `signup-resend-ip` | `POST /api/auth/signup/resend` | IP | 10 | 1 hour | `server/routes/auth.routes.js` |
| `signup-resend-email` | `POST /api/auth/signup/resend` | email | 1 | 1 minute | `server/routes/auth.routes.js` |
| `verify-email` | `POST /api/auth/verify-email` | IP | 20 | 1 hour | `server/routes/auth.routes.js` |
| `resend-verification-ip` | `POST /api/auth/resend-verification` | IP | 10 | 1 hour | `server/routes/auth.routes.js` |
| `resend-verification-email` | `POST /api/auth/resend-verification` | email | 1 | 1 minute | `server/routes/auth.routes.js` |
| `login` | `POST /api/auth/unlock`, `/verify-otp`, `/resend-otp` | IP | 20 | 15 minutes | `server/routes/auth.routes.js` |
| login failures | wrong password | keyed hash of the address | 3, then locked 5 minutes | 5 minutes | `server/utils/loginLimiter.js` |
| login code | guesses per code, resends, code emails | challenge, challenge, account | 5 guesses, 3 resends (60 s gap), 5 emails per hour | per code, per hour | `server/utils/otpChallenge.js` |
| `password-reset-ip` | `POST /api/auth/password-reset/start` | IP | 10 | 1 hour | `server/routes/auth.routes.js` |
| `password-reset-email` | `POST /api/auth/password-reset/start` | email | 5 | 1 hour | `server/routes/auth.routes.js` |
| `password-reset-code-ip` | `/password-reset/resend`, `/verify` | IP | 20 | 15 minutes | `server/routes/auth.routes.js` |
| `password-reset-ticket-ip` | `/password-reset/with-recovery-key`, `/start-over` | IP | 20 | 15 minutes | `server/routes/auth.routes.js` |
| `rk-ip-1h`, `rk-gap-10s`, `rk-gap-2m`, `rk-gap-10m`, `rk-fail-1h` | `POST /password-reset/recovery-key-only` | IP, then email | 10 per hour per IP; 1 per 10 s, 2 per 2 min, 3 per 10 min, 5 per hour per email | as listed | `server/controllers/passwordReset.controller.js` |
| `invite-fail-15m`, `invite-fail-1h` | wrong invite code at sign-up (failures only) | IP | 5; 20 | 15 minutes; 1 hour | `server/utils/inviteGate.js` |
| `account-ip` | delete-account steps, trusted browser removal | IP | 20 | 1 hour | `server/routes/account.routes.js` |
| `account-user` | the same routes | account | 10 | 1 hour | `server/routes/account.routes.js` |
| `security-user` | devices, activity, verify log | account | 300 | 1 hour | `server/routes/security.routes.js` |
| `docs-upload-minute` | `POST /api/documents` | account | 120 (`UPLOAD_MINUTE_LIMIT`) | 1 minute | `server/utils/uploadLimits.js` |
| `docs-upload-hour` | `POST /api/documents` | account | 600 (`UPLOAD_HOURLY_LIMIT`) | 1 hour | `server/utils/uploadLimits.js` |
| document cap | `POST /api/documents` (count, not a window) | account | 2,000 documents (`MAX_DOCUMENTS_PER_ACCOUNT`) | n/a | `server/utils/uploadLimits.js` |
| `docs-star` | star or unstar | account | 600 | 1 hour | `server/routes/documents.routes.js` |
| `docs-recent` | Recent list | account | 300 | 1 hour | `server/routes/documents.routes.js` |
| `docs-details` | details panel | account | 900 | 1 hour | `server/routes/documents.routes.js` |
| `docs-batch-move`, `docs-batch-trash` | batch move, batch trash | account | 120 each | 1 hour | `server/routes/documents.routes.js` |
| `docs-note` | private note | account | 300 | 1 hour | `server/routes/documents.routes.js` |
| `docs-version-upload` | new version | account | 60 | 1 hour | `server/routes/documents.routes.js` |
| `docs-version-restore`, `docs-version-delete` | restore, delete a version | account | 120 each | 1 hour | `server/routes/documents.routes.js` |
| `docs-version-download` | download a version | account | 300 | 1 hour | `server/routes/documents.routes.js` |
| `docs-quarantine-release` | release a held file | account | 60 | 1 hour | `server/routes/documents.routes.js` |
| `emergency-public-ip` | `/api/emergency/public/*` | IP | 40 | 1 hour | `server/routes/emergency.routes.js` |
| `emergency-fail-pair-ip` | wrong kit or code | contact, owner and IP | 8 | 1 hour | `server/utils/emergency/service.js` |
| `emergency-fail-ip` | wrong kit or code | IP | 25 | 1 hour | `server/utils/emergency/service.js` |
| `emergency-code-owner` | codes emailed for an owner | owner | 5 | 1 hour | `server/utils/emergency/service.js` |
| `emergency-owner` | owner actions | account | 60 | 1 hour | `server/routes/emergency.routes.js` |
| `emergency-owner-read` | status, session info, folder picker | account | 600 | 1 hour | `server/routes/emergency.routes.js` |
| `shared-access` | `POST /api/shared/:id/access` | IP | 30 | 1 minute | `server/routes/sharedView.routes.js` |
| `shared-email-code` | `POST /api/shared/:id/email-code` | IP | 10 | 1 hour | `server/routes/sharedView.routes.js` |
| `shared-email-verify` | `POST /api/shared/:id/email-verify` | IP | 30 | 15 minutes | `server/routes/sharedView.routes.js` |
| `shared-unlock` | `POST /api/shared/:id/unlock` | IP | 30 | 15 minutes | `server/routes/sharedView.routes.js` |
| `shared-view-manifest` | `GET /api/shared/:id` | IP | 20 | 1 minute | `server/routes/sharedView.routes.js` |
| `shared-view-file` | `GET /api/shared/:id/files/:fileId` | IP | 120 | 1 minute | `server/routes/sharedView.routes.js` |
| `share-email` | code emails per share | share id | 5 | 1 hour | `server/utils/shareGate.js`, `server/utils/shareLimits.js` |
| share password failures | wrong share password | share id | 5 | 15 minutes | `server/controllers/sharedView.controller.js`, `server/utils/shareLimits.js` |
| `cron` | `/api/cron/*` (before the secret check) | IP | 30 | 1 minute | `server/routes/cron.routes.js` |
| daily mail budget | all outgoing email | the whole app, per UTC day | 300 (`MAIL_DAILY_CAP`); bulk mail 150 (`MAIL_BULK_SHARE`) | 1 day | `server/utils/mailBudget.js` |

Notes:

- The older `docs/SCORING-AUDIT.md` lists some of these with line numbers from 15 October. Use this table for the current names.
- `GET /api/health` and `GET /api/auth/config` have no limiter. They do not send email or touch an account.
- Other signed-in routes that read or change only the caller's own data (trash, shares, insights, folders) have no per-request
  limiter. They are bounded by the session, the storage quota and the 4 MB file limit.
- The tests are `rate-limit-headroom.test.js` (pages do not use up each other's budgets), `rate-limit-keys.test.js` (keying),
  `login-lockout.test.js`, `upload-limits.test.js`, `consent-mailcap.test.js` (mail budget), and `deploy.test.js` (cron limit).
