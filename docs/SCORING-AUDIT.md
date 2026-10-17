# Warden: Scoring Guide Audit (S12627-Y3 Final Project)

Audit date: 2026-10-15. Commit audited: `9c03bf8` (96 commits, first 2026-08-23). Method: read-only. No source file was changed. Evidence is a file with line numbers, a named test, or command output from this audit run. Where no evidence was found the item is marked FAIL or UNVERIFIED.

**Scope note.** The prompt asked for the "top band (90-100) wording" of each criterion but did not include the rubric text. Verdicts below are judged against each criterion's title, weight and the checklist in the prompt. Re-check them against the official wording before the defense.

**Update, 17 October 2026.** This audit was written on 15 October at commit `9c03bf8`. The structure, line numbers and verdicts below are
from that date. Since then the code changed in these ways, and notes marked **Update** in the sections below say what each one
changes. No score or verdict was changed, because we did not re-run the whole audit.

- Consent and the policy version are stored on new accounts (`consent.acceptedAt`, `consent.policyVersion`).
- The privacy page names the National Privacy Commission for complaints, and covers withdrawing consent and data portability.
- There is a daily mail cap (`MAIL_DAILY_CAP`, default 300, bulk mail 150) in `server/utils/mailBudget.js`.
- Lockouts, wrong code bursts and 429 answers are written to the security log (`server/utils/securityLog.js`).
- ESLint exists in `client` and `server` (`npm run lint`).
- Uploads are limited per account: 120 per minute, 600 per hour, and 2,000 documents (`server/utils/uploadLimits.js`).
- The Quarantine scanner checks every upload (`server/utils/fileScanner.js`, `docs/QUARANTINE.md`).
- Test counts at the last full run: server 549, client 594 (the baseline below says 414 and 302). Main bundle 122.12 KB gzip.
- The other documents in this folder (`docs/README.md` is the index) now cover the justification, the role matrix, the threat model
  and the test evidence that sections 2.1, 2.6 and 4 list as missing.

**How the live evidence was produced.** A scratch copy of the real app (every middleware, `server/server.js`) ran against a throwaway local MongoDB (127.0.0.1:27099, a separate instance from any other database), with mail captured to files. No `.env` file was read, no Atlas connection was made, no mail was sent. The probe scripts lived outside the repo. The throwaway MongoDB and the dev server were stopped at the end.

---

## 0. Baseline (Step 0)

| Item | Result |
|---|---|
| Server tests | 414 pass, 0 fail, 0 skipped (DB-backed tests ran against the local throwaway MongoDB) |
| Client tests | 302 pass, 0 fail |
| Test files | 72 (`git ls-files | grep test.js`) |
| `npm audit --omit=dev` (server) | found 0 vulnerabilities |
| `npm audit --omit=dev` (client) | 2 moderate: `react-router` / `react-router-dom` 6.0.0 - 7.17.0 (GHSA-wrjc-x8rr-h8h6 open redirect via backslash in `<Link>`/`useNavigate`; GHSA-337j-9hxr-rhxg `deserializeErrors()` in SSR hydration, which this SPA does not use). Fix is `react-router-dom@7`, a breaking change. |
| Client build | OK, main bundle `index-BFQ20QNx.js` 373.84 kB (119.06 kB gzip) |
| Commits | 96, from 2026-08-23 to 2026-10-15 |
| Code size (non-test) | server about 11.8k lines (controllers 3,553, utils 6,470, models 889, routes 600, middleware 316), client `src` about 20.6k lines |

Last 15 commit subjects (version-control evidence):

```
9c03bf8 test: index coverage for migrations, session parallel-write safety, rate-limit headroom, cache clearing
1dd2058 perf: keep layout mounted on navigation, parallel startup fetches, in-memory page cache, lazy-load heavy viewers
f494419 feat: verify email with a code before creating the account; redesigned recovery key screen; deliverability hygiene for code emails
d7543a6 fix: security review findings (atomic uniform lockout, enumeration and error leaks, mandatory emergency notice, absolute session lifetime, IPv6 limits, ...
a4bddb7 feat: emergency access UI with owner wizard, printable kit sheet, public contact page and read-only vault mode
b382a3f feat: emergency access backend with 2-of-2 key split, waiting period, deny-by-default read-only sessions
6e1bc9e feat: purpose watermark on shares, document expiry reminders, vault health score
ab42540 feat: persistent sign-in, trusted-browser fix, remove phone vault, devices and activity with tamper-evident log, overview insights
5982faf feat: remove storage meter; share dialog with copy link, QR and app buttons; shared HTML/text email templates with highlighted OTP
24af9c3 Make device pairing and sync work on the hosted app and harden the phone PIN
0454e9e Remove USB backup and restore, add browser zip export and import, fix preview generation
761f0ec Landscape auth layout on desktop, fix login autofill suggestion, day-only share expiry
a2edc81 Rebuild forgot password around emailed codes with recovery key fallback
e8eec08 Require the invite code on sign-up in invite mode
5bc2c64 Load mkcert certificates only for local dev serve, so vite build works without certs/
```

---

## 1. Summary table

Verdict key: PASS / PARTIAL / FAIL (UNVERIFIED where it cannot be checked locally).

| Criterion | Weight | Verdict | Est. band | One-line reason |
|---|---|---|---|---|
| 3.1 Input validation and error handling | 15 | PARTIAL | 80-89 | Every route validates by hand and probes were all 4xx, 5xx is fixed text plus request id, logs scrubbed; but no central validator layer, only unit-level injection tests, and lockouts, code failures and 429s are not logged. |
| 3.2 Authentication, MFA, session | 25 | PASS (with caveats) | 80-89, top of band | scrypt, atomic lockout, 6-digit emailed code with attempt/resend/hourly caps, OTP cannot be off in production, 30 min idle / 12 h absolute session, server-side logout; caveats: email-only MFA, 5-minute lock, token in sessionStorage. |
| 3.3 Authorization and access control | 25 | PASS (code), PARTIAL (documentation) | 90-100 once the matrix is in the paper | 66 of 66 session routes have a cross-user test, deny-by-default emergency allowlist; there is no stored role field, so the role matrix below must be presented. |
| 3.4 Data protection | 20 | PASS | 90-100 | AES-256-GCM, scrypt, wrapped keys, helmet/HSTS/CSP, secrets scan clean, `.env` ignored, limits stated honestly; open item: 2 moderate client advisories, HSTS on the HTML host UNVERIFIED locally. |
| 3.5 Privacy controls | 15 | PARTIAL | 80-89 | Read-before-agree checkbox, detailed privacy page, self-service export and deletion verified with an orphan scan; but consent is not recorded server-side and the page names no complaint route (NPC) or DPO. |
| 2.1 Project design and innovation | 12.5 | PARTIAL | 80-89 (60-79 until written) | Distinctive features are real; no written justification for MERN or the NoSQL design exists in the repo. |
| 2.2 MERN development and integration | 22.5 | PASS | 80-89 | 19 models with proven index coverage, REST with sensible status codes, error middleware, API layer with interceptors; no pagination on the file list, no API reference, no automated responsive test. |
| 2.3 Security, scalability, code quality | 15 | PARTIAL | 80-89 | 716 tests, clear structure, conventional commits; no lint config, 3 source files over 600 lines, 2 dead files. |
| 2.4 System integration and visualization | 20 | PARTIAL | 60-79 | End-to-end workflow is real and the health card is decision-focused; the Overview has one graphic (the score ring) and no charts or trends. |
| 2.5 Analytics implementation | 17 | PARTIAL | 60-79 | Nine health checks and five usage metrics all run on real data; no written objective, no time series, no analytics export. |
| 2.6 Scalability, ethics, governance | 13 | PARTIAL | 60-79 | Bottlenecks are knowable and mostly bounded; no written scaling strategy or governance document, no global email-send cap. |

---

## 2. PART 3: System Security (30%)

### 3.1 Input validation and error handling (15): PARTIAL, band 80-89

**Route inventory.** 110 API route entries from walking the real router stack (`routes31.js`, scratch): 13 "removed feature" entries (`ALL /api/backup`, `/api/pair`, `/api/sync`, `/api/devices`, `/api/auth/recover-via-usb`, `/api/auth/recover-via-phone`, ... answer 410), 66 session-guarded routes and 31 public ones. Validation is hand-written in each handler. There is no validator library.

Global guards (`server/server.js`):
- `express.json({ limit: '100kb' })` at `server.js:101`; larger bodies answer 413.
- `mongoSanitize()` at `server.js:110` strips `$`/`.` keys from body, query and params.
- Multipart upload goes through multer with a 4 MB cap (`routes/documents.routes.js:33,39`), type-checked in the handler (`documents.controller.js:137`).
- Route-level helper `assertValidId` (`documents.controller.js:52-56`) and `mongoose.Types.ObjectId.isValid` (`security.controller.js:87,103`, `account.controller.js:156`, `utils/trash.js:293`).

| Route(s) | Server-side guard (file:line) |
|---|---|
| `POST /auth/signup/start` | string/type check, `normalizeRecipient`, `validatePassword`, `termsAccepted === true`, MX check, per-address budget (`signup.controller.js:72-95`) |
| `POST /auth/signup/verify`, `/signup/resend` | type checks, attempts counted before the check (`signup.controller.js:104,138`; `utils/signupCodes.js:20-22,95-104`) |
| `POST /auth/unlock` | `typeof email/password === 'string'` (`auth.controller.js:284-288`) |
| `POST /auth/verify-otp`, `/resend-otp` | `challengeToken`, `code` read as strings (`auth.controller.js:355,382`), code hash compare in `utils/otp.js:26-31` |
| `POST /auth/verify-email`, `/resend-verification` | `auth.controller.js:115,144` |
| `POST /auth/password-reset/*` | `passwordReset.controller.js:80,105,116,144,209,276` |
| `GET /auth/me`, `POST /auth/logout` | session only, no input |
| `POST/PATCH/DELETE /documents/folders`, `GET /documents/folders/children`, `POST /documents/move` | `documents.controller.js:306,388,420,446,482` |
| `POST /documents` (upload) | multer cap + `documents.controller.js:137` (`folder`, `expiryDate` typed) |
| `PATCH /documents/:id`, `/:id/view`, `/:id/thumbnail`, `/:id/downloaded`, `/:id/thumbnail-failed`, `DELETE /documents/:id` | `assertValidId` + `userId` filter (`documents.controller.js:644,712,778,798,828,863,893`) |
| `POST /documents/:id/share`, `POST /shares`, `PATCH /shares/:shareId`, password routes | `shares.controller.js:187-204,370,381,395,453,468,509,587` (`SHARE_ID_RE`, `parseMaxDownloads`, `parseRecipient`, `parsePurpose`, `parsePasswordBody`) |
| `GET /shared/:shareId...` (public) | `SHARE_ID_RE` / `FILE_ID_RE` (`sharedView.controller.js:48,205`) |
| `GET /trash`, `POST /trash/restore`, `DELETE /trash/:kind/:id` | `trash.controller.js:24,50`, `utils/trash.js:291-309` (kind whitelist, `ObjectId.isValid`) |
| `GET /security/activity` | `parseDate`, `parseInt(limit)` (`security.controller.js:183-190`) |
| `POST /security/client-event`, `/devices/:id/*` | `security.controller.js:87,103,118,256` |
| `PATCH /account/preferences`, `/account/*` | `health.controller.js:61`, `account.controller.js:47,68,85` |
| `POST /emergency/*`, `/emergency/public/*` | `text()` length-capped string reader (`emergency.controller.js:12-13,19,25,85-102`), `isId` in `utils/emergency/service.js:308,323` |
| Routes with no input (`GET` lists: `/documents`, `/documents/expiring`, `/documents/storage`, `/documents/photos`, `/insights/*`, `/shares`, `/shares/usage`, `/account/health`, `/emergency/status`, ...) | none needed; scoped by `req.userId` |

No route was found that reads client input without a type check. The weakness is structure, not a gap: validation is spread over about 12 controllers and the style differs (see fix list).

**Malicious input is blocked: tests.**
- NoSQL operator injection: `server/test/auth-email.test.js:133,185` (`{ $ne: null }` as email on sign-up/login), `server/test/invite.test.js:121-133`, `server/test/otp.test.js:290`. These are unit/route tests for sign-up, login, invite and OTP only. There is no repo test that injects operators into the document, share, trash or folder routes.
- Oversized body: 413 for a 200 KB JSON body (live probe below); storage cap `server/test/trash.test.js:608-618`; 24 MB share `server/test/shares.test.js:226`.
- Wrong types: `server/test/auth-email.test.js:132,184`, `server/test/email.test.js:57-61`.
- Path traversal in import: `client/src/utils/zipImport.test.js:20` ("`..` segments, absolute paths, drive letters, NUL and backslash tricks are unsafe") and `:41` ("path traversal and absolute paths are ignored and listed, never planned"), plus bomb, depth, nested-zip tests at `:51-175`. Import happens in the browser and every file goes through the normal upload path.

**Live probe (this audit run): 25 hostile requests, every one 4xx, none 5xx.**

```
404 GET  /api/documents/%24ne
200 GET  /api/documents?x[$ne]=1&folder[$gt]=            (operators stripped, normal list returned)
200 GET  /api/documents/folders/children?path[$ne]=x     (operator stripped)
404 GET  /api/documents/folders/children?path=../../etc
400 GET  /api/security/activity?limit=abc&from=notadate&before[$gt]=1&device[]=a&group[$ne]=1
400 PATCH /api/documents/:id {"filename":{"$ne":1},"folder":["x"],"expiryDate":{"$gt":1}}
200 PATCH /api/documents/:id {"filename":"../../etc/passwd"}   (see note)
400 POST /api/documents/move {"items":"x","destination":{"$ne":1}}
400 POST /api/shares {"documentIds":{"$ne":null}}
400 POST /api/trash/restore {"kind":{"$ne":1},"id":[1]}
400 POST /api/auth/unlock {"email":{"$ne":null},"password":{"$ne":null}}
401 POST /api/auth/verify-otp {"challengeToken":{"$ne":null},"code":{"$ne":null}}
400 POST /api/documents/folders {"name":"../../x","parentPath":{"$ne":1}}
400 DELETE /api/documents/folders?path[$ne]=1
(... 11 more, all 4xx)
413 POST /api/auth/unlock with a 200 KB body   -> {"success":false,"error":{"message":"request entity too large","status":413}}
400 malformed JSON body                          -> message "Unexpected end of JSON input"
413 5 MB upload                                   -> "File exceeds the 4MB size limit."
```

Note on `filename: "../../etc/passwd"` (200): the name is stored as metadata only. Files live in MongoDB as ciphertext, never on a filesystem path, and downloads are named from a sanitised header (`utils/fileNames.js`, `client/src/utils/disposition.test.js`). Not exploitable here, but worth stating at the defense. The malformed-JSON 400 echoes the parser's message; low risk, 4xx only.

**5xx responses carry a fixed message and a request id, never a stack.** Code: `middleware/errorHandler.js:21-39` (`GENERIC_SERVER_ERROR`, `requestId`), test `server/test/error-handler.test.js:23,39,47,56`. Triggered in this audit by injecting a fault into a scratch copy of the real app (production mode, dummy config): the documents aggregate threw a driver-style error whose text contained a connection string, an email address and a local path.

```
STATUS 500
BODY {"success":false,"error":{"message":"Something went wrong on our side. Please try again.","status":500,"requestId":"a26b0247ad3c"}}
STACK_OR_PATH_IN_BODY false
SERVER LOG LINE: [request a26b0247ad3c] 500 Error: E11000 duplicate key error collection: warden.documents index: userId_1 dup key: { userId: "[address]" } at [database address]
LOG CONTAINS_URI_OR_EMAIL_OR_PATH: false
```

Honesty note: this is a forced fault. Probing the real app with 25 hostile inputs did not produce a natural 500. Production start-up also fails fast on bad config (`utils/productionConfig.js:78`); the first fault run was refused with "Refusing to start: invalid production configuration" listing the missing variable names only.

**Logging without sensitive data.** `utils/logSafe.js:9-14` (`scrubForLog` removes addresses and connection strings), `shortHash` (`:17-19`), tests `server/test/log-privacy.test.js:21,33`. Only 20 `console.*` calls exist in the server code outside tests (grep over controllers, middleware, utils, config and `server.js`). Failed email sends log a short hash, not the recipient (`utils/email.js:207`).

**Which security events are logged: PARTIAL.**

| Event | Logged? | Where |
|---|---|---|
| Failed login (wrong password, and attempts refused during a lock) | Yes, to the account's activity log as `login_failed` (own user only) | `auth.controller.js:295-300,314`; `utils/auditTypes.js:3` |
| Successful login, logout, trusted browser added/removed, password change, device sign-out | Yes (activity log) | `utils/auditTypes.js:3-4` |
| Lockout becoming active | Not as its own event (the refused attempts appear as `login_failed`); nothing in the server log | `auth.controller.js:293` |
| Wrong one-time code | No event, no server log line | `utils/otpChallenge.js` (attempt counted, nothing recorded) |
| HTTP 429 (rate limited) | Not logged anywhere | `middleware/rateLimit.js:97-100` |
| 5xx | Yes, server log with request id, scrubbed | `middleware/errorHandler.js:33` |

Dev-only caveat: when SMTP is not configured and the app is not in production, `utils/email.js:185` prints the whole email (including the code) to the console. Production is guarded (`email.js:175-179`) and start-up refuses missing SMTP (`productionConfig.js`).

**Update (17 October):** the rows above that say "not logged" are out of date. The security log (`server/utils/securityLog.js`, read in
Vercel Logs) now writes one JSON line for a `lockout`, `code_failures` (3 or more wrong guesses on one code), `rate_limited` (every 429,
by limiter name), `sessions_revoked`, `emergency_denied`, `emergency_refused`, `share_password_failures`, `mail_cap`, `file_held`,
`file_refused`, `file_released`, `scan_error` and `document_limit`. Each line holds a short keyed hash and no email, token, IP address or
file name, and floods are thinned. Tests: `server/test/security-log.test.js`, `log-privacy.test.js`. The activity log (per account) is
unchanged. The logging gap in the 3.1 summary is therefore closed in code. The verdict above is not changed.

**Update (17 October), uploads:** `POST /api/documents` now also runs the Quarantine scanner (`server/utils/fileScanner.js`) before
encryption, refuses a plain zip (`USE_IMPORT`) and applies the per-account limits. Warden accepts any file type up to 4 MB. There is no
list of allowed types. Risky files are held, and a program in disguise is refused. See `docs/QUARANTINE.md`.

### 3.2 Authentication, MFA, session security (25): PASS with caveats, band 80-89 (top)

| Control | Evidence |
|---|---|
| Password hashing | scrypt `N=2^15, r=8, p=1`, `maxmem` 64 MB, 64-byte output, random 16-byte salt, context label so the verification hash and the encryption key are independent (`utils/crypto.js:22,24,25,47-49,80,96,147-148`). Compare is `timingSafeEqual` (`:63-67,116`). |
| Password policy | minimum length 12 (`utils/passwordPolicy.js:15`) |
| Lockout | 3 attempts per 5-minute window, then locked 5 minutes (`utils/loginLimiter.js:19-21`). Counted first in one atomic update, key is an HMAC of the address, never the address (`loginLimiter.js:27-29`). Real and unknown addresses answer identically (`auth.controller.js:284-318`). Tests `server/test/login-lockout.test.js:71,86,100,114,137,146`. Stored in MongoDB (`LoginFailure` model). |
| Emailed login code | uniform random 6 digits via `crypto.randomInt` (`utils/otp.js:12-14`), stored as salted hash, compared in constant time (`otp.js:22-31`). TTL `OTP_TTL_MINUTES`, default 5, range 1-60 (`utils/otpConfig.js:13-30`). 5 guesses per challenge then deleted (`utils/otpChallenge.js:37,158,178`). 3 resends, 60 s gap (`:38-39,218-221`). 5 code emails per hour per account across purposes (`:40-41`). Purposes are separate: login code cannot complete sign-up or delete (`server/test/signup-flow.test.js:188`). |
| OTP cannot be disabled in production | `utils/otpConfig.js:25-31` throws at start-up; tests `server/test/otp.test.js:376`, `server/test/deploy.test.js:54`. |
| Sign-up verifies the email before any account exists | Live probe: after `signup/start` `usersWithEmail: 0` (one pending challenge row; a crude scan of it found no password-hash pattern, and the privacy page says it holds only a salted code hash tied to a keyed address hash); after a wrong code `usersWithEmail: 0`; after the right code `usersWithEmail: 1`, `sessionToken` and `recoveryKey` returned. Without `termsAccepted` the call is 400 "Please agree to the Terms of use and the Privacy policy". Tests `server/test/signup-flow.test.js:84,104,116,122,157,180,267`. |
| Session | Server-side row per session (`models/Session.js`), bearer token `sessionId.sessionKey` (two 32-byte random values, only the SHA-256 of the first stored; the vault key is wrapped under the second, which is never stored) (`utils/sessionStore.js:42-43,61-82`). Idle TTL 30 min sliding (`:27`), absolute 12 h default, `SESSION_ABSOLUTE_HOURS` 1-168 (`:34-41`), emergency sessions 4 h. Slide cannot pass the absolute end (`:169-178`). Proven again this audit on a real MongoDB: `server/test/session-parallel.test.js` (revoked, absolute, expired, idle slide), `server/test/session-lifetime.test.js:45,68,82,94,103,129`. |
| Logout revokes server-side | Live probe: `/auth/me` 200 -> `POST /auth/logout` 200 -> `/auth/me` with the same token 401. `destroySession` deletes the row (`sessionStore.js:188-192`). |
| Cookies (Set-Cookie from a local login with "trust this browser") | `warden_did=<43 chars>; Max-Age=34560000; Path=/api; Expires=...; HttpOnly; SameSite=Strict` and `warden_td_<account>=<43 chars>; Max-Age=2592000; Path=/api; HttpOnly; SameSite=Strict`. **No `Secure` flag appeared in this run because the local server is plain http in development.** Code sets `Secure` whenever the request is HTTPS or `NODE_ENV=production` (`utils/trustedDevice.js:67-76`); test `server/test/trusted-devices.test.js:112` asserts `cookie.secure === true`. Production behaviour is therefore proven by test, not by this run. |
| Session token location | Not a cookie: kept in tab `sessionStorage` (`client/src/services/session.js:1-25`). Readable by injected script; mitigated by a strict CSP and no third-party scripts, and stated in the privacy page and `DEPLOY.md:210`. |
| Password reset | Emailed code flow, recovery-key flows, ticket and challenge tables (`passwordReset.controller.js`, `utils/accountReset.js`). A reset revokes all sessions and all trusted browsers, deletes reset tickets and code challenges (`accountReset.js:126-129`); the "start over / wipe" route also deletes documents, folders, devices, audit log, reminder logs and the emergency setup (`:101-112`). Tests `server/test/password-reset.test.js`, `trusted-devices.test.js` ("password reset / wipe ... remove every trusted browser"). |
| Enumeration resistance | `server/test/enumeration-timing.test.js:55,79,108` |

**Rate limiters (all stored in MongoDB via the `RateLimit` model, so shared across serverless instances; none is in memory).** Mechanism: one atomic `findOneAndUpdate` per (bucket, key) window (`middleware/rateLimit.js:26-45`), TTL index reaps old windows, the IP key is reduced through `ipKey` (IPv6 by its /64, `utils/clientIp.js:14-28`).

| Bucket | Key | Limit / window | Where |
|---|---|---|---|
| signup-ip | IP | 10 / 1 h | `routes/auth.routes.js:40` |
| signup-email | email | 5 / 1 h | `auth.routes.js:44` |
| signup-code-address | address | 5 / 1 h (start and resend) | `signup.controller.js:67-68` |
| signup-verify-ip | IP | 30 / 15 min | `auth.routes.js:47` |
| signup-resend-ip / -email | IP / email | 10 / 1 h and 1 / 1 min | `auth.routes.js:50,52` |
| verify-email, resend-verification-ip / -email | IP / email | 20 / 1 h; 10 / 1 h and 1 / 1 min | `auth.routes.js:59,64,67` |
| login (unlock, verify-otp, resend-otp) | IP | 20 / 15 min | `auth.routes.js:73,80,85` |
| login failures per address | HMAC(email) | 3 / 5 min, lock 5 min | `utils/loginLimiter.js:19-21` |
| login code guesses / resends / emails | challenge / account | 5 / 3 / 5 per hour | `utils/otpChallenge.js:37-41` |
| password-reset-ip / -email | IP / email | 10 / 1 h; 5 / 1 h | `auth.routes.js:95-96` |
| password-reset-code-ip, -ticket-ip | IP | 20 / 15 min | `auth.routes.js:101,106,111,116` |
| rk-ip-1h, rk-gap-2m/10m, rk-fail-1h (recovery-key-only, in the controller) | IP / email | 10 / 1 h; 2 / 2 min; 3 / 10 min; 5 / 1 h | `passwordReset.controller.js:248-251` |
| invite-fail-15m / -1h | IP | 5 / 15 min; 20 / 1 h (failures only) | `utils/inviteGate.js:25-28` |
| account-ip, account-user | IP / account | 20 / 1 h; 10 / 1 h (delete-account family, trusted-browser removal) | `routes/account.routes.js:20-24` |
| security-user | account | 300 / 1 h (devices, activity, verify-log) | `routes/security.routes.js:21-23` |
| emergency-public-ip | IP | 40 / 1 h | `routes/emergency.routes.js:16` |
| emergency-fail-pair-ip, emergency-fail-ip | contact+owner+IP; IP | 8 / 1 h; 25 / 1 h | `utils/emergency/service.js:74-75` |
| emergency-code-owner | owner | 5 / 1 h | `service.js:76` |
| emergency-owner (actions) | account | 60 / 1 h | `emergency.routes.js:25-27` |
| emergency-owner-read (status polling, new in 31Q) | account | 600 / 1 h | `emergency.routes.js:34-36` |
| shared-access | IP | 30 / 1 min | `routes/sharedView.routes.js:24` |
| shared-email-code | IP | 10 / 1 h | `sharedView.routes.js:29` |
| share-email (code mails per share) | shareId | 5 / 1 h | `utils/shareGate.js:107`, `utils/shareLimits.js:15` |
| shared-email-verify | IP | 30 / 15 min | `sharedView.routes.js:34` |
| shared-unlock; share-password failures | IP; shareId | 30 / 15 min; 5 / 15 min | `sharedView.routes.js:39`; `sharedView.controller.js:139-160`, `shareLimits.js:19-20` |
| shared-view-manifest / -file | IP | 20 / 1 min; 120 / 1 min | `sharedView.routes.js:48,56` |
| cron | IP | 30 / 1 min (before the secret check) | `routes/cron.routes.js:30` |
| docs-upload-minute, docs-upload-hour (`POST /api/documents`) | account | 120 / 1 min and 600 / 1 h (env `UPLOAD_MINUTE_LIMIT`, `UPLOAD_HOURLY_LIMIT`); every request counts, including refused ones; 429 `UPLOAD_RATE_LIMITED` with `Retry-After`; runs before the body is read, scanned or encrypted | `utils/uploadLimits.js`, `routes/documents.routes.js` |
| document count cap (not a window: a count of the account's documents, live, held and in Trash) | account | 2000 documents (env `MAX_DOCUMENTS_PER_ACCOUNT`); 409 `DOCUMENT_LIMIT`; one indexed count stopped at the cap; new versions are not new documents | `utils/uploadLimits.js`, `documents.controller.js` |

**Auth or email-sending routes with NO limiter:** none found. `POST /auth/password-reset/recovery-key-only` has no route-level limiter in `auth.routes.js:121`, but the controller reserves the `rk-*` budgets before looking at the key (`passwordReset.controller.js:255-285`). Public routes with no limiter are `GET /api/health` and `GET /api/auth/config`, neither of which sends email or touches an account. Uploads (`POST /api/documents`) are now limited per account in count and speed (the two rows above), in addition to the 4 MB and storage quota limits. The other signed-in data routes (shares, trash, insights) have no per-request limiter; they are bounded by the session, the 25 MB quota and the 4 MB file cap, not by a request-rate limit (see 2.6).

**Update (17 October):** since this audit the per-account limiters in `server/routes/documents.routes.js` (`docs-star`, `docs-recent`,
`docs-details`, `docs-batch-move`, `docs-batch-trash`, `docs-note`, `docs-version-*`, `docs-quarantine-release`) were added next to the
two upload rows above, and the whole app has a daily mail budget (300 a day, bulk mail 150). The complete current list is in
`docs/ROLES-AND-RATE-LIMITS.md`. The sentence above that says other signed-in routes have no per-request limiter is true only for trash,
shares, insights and folders now.

Caveats for the defense: MFA is email-code only (no authenticator-app/TOTP option); the lock is short (5 minutes) and keyed by address, so an attacker who knows an address can keep it locked by retrying every 5 minutes (a deliberate trade-off against guessing); the sessionStorage token trade-off is documented.

### 3.3 Authorization and access control (25): PASS in code, PARTIAL in documentation

**There is no `role` field.** Authorization is by identity of the caller and by capability tokens. The five roles the rubric can recognise are therefore derived from the code and must be presented as the matrix below.

**No route takes a user id from the client as authority.** Every owner query filters by `req.userId`, which only `requireSession` sets from the server-side session (`middleware/requireSession.js:36,57`). A grep of the controllers shows no `req.body.userId` or `req.params.userId`. Ownership filters, route by route:

| Route(s) | Ownership filter (file:line) |
|---|---|
| `PATCH /documents/:id`, `GET /:id/view`, `/:id/thumbnail`, `POST /:id/downloaded`, `/:id/thumbnail-failed`, `DELETE /:id` | `Document.findOne({ _id, userId: req.userId, deletedAt: null })` (`documents.controller.js:646,715,779,800,835,871`; delete via `trashDocument(req.userId, id)` `:897`) |
| `GET /documents` | `$match: { userId: req.userId, deletedAt: null, ...documentScope }` (`:233`) |
| `POST /documents/move`, folder routes | `userId` in every folder/document query (`utils/folders.js:101-114`) |
| `POST /documents/:id/share`, `POST /shares` | `Document.find({ _id: {$in}, userId: req.userId })` (`shares.controller.js:237,258,397`) |
| `GET/PATCH/DELETE /shares/:shareId`, `/manifest`, `/protection`, `/password` | `Share.findOne({ shareId, ownerUserId: req.userId })` (`shares.controller.js:454`); removal `removeShares({ shareId, ownerUserId })` (`:590`) |
| `GET /shares`, `/shares/usage` | `ownerUserId: req.userId` (`:323,403,433`; `shares` aggregate `$match` `:50`) |
| Trash | `Document.deleteOne({ _id, userId, deletedAt: {$ne:null} })` (`utils/trash.js:294`), `TrashFolder.findOne({ userId, batchId })` (`:300`) |
| Devices, trusted browsers | `Device.findOne({ _id, userId: req.userId })` (`security.controller.js:88,104`), `TrustedDevice.findOne({ _id, userId })` (`account.controller.js:157`) |
| Emergency owner routes | `EmergencyRequest.findOneAndUpdate({ _id, userId: req.userId, ... })` (`utils/emergency/service.js:311,324`) |
| Insights, health, activity | `userId: req.userId` in every query (`insights.controller.js:37,49,59,88`) |

**Cross-user tests.** `server/test/cross-user.test.js` runs the real app against a local MongoDB, signs in as account B and calls every owner route with account A's identifiers (path, query and body), then checks A's rows are byte-for-byte unchanged. It walks the router stack, so a route added without a plan fails (`cross-user.test.js:51-76`, header `:1-17`). **Verified in this audit: all 66 session-guarded routes have a plan line (66 of 66; 0 without).** Related: `server/test/emergency-allowlist.test.js:78` (exactly eight allowed routes), `:95` (every registered route is allowlisted, public or refused for an emergency token), `:191,:237` (scope leaks and edges), `server/test/share-gates.test.js`, `server/test/shares.test.js`, `server/test/emergency-privacy.test.js`, `server/test/emergency-hardening.test.js`.

Not covered by the cross-user test (they are public routes, covered elsewhere): the share-recipient and emergency-contact flows rely on `share-gates.test.js` and the emergency tests. **Recommendations (not added):** (1) a test that an access token issued for share A is refused on share B (the code binds it: `utils/shareGate.js:56-65`, `sharedView.controller.js:207`, but there is no named test I could cite for the cross-share case); (2) a test that an emergency-session token cannot call the owner-only emergency routes, in addition to the allowlist walk; (3) HTTP-level operator-injection cases for every owner route (see 3.1).

#### Role and permission matrix (paste into the defense paper)

Roles: **Owner** = signed-in normal session. **Share recipient** = anyone holding a share link, with or without the email and password gates. **Emergency contact** = a trusted contact who has passed the kit + emailed-code checks and holds a read-only emergency session. **Anonymous** = no credentials. **System** = the scheduler calling cron with a secret.

| Capability / routes | Owner | Share recipient (open link) | Share recipient (email-restricted and/or password) | Emergency contact (scoped, read-only) | Anonymous |
|---|---|---|---|---|---|
| Sign up, log in, reset password: `POST /api/auth/signup/*`, `unlock`, `verify-otp`, `resend-otp`, `verify-email`, `resend-verification`, `password-reset/*`; `GET /api/auth/config`, `GET /api/health` | no need | no | no | no | **Yes**, each behind a limiter (table in 3.2) |
| Session identity: `GET /api/auth/me`, `POST /api/auth/logout` | Yes | no | no | Yes (allowlisted) | no |
| List and read own files: `GET /api/documents`, `/folders`, `/folders/children`, `/:id/view`, `/:id/thumbnail` | Yes, own only | no | no | **Only inside the chosen scope**, read-only | no |
| Upload, rename, move, delete, folders, expiry: `POST/PATCH/DELETE /api/documents*`, `POST /documents/move`, thumbnails, `/photos`, `/storage`, `/expiring` | Yes, own only | no | no | **No** (403 `EMERGENCY_READ_ONLY`) | no |
| Trash: `/api/trash*` | Yes | no | no | No | no |
| Create and manage share links: `POST /documents/:id/share`, `/api/shares*` | Yes, own links only | no | no | No | no |
| Open a share: `POST /api/shared/:id/access`, then `GET /api/shared/:id` and `GET /api/shared/:id/files/:fileId` (ciphertext) | n/a | Yes, while live and under the download limit | **Only after** the gates pass | No | Yes if they hold the link (the decryption key is in the `#fragment`) |
| Email gate: `POST /api/shared/:id/email-code`, `/email-verify` | n/a | not required | **Required**: a 6-digit code sent to the one address | n/a | n/a |
| Password gate: `POST /api/shared/:id/unlock` | n/a | not required | **Required** (verifier hash; 5 wrong tries per 15 min per share) | n/a | n/a |
| Insights, vault health, activity log, devices, trusted browsers, preferences, account deletion: `/api/insights/*`, `/api/account/*`, `/api/security/*` | Yes, own only | no | no | No | no |
| Emergency owner setup/deny/approve/revoke: `/api/emergency/{status,folders,challenge,setup,regenerate-kit,revoke,requests/:id/*}` | Yes, own only | no | no | No (only `GET /api/emergency/session-info`) | no |
| Emergency contact entry: `POST /api/emergency/public/{request-code,request,start-session}`, `GET /api/emergency/public/deny/:token` | n/a | n/a | n/a | Yes, kit + code + waiting period | Yes, same routes, every refusal neutral |
| Cron: `GET /api/cron/purge-trash`, `/reminders` | no | no | no | no | no. **System only** (secret `CRON_SECRET`, constant-time compare, 404 if unset) |

| Role | Enforced by |
|---|---|
| Owner | `requireSession` resolves the bearer token to a session row and sets `req.userId` (`middleware/requireSession.js:36-62`); every query adds `userId: req.userId` (filters above). Cross-user proof: `cross-user.test.js` (66 of 66 routes). |
| Share recipient | `findLiveShare` (exists, ready, not expired, under download limit) `sharedView.controller.js:47-53`; `requireClearance` + `gate.isCleared` `:61-66`, `utils/shareGate.js:62-65`; email code `shareGate.js:107-137`; password verifier `sharedView.controller.js:132-160`; file lookup is `{ shareId, fileId }` so another share's file cannot be fetched (`:207`); responses are opaque bytes with nosniff (`:34-40`). The server never holds the open key after creation. |
| Emergency contact | `ALLOWLIST` of 8 routes, deny-by-default (`middleware/emergencyGuard.js:18-27`, called from `requireSession.js:46`); folder scope as a database filter (`utils/emergency/scope.js:17-24`, used at `documents.controller.js:233,715,800`); read-only by construction; session cap 4 h (`sessionStore.js:61-82`, test `emergency-allowlist.test.js:307`); kit/code attempts limited (`service.js:74-87`). |
| Anonymous | Public routes are an explicit set; `cross-user.test.js:36-48` fails if a new route has no session and is not on that list. |
| System (cron) | `requireCronSecret` `routes/cron.routes.js:18-26`, limiter before the secret `:30`. |

### 3.4 Data protection (20): PASS, band 90-100

| Control | Evidence |
|---|---|
| Passwords | scrypt (see 3.2). The database never holds the password. |
| File encryption | AES-256-GCM (`utils/crypto.js:27`), fresh 12-byte random IV per encryption (`:28,166`), 16-byte auth tag stored with the data (`:169`), tag verified on decrypt via `setAuthTag` (`:193-194`) so tampering throws. One 256-bit random data key (DEK) per account (`:214-215`). |
| Key wrapping | The DEK is wrapped (AES-256-GCM, new random IV) under a password-derived key and, separately, a recovery-key-derived key (`crypto.js:253-264`; `utils/accountCreate.js:23-39`). The password KEK uses a different scrypt context than the verification hash (`crypto.js:36-49,147`). A session holds the DEK only wrapped under the session half of the bearer token (`sessionStore.js`). |
| Recovery key | 32-character alphabet without look-alikes (`crypto.js:30,305-312`), stored only as a scrypt hash (`:343-345`). |
| Transport / headers (API, from this audit's local run) | `Content-Security-Policy: default-src 'self';...;script-src 'self';script-src-attr 'none';object-src 'none';frame-ancestors 'self';upgrade-insecure-requests`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-XSS-Protection: 0`, `Cache-Control: no-store`. From helmet defaults (`server.js:95`). |
| Site headers in production | `vercel.json:81-105`: CSP (script-src `'self'` plus one hashed theme snippet, no eval), `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: same-origin`, `Cache-Control: no-cache` on HTML; `/assets` immutable one year (`:21-33`); `/api` `no-store` (`:47-59`); shared-link pages `no-referrer`, `no-store` and their own CSP (`:60-80`). **`vercel.json` sets no `Strict-Transport-Security` header.** Vercel normally adds HSTS on its own domains, but that cannot be verified locally: UNVERIFIED for the HTML host; the API sets it itself. |
| Secrets scan, working tree (tracked + untracked, excluding `node_modules`, `dist`, lockfile) | Private-key blocks 0; cloud/API token patterns (AKIA, AIza, ghp_, xox, sk-) 0; URIs with credentials 4 hits and secret-assignment patterns 9 hits, **all classified**: placeholders in `DEPLOY.md:21` and fixtures in `server/test/deploy.test.js`, `error-handler.test.js`, `expiry-health.test.js`, `log-privacy.test.js`. 0 real secrets. Untracked files: 0 hits. |
| Secrets scan, git history (all commits, all branches) | Private keys 0; cloud tokens 0; credential URIs/secret assignments in 6 distinct files, all the same placeholders/fixtures (`DEPLOY.md`, `deploy.test.js`, `error-handler.test.js`, `expiry-health.test.js`, `log-privacy.test.js`, `signup-race-errors.test.js`). Only `client/.env.example` and `server/.env.example` were ever committed as env files. |
| `.env` ignored | `.gitignore:2-3` (`.env`, `.env.local`), `server/.gitignore:2`, `client/.gitignore:2` (`git check-ignore -v` confirmed), plus `certs/`, `*.pem`. No `.env` file is tracked. |
| Dependency audit | server 0; client 2 moderate (see Step 0). |

**What Warden does not cover (state this honestly at the defense; it is also in the privacy page, `client/src/pages/public/PrivacyPage.jsx:112-152` and `limits.js`):**
- It is not end-to-end encrypted. The server unlocks the vault key per request, so it sees plaintext while encrypting, decrypting, sniffing the file type and making previews (`PrivacyPage.jsx:124-136`).
- Metadata is readable by the server: file names, folder names, types, sizes, upload and expiry dates (`PrivacyPage.jsx:37-40`).
- The activity log's hash chain detects edits and gaps but not removal of the newest entries by someone who can write to the database, and does not defend against someone holding the signing key (`PrivacyPage.jsx:60-64`).
- Share keys are generated by the server when a link is created, so the server handles the key at that moment (it does not store it) (`PrivacyPage.jsx:42-50`).
- Emergency Access: a copy of the database plus the printed kit opens the vault, and an operator working with the contact could skip the wait (`PrivacyPage.jsx:72-82`).
- The session token lives in `sessionStorage` (readable by injected script) (`PrivacyPage.jsx:127-129`).

### 3.5 Privacy controls (15): PARTIAL, band 80-89

**Consent at sign-up.** `client/src/pages/auth/SignupPage.jsx:86-90,115-118,371-396`: a checkbox "I have read and agree to the Terms of use and Privacy policy" that stays unusable until both documents are opened and scrolled to the end in a dialog; submit is disabled otherwise (`canSubmit = isValid && agreed && legalAllRead`, `:118`). The server refuses `termsAccepted !== true` (`signup.controller.js:80`; live probe: 400 "Please agree to the Terms of use and the Privacy policy to continue."). **Update (17 October): this gap is closed for new accounts.** The server now writes `consent: { acceptedAt, policyVersion }` on every new account (`server/controllers/signup.controller.js`, `server/utils/policyVersion.js`, current version `2026-10-15.3`, tests `server/test/consent-mailcap.test.js` and `signup-flow.test.js`). Accounts made before that have no record. The rest of this paragraph is as written on 15 October. **Gap: the user record has no consent field** (fields observed: `email, emailVerified, passwordHash, salt, recoveryKeyHash, wrappedDEK*, dekFingerprint, failedAttempts, expiryReminders, auditHead, createdAt`), so there is no stored proof of when or which version was accepted. The client also sends `termsAccepted: true` as a constant (`client/src/services/authService.js:12`), so the server check proves the request was well-formed, not that a person ticked the box.

**Privacy notice.** `client/src/pages/public/PrivacyPage.jsx` (263 lines, "Updated October 2026", a draft "not a reviewed legal document"). It states purpose (`:153-165` "We use your information only to run Warden: to sign you in, keep your vault working, send the emails you ask for, and protect accounts from abuse. We do not sell, rent or share your data, and we do not use it for advertising."), data collected (`:12-108`, 14 itemised entries), what the operator can and cannot read (`:112-139`), limits (`:140-152`), where data is stored (`:167-176` MongoDB Atlas and an SMTP provider), retention (`:177-191`: Trash 30 days then removed with previews; "Sign-in sessions, sign-up codes, verification links and rate-limit records expire on their own"; activity log 30 days at `:57-58`; sessions 30 min idle / 12 h at most at `:105-106`; one-time codes "a few minutes"), deletion (`:192-221`) and rights (`:222-233`: informed, access, correct, object, erase/block, under RA 10173, by email).

**Data minimisation: fields collected at sign-up and why.**

| Field | Purpose |
|---|---|
| Email address | identify the account, send one-time codes and security notices |
| Password (stored only as a salted scrypt hash and as wrapping material for the vault key) | authenticate and derive the key that unlocks the vault key |
| Recovery key (shown once, only its scrypt hash stored) | recover the vault when the password is lost |
| `termsAccepted` (boolean, checked then discarded) | consent gate (see gap above) |
| Not collected: name, phone (phone vault was removed), IP address in the activity log, analytics or tracking scripts | n/a |

**User access and deletion.** Export: the browser builds a zip from the authenticated downloads and saves it locally, "We do not see or keep the zip" (`PrivacyPage.jsx:202-206`; code `client/src/utils/zipExport.js`, tests `zipExport.test.js`; endpoint events `account_export`/`export` in `auditTypes.js`). Deletion: `DELETE /api/account` requires session + password-confirmed code + typed email (`account.controller.js:85-122`), then `utils/accountDeletion.js:47-85` deletes, in one transaction where supported: shares and their copies, access rows, share rate-limit rows, code challenges, reset tickets, sessions, trusted browsers, devices, activity log, reminder logs, emergency requests and setup, documents (including Trash), trash folders, folders, backup logs, rate-limit rows keyed by the account id or email, and finally the user.

**Orphan check, local run (this audit).** Populated an account with 3 documents (1 in Trash), a folder, 2 shares (one password-protected, one email-restricted), 2 sessions, 3 devices, 2 trusted browsers and 15 activity events, then deleted it through the API (`DELETE /api/account` -> 200). Then every document of every collection was scanned for the user id, the email, the three document ids and the share ids:

```
rows AFTER deletion: devices 0, trashfolders 0, resettickets 0, otpchallenges 0, loginfailures 0, users 0, shareaccesses 0,
  emergencyaccesses 0, reminderlogs 0, sharedfiles 0, shares 0, trusteddevices 0, backuplogs 0, emergencyrequests 0,
  folders 0, sessions 0, auditevents 0, documents 0, migrations 1 (system marker), ratelimits 9 (IP-keyed rows only)
rows still mentioning the account (id, email, doc ids, share ids): {}
deleted account's token -> 401;  login after deletion -> 401
```

The 9 remaining `ratelimits` rows are keyed by IP address and expire by TTL; the code documents this (`accountDeletion.js:30-31`). Emergency data was not populated in this run; emergency rows are deleted by the same function (`accountDeletion.js:67-68`), and `server/test/account.test.js:48,216` lists `emergencyaccesses` and `emergencyrequests` among the collections it checks after deletion.

**Mapping to the Data Privacy Act of 2012 (RA 10173) principles.**

| Principle | How Warden meets it | Evidence |
|---|---|---|
| Transparency | A privacy page that lists every item collected, who can read what, retention and rights; read-before-agree dialog; user-visible activity log of their own account; share/device notices by email | `PrivacyPage.jsx:12-233`; `SignupPage.jsx:86-118`; `/devices` activity |
| Legitimate purpose | Data is used only to run the vault; no advertising, no sale, no analytics scripts; one-time codes only for the stated actions | `PrivacyPage.jsx:153-165` |
| Proportionality | Minimal sign-up fields; audit log holds ids only (no names, content, emails, IPs); 30-day retention; contents encrypted; sign-up pending state stores only a salted code hash tied to a keyed address hash; account deletion removes everything | `PrivacyPage.jsx:17-25,57-64`; orphan check above |
| Data subject rights | Access/portability (zip export), erasure (self-service deletion), correction (rename files; password change); object/block by email | `PrivacyPage.jsx:192-233` |

**Gaps to close:** record consent (timestamp and policy version) on the user; add the right to lodge a complaint with the National Privacy Commission and a named contact/DPO; add withdrawal of consent and portability wording; the page is labelled a draft; rights other than export and deletion are by email only (manual). **Update (17 October):** consent with policy version is recorded, and the privacy page now has the right to complain to the National Privacy Commission, withdrawing consent and portability. No data protection officer is appointed (student project) and there is still no breach notification procedure. The page is still labelled a draft. The 3.5 verdict is not changed.

---

## 3. PART 2: System Development (30%)

### 2.1 Project design and innovation (12.5): PARTIAL, band 80-89 (60-79 until the justification is written)

Documentation present (repository): `README.md` (42 lines: dev servers and tests), `DEPLOY.md` (217 lines: Atlas, Gmail, Vercel, env variables, cron, security checklist, rollback, smoke test, limits, tested vs untested, token location, index note), `docs/DEMO-EMERGENCY.md` (47 lines: emergency demo mode), `client/.env.example`, `server/.env.example`. A grep for "why", "justif", "NoSQL", "trade-off", "alternative" in these files finds **no written justification for MERN or for the MongoDB/NoSQL choices**. Some rationale lives only in code comments (`config/db.js:1-29` connection caching and pool; `models/RateLimit.js:1-14` why limits are in the database; `models/Session.js:1-14` DB-backed sessions; `utils/migrateIndexes.js:1-14` index migration). A local, git-ignored folder `test-results/` holds `checkpoint2-security-tests.md` and 14 screenshots (not in the repo, so not gradable from it).

Sections to write (marks PARTIAL until they exist): (1) why MERN for this project (one language, JSON end to end, serverless fit); (2) document-per-record model and why not relational (a vault is a set of independent encrypted blobs with a few indexed attributes; wrapped keys live on the user record); (3) TTL indexes instead of cleanup jobs (sessions, codes, rate limits, shares, trash purge `Document.purgeAt`); (4) the HMAC-chained audit log (`AuditEvent` `userId+seq` unique, `auditHead` on the user); (5) unique-index race protection (`Folder`, `RateLimit`, `ReminderLog`, `EmergencyRequest` partial unique, `OtpChallenge.subjectKey` partial unique) with the tests that prove them (`signup-flow.test.js:267`, `login-lockout.test.js:71`); (6) alternatives considered (Postgres, object storage) and the trade-offs.

Original or distinctive features (all with tests):
- Emergency Access with a 2-of-2 key split (kit + server half), waiting period, owner veto by one click, deny-by-default read-only scoped sessions (`utils/emergency/*`, `middleware/emergencyGuard.js`, `server/test/emergency*.test.js`).
- Purpose watermark on share links, kept only inside the encrypted manifest (`server/test/expiry-health.test.js:449,490,507`).
- Tamper-evident, HMAC-chained activity log with a verify endpoint (`POST /api/security/verify-log`; live: `{"ok":true,"checked":11,"brokenAtSeq":null}`; `server/test/audit-limits.test.js`, `devices-audit.test.js`).
- Vault health score of nine weighted checks that sum to 100 with action links (`utils/vaultHealth.js:24-34`).
- Gated share links (email code, password verifier, download limit) with the key in the URL fragment so the server never serves plaintext.
- Document expiry reminders by email that carry a count, never a file name.

### 2.2 MERN development and integration (22.5): PASS, band 80-89

- **Schemas and indexes.** 19 Mongoose models. `server/test/index-coverage.test.js` builds every index on an empty database and compares it with the declarations including unique, partial, sparse and TTL options (mutation-tested: skipping one model fails it). Full list:

| Model | Indexes (U = unique, TTL = expireAfterSeconds 0) |
|---|---|
| AuditEvent | userId+seq U; userId+at; userId+type+at; expiresAt TTL |
| BackupLog | userId |
| Device | userId; userId+deviceIdHash U |
| Document | docExpiresAt; userId+folder; userId+checksum; userId+deletedAt+createdAt; userId+deletedAt+sniffedType; userId+deletedAt+docExpiresAt; trashBatchId sparse; purgeAt TTL |
| EmergencyAccess | userId U |
| EmergencyRequest | accessId; userId; accessId+active U partial(active:true); denyTokenHash sparse; expiresAt TTL |
| Folder | userId+parentPath+nameKey U |
| LoginFailure | key U; expireAt TTL |
| OtpChallenge | userId; shareId; expiresAt TTL; subjectKey U partial(string) |
| RateLimit | bucket+key U; windowExpiresAt TTL |
| ReminderLog | userId+fileId+threshold U |
| ResetTicket | userId; tokenHash U; expiresAt TTL |
| Session | sessionIdHash U; userId; deviceId; emergency; expiresAt TTL |
| Share | shareId U; ownerUserId; sourceDocumentIds; expiresAt TTL |
| ShareAccess | shareId; tokenHash U; expiresAt TTL |
| SharedFile | shareId+fileId U; expiresAt TTL |
| TrashFolder | userId; batchId U; purgeAt TTL |
| TrustedDevice | userId; tokenHash U; deviceId; expiresAt TTL |
| User | email U |

  The migration is idempotent and runs once per set of indexes (marker `indexes-<hash>`, `utils/migrateIndexes.js`); `autoIndex` is off (`config/db.js:14`).
- **REST design.** Resource nouns (`/documents`, `/shares`, `/trash`, `/security/devices`), verbs match intent, `201` on create, `204` on delete (live: trash delete 204, share create 201), `400/401/403/404/409/413/429` used consistently, errors share one JSON shape (`middleware/errorHandler.js`). Pagination: the activity log pages with `before`/`limit` (`security.controller.js:183-190`); **`GET /api/documents` returns every live document with no paging** (2,000 documents in the measurement), and the client mitigates by drawing rows progressively (`client/src/utils/useProgressiveList.js`). Insights lists are capped (`insights.controller.js:13,17`).
- **Validation and error middleware.** See 3.1: global JSON limit, sanitiser, per-handler checks, `notFound` and `errorHandler` (`errorHandler.js`).
- **Responsive frontend.** 64 CSS modules; breakpoints used: `min-width` 1024 (10), 900 (7), 560 (4), 820, 768, 640 and `max-width` 560 (6) and 767; `viewport` meta (`client/index.html:5`); keyframes or `prefers-reduced-motion` rules in 10 stylesheets; `aria-live`/`role="alert"` in 50 components. **There is no automated responsive test**; widths 360 and desktop were checked by hand with screenshots earlier in the project (local, not in the repo). Present this as manual verification.
- **Client API layer.** One axios instance (`client/src/services/api.js`) with a request interceptor that adds the bearer token, a response interceptor that clears the session on 401 `SESSION_INVALID` and invalidates the in-memory cache after every write, one service module per resource, an in-memory stale-while-revalidate cache (`services/dataCache.js`) with tests (`cache-safety.test.js`, `utils/perf.test.js`). Navigation never reloads the page (verified: window marker survived 9 sidebar navigations; static test forbids plain `<a href>` for internal links).

### 2.3 Security, scalability, code quality (15): PARTIAL, band 80-89

- **Tests:** 414 server + 302 client = 716, in 72 files; DB-backed tests use a local throwaway MongoDB and are skipped with a reason when none runs (`test/helpers/realMongo.js`), real-HTTP tests for the whole app (`cross-user.test.js`, `rate-limit-headroom.test.js`).
- **Structure:** `server/{config,controllers,middleware,models,routes,utils,scripts,test}`, `client/src/{components,pages,services,utils}`, `api/index.js` for Vercel, `docs/`. Clear and conventional.
- **Lint:** none. No ESLint/Prettier config exists in the repo or either package; the code carries `eslint-disable` comments for a tool that is not installed. **Update (17 October): ESLint now exists.** `npm run lint` in `client` and `server` (recommended rules only). It reports no errors. The server has some old warnings that we left alone.
- **Large files (over 600 lines):** `client/src/pages/FilesPage.jsx` 941, `server/controllers/documents.controller.js` 926, `server/utils/emergency/service.js` 680, `server/controllers/shares.controller.js` 621, `client/src/pages/SharedDocumentPage.jsx` 620, `client/src/pages/auth/ForgotPasswordPage.jsx` 619 (plus `auth.module.css` 646 and four test files).
- **Dead code:** `client/src/components/FolderTile.jsx` (+ `.module.css`) and `client/src/utils/documentSort.js` are imported nowhere (crude import scan, confirmed by grep). Scripts under `scripts/` and `server/scripts/` are command-line entry points, not dead. `api/index.js:8-9` still carries a stale "UNVERIFIED ... not exercised against an actual Vercel deployment" comment.
- **Commit history:** 96 commits over eight weeks, conventional prefixes (`feat:`, `fix:`, `perf:`, `test:`, `docs:`) in recent history; a few early messages are imperative sentences without a prefix and several subjects are very long (one commit bundles a whole security review).
- **Security regression guards in tests:** `index-coverage`, `session-parallel`, `rate-limit-headroom`, `cross-user`, `emergency-allowlist`, `login-lockout`, `error-handler`, `log-privacy`, `enumeration-timing`.

### 2.4 System integration and visualization (20): PARTIAL, band 60-79

**Data workflow, end to end.**

| Stage | What happens | Endpoints / components |
|---|---|---|
| Ingestion | Upload one file (4 MB cap, quota 25 MB) or import a zip in the browser (bomb/traversal checks) | `POST /api/documents` (`documents.controller.js:137`, multer `routes/documents.routes.js:33`); `client/src/utils/zipImport.js`, `FilesPage.jsx` upload UI |
| Processing | Type sniffing, AES-256-GCM encryption with the account key, thumbnail generation in the browser and upload of the preview, expiry date parsing | `utils/sniff.js`, `utils/crypto.js:166-174`, `PUT /api/documents/:id/thumbnail`, `utils/thumbnails.js`, `utils/docExpiry.js` |
| Storage | Ciphertext and wrapped keys in MongoDB; folders, trash batches, shares with encrypted copies | `models/Document.js`, `Folder.js`, `TrashFolder.js`, `Share.js`, `SharedFile.js` |
| Analytics | Counters on documents (`viewCount`, `downloadCount`, `lastOpenedAt`), activity events, share open counts, vault health facts | `GET /api/insights/overview|frequent|stale`, `GET /api/account/health`, `GET /api/security/activity`, `POST /api/security/verify-log`; `OverviewPage.jsx`, `VaultHealthCard.jsx`, `DevicesPage.jsx` |
| Decision support | Expiry reminders by email, banners, health-score items with a "fix" link, stale-file cleanup, suspicious-activity flags | `GET /api/cron/reminders` (daily 01:00 UTC, `vercel.json:15-18`), `ExpiringBanner.jsx`, `VaultHealthCard.jsx:92-94`, `OverviewPage.jsx:43,67-73` |

**Overview page as a dashboard** (`client/src/pages/OverviewPage.jsx`, 238 lines):

| Element | Shows | Leads to an action? | Decision supported |
|---|---|---|---|
| Vault health ring + nine-row checklist (`VaultHealthCard.jsx:61-94`) | score out of 100, per-check status and points lost | Yes: every row has a "fix" link to the page that resolves it | what to fix first to improve security hygiene |
| Expiring documents card (`:125-141`) | documents expired or within 60 days, soonest first | Yes: opens the file | renew or remove documents before they lapse |
| Most viewed / Most downloaded / Recently opened (`:144-157`) | top 5 / top 5 / last 10 | Opens the file | which documents matter, quick access |
| Not opened in 180 days (`:159-170`) | count, and a clean-up dialog (`:67-73`) | Yes: select and move to Trash | free space, reduce what is stored |
| Sharing (`:172-189`) | active links, never opened, expiring within 7 days, most opened | Yes: "Manage share links" | stop links no longer needed |

**Weaknesses against "clear, effective and decision-focused":** apart from the score ring there is no chart; no trend over time (everything is a current count or a ranked list), so a user cannot see whether things are improving; no comparison or distribution (storage by type or folder, activity by day); the health-score weights are a design choice, not derived from data (`vaultHealth.js:24-34`); the Overview and the health card are two separate calls and two visual styles; no way to export the analytics. Presented honestly, this is a "decision checklist", not a dashboard with visualisations.

### 2.5 Analytics implementation (17): PARTIAL, band 60-79

**Analytics objective, as the code implies it:** help one person keep a private document vault in good order: know which files are used, which are stale or about to expire, which share links are still exposed, and whether their account settings are safe. It is descriptive and personal; there is no cross-user analytics by design.

All metrics, source and formula. Every one was exercised on real data against the local database in this audit (3 documents, views, a download, a share, an expiry date): `GET /api/insights/overview|frequent|stale`, `GET /api/account/health`, `/documents/expiring`, `/documents/storage`, `/security/verify-log`, `/security/activity` all returned 200 with the expected values.

| Metric | Data source | Formula |
|---|---|---|
| Most viewed (top 5) | `Document.viewCount` | sort by `viewCount` desc, ties by `lastOpenedAt` (`insights.controller.js:113`) |
| Most downloaded (top 5) | `Document.downloadCount` | same, by `downloadCount` (`:114`) |
| Recently opened (10) | `Document.lastOpenedAt` | newest first (`:115`) |
| Frequently used (5) | `AuditEvent` `view` events, last 30 days | `$match` userId/type/`at >= now-30d`, `$group` by target, `$sort` opens desc, `$limit 50`; falls back to newest-opened (`:44-75`). Live: alpha.txt 3 opens, beta.txt 1. |
| Stale files | `lastOpenedAt` else `createdAt` | idle at least 180 days, oldest first, listed up to 300 (`:12,77-84,128-133`) |
| Sharing stats | `Share` rows (`openCount`, `lastOpenedAt`, `expiresAt`) | active = live shares; never opened = `openCount` 0; expiring = within 7 days; most opened = max `openCount` (`:87-103`) |
| Storage use | live and Trash bytes | sum of sizes versus quota (`utils/storage.js`; live: 1,950 of 26,214,400 bytes) |
| Expiry status | `docExpiresAt` | days until expiry, thresholds 60/30/7/0 days (`utils/docExpiry.js`; live: gamma.txt "expiring_soon", 5 days) |
| Vault health, nine checks | shares, trusted browsers, activity flags, documents, settings, Trash | `100 - sum(points)`; per-item max 15/10/10/10/25/15/5/5/5 (open shares, old shares, trusted browsers, stale trusted browsers, unusual activity, expired docs, expiring docs, reminders off, trash near purge); "warn" costs half, "bad" all (`vaultHealth.js:24-34,40-44,96-98`). Live: 1 open link (-15) + 1 document expiring (warn, -2) = **83**. |
| Log integrity | `AuditEvent` HMAC chain | verify sequence and hashes (`security.controller.js`; live `ok:true, checked:11`) |

Tests for these: `server/test/expiry-health.test.js:351,365,405` (health weights and boundaries, endpoint), `devices-audit.test.js` (Overview and frequently used), `perf-server.test.js` (the Mongo-side frequent aggregation). Tests use the in-memory fake or a local database; the live check above used real HTTP and real data.

**Gaps (reported, not added):** no stated objective in any document; no time series (no daily/weekly activity, no storage growth); no analytics export; the weights are heuristic; "unusual activity" depends on flags computed elsewhere (`utils/suspicious.js`) and has no measured false-positive rate.

### 2.6 Scalability, ethics, governance (13): PARTIAL, band 60-79

**Bottlenecks and what changes at 10x users.**

| Bottleneck | Evidence in the repo | Scaling strategy |
|---|---|---|
| Vercel body limit 4.5 MB per request/response | file cap 4 MB (`routes/documents.routes.js:28-33`), JSON cap 100 KB (`server.js:101`) | Direct-to-object-storage uploads (presigned URLs) so files bypass the function; keep encryption client-side or in a worker |
| Per-account quota 25 MB, share caps 20 MB / 60 MB / 20 shares | `utils/storage.js:5,24`, `utils/shareLimits.js:6-8` | Raise quota with object storage; meter by plan |
| Atlas M0 (512 MB storage) | all ciphertext lives in MongoDB documents. At the default quota roughly 20 full accounts fill 512 MB (512 / 25), derived, not measured | Paid Atlas tier or move blobs to object storage and keep metadata in MongoDB |
| Atlas M0 connections (500) | `maxPoolSize: 5` per function instance (`config/db.js:25`) so about 100 concurrent warm instances | Dedicated tier; connection pooling proxy |
| Atlas M0 operations/second ceiling (external fact, not measured here) | rate limiting and session slide are database writes on every request (`rateLimit.js:26`, `requireSession.js:49`) | Cache sessions, move limiters to Redis/Upstash or the edge, reduce per-request writes |
| Serverless cold start | `server.js:61` connects on load; every request awaits `connectDB()` which includes the index migration and three other start-up checks (`server.js:132-137`, `config/db.js:51-66`). Steady state is one marker read (about 6 ms in `index-coverage.test.js`); on the deploy that changes an index the first requests wait for the build. Real Vercel cold-start time was **not measured** (UNVERIFIED) | Keep indexes unchanged between deploys; run migrations in a deploy step instead of at request time |
| `GET /api/documents` is unpaged | measured 2,000 documents: 142 ms median locally, whole list in one JSON | Server-side pagination or cursor, search on the server |
| Zip import memory | runs in the browser, inflates one file at a time into memory, with bomb/entry/depth limits (`client/src/utils/zipImport.js:10-17`, tests `:51-175`), so server memory is not affected | none needed server-side; cap total size already enforced |
| Cron on the free tier | two daily jobs only (`vercel.json:10-19`); Hobby allows daily schedules | Move reminders to a queue/worker when volume grows; reminders already cap emails per run (`expiry-health.test.js:215`) |
| Outbound email | free Gmail SMTP through nodemailer (`utils/email.js`) | Transactional provider (SES, Postmark, Resend) with a queue and retries; separate sender for login codes |

**Email capacity (no change made).** The commonly documented limit for a free Gmail account is about 500 recipients per day (external fact, check before quoting). Every email-sending route is limited per IP and/or per address (table in 3.2), for example `signup/start` 10 per hour per IP and 5 per hour per address, but **there is no global or per-day cap anywhere** (grep of `utils/email.js`, `otpChallenge.js`, `rateLimit.js` for a daily/global limit found none). What an attacker can do: with `SIGNUP_MODE=open`, many addresses or many IPs (an IPv6 /64 counts as one IP) can send sign-up, reset and sharing-code emails until the shared daily cap is used. What happens to real login codes: `sendEmail` returns false when the provider refuses, and the login challenge then fails with an "we couldn't send the code email" error (`utils/otpChallenge.js:134,257`), so real users cannot get a code until the cap resets. Mitigations already present: the default sign-up mode is `invite` (`utils/inviteGate.js:30-32`, invite failures limited 5 per 15 min per IP), so unauthenticated bulk sign-up is closed in the default mode; login codes are only sent after the password is verified, so an attacker cannot make a victim's login mail without the password; per-account code mails are capped at 5 per hour (`otpChallenge.js:40`). Remaining exposure is `SIGNUP_MODE=open`, password-reset start (10 per hour per IP, 5 per hour per address) and the emergency/share code mails. This is the strongest scalability risk in the project.

**Update (17 October): a daily cap now exists.** `server/utils/mailBudget.js` keeps one counter per UTC day in the database. `MAIL_DAILY_CAP` defaults to 300. Bulk mail (sign-up codes, expiry reminders, new-device notices, share codes) stops at `MAIL_BULK_SHARE` of that (0.5, so 150), and login codes, reset codes and security notices may use the rest. At the bulk limit `signup/start` answers 503 "busy" for everyone. This is the fix listed as C4 below. Live sign-up is in open mode (the owner confirmed this on 14 October), so the cap matters. The risk is reduced, not removed: a flood can still use up the bulk share.

**Performance evidence (prompts 31P and 31Q, measured locally on 2,000 seeded documents; real Atlas latency and Vercel cold starts were not measured).**
- Time to first file row at 4x CPU throttling and Slow 4G: about 6.6 s before, about 3.0 s after (first row), 400 rows by about 4.8 s; skeleton visible at about 1.3 s. Page API calls start at +0 to 35 ms in parallel (previously about +1.46 s, sequential).
- Full-page reloads on sidebar navigation: 0 (window marker survived 9 navigations); app no longer hidden during navigation (previously 70-347 ms).
- Main bundle 373.8 kB (358.4 kB before; about 15 kB added for cache, skeletons, error boundary).
- Index coverage: 19 models, all declared indexes built and compared (`index-coverage.test.js`); MongoDB profiler during a visit to every page shows no collection scan (all queries use an index).
- Median local server times: insights/overview 203 ms, security/activity 147, documents list 142, account/health 132, insights/frequent 95, folders 70, expiring 49, emergency/status 47, trash 39, devices 35, folder children 35, auth/me 32, shares 26.
- Rate-limit headroom: two pages exhausted shared budgets (Emergency status polling at 60/hour; Settings trusted-browser list at 10/hour). Both were fixed in 31Q with separate read budgets and tests (`rate-limit-headroom.test.js`).

**Governance.**

| Area | Policy in the code |
|---|---|
| Retention | Trash 30 days then purged by TTL `Document.purgeAt` (`utils/trash.js`); activity log 30 days (`utils/auditConfig.js`, `AUDIT_RETENTION_DAYS` 1-365); sessions 30 min idle / 12 h; codes about 5 min; trusted browsers 30 days; rate-limit rows reaped by TTL |
| Audit trail | HMAC-chained per-account log of 36 event types, verified on demand; ids only, no content or addresses |
| Emergency access policy | opt-in; 2-of-2 key split; waiting period 3/7/14 days; owner emailed and can deny by one click; 24 h cool-off after a denial; read-only, folder-scoped, 4 h sessions; every action logged to the owner (`PrivacyPage.jsx:72-82`) |
| Sign-up mode | `SIGNUP_MODE` must be set to `invite` or `open` in production or the server refuses to start (`utils/productionConfig.js:42-47`); default `invite` |
| Who can see what | Owner: everything of their own. Operator with database access: metadata (names, sizes, dates, emails) and ciphertext, not file contents unless they also hold a session token or the emergency kit. Share recipient: only the shared copies, decrypted in their browser. Emergency contact: the scoped folders, read-only, after the waiting period. |

Ethical concerns and mitigations: (1) an operator can read metadata -> stated plainly in the privacy page and kept to what the vault needs; (2) emergency access could be abused to take a vault -> two-factor key split, mandatory owner notice (the request is refused if the notice cannot be sent), waiting period, one-click deny, activity log; (3) shared links can leak -> keys in the fragment, optional email and password gates, download limits, expiry, health check flags open links; (4) children/consent -> not addressed in the product; (5) a student prototype holding real documents -> invite-only default, a quota, stated "as-is" disclaimer; (6) document names are not encrypted -> disclosed. Not addressed: no named data-protection officer, no breach-notification procedure (RA 10173 requires notifying the NPC and affected people), no incident-response document.

---

## 4. Documents the rubric needs that cannot be checked in the repo (Step 3)

Exist in the repo: `README.md`, `DEPLOY.md`, `docs/DEMO-EMERGENCY.md`, two `.env.example` files, and the in-app Terms and Privacy pages (`client/src/pages/public/TermsPage.jsx`, `PrivacyPage.jsx`). A git-ignored local folder `test-results/` has `checkpoint2-security-tests.md` and figures (homepage, lockout, authorised/unauthorised function, weak password, deployed frontend, backend API, rate limit); it is not tracked, so it will not be in a repo-based check unless committed.

Not present and not checkable here (do not invent): **Part 1** (problem statement, research questions, quantitative methods, data collection, findings, system justification); the individual assessment; a survey or user-testing report; the written MERN/NoSQL justification (2.1); an architecture diagram, data-flow diagram and ER/schema diagram; a threat model and the role matrix as a document; a user manual; an API reference; a test report summarising the 716 tests; the defense slides. The prompt's statement that Parts 2 and 3 are checked against the repo means those documents matter for Part 1 and the paper, not for the repo check.

---

## 5. Ranked fix list

Effort: S = under half a day, M = one to two days, L = more.

**Critical (could cap a criterion at a lower band)**

| # | Fix | Effort | Raises |
|---|---|---|---|
| C1 | Write `docs/DESIGN.md`: MERN and NoSQL justification (the six sections listed in 2.1), architecture and data-flow diagrams, alternatives considered | S-M | 2.1, 2.6 |
| C2 | Put the role and permission matrix (section 3.3) and the rate-limit table (3.2) into the paper/docs | S | 3.3, 3.2 |
| C3 | Record consent on sign-up (`termsAcceptedAt` and policy version on the user) and add NPC complaint right, named contact, consent withdrawal and portability to the privacy page | S | 3.5 | **Done (17 October):** consent and policy version stored; NPC complaint right, consent withdrawal and portability added.
| C4 | Protect login codes from the email cap: add a global/daily send counter that stops bulk sign-up, reset and share-code mail before the provider cap is reached and reserves headroom for login codes; keep `SIGNUP_MODE=invite` for the demo | M | 2.6, 3.2 | **Done (17 October):** `MAIL_DAILY_CAP` and `MAIL_BULK_SHARE` (see the 2.6 update).

**Should fix before Oct 20**

| # | Fix | Effort | Raises |
|---|---|---|---|
| S1 | Log lockouts, wrong-code bursts and 429s as scrubbed server-log lines with a hashed key (no addresses) and, for the owner, as account events | S | 3.1, 3.2 | **Done (17 October):** `server/utils/securityLog.js`.
| S2 | Add an HTTP-level test that sends operator, array and wrong-type payloads to every owner route (reuse the probe list in section 3.1) and asserts 4xx | S-M | 3.1 |
| S3 | Add the two named cross-user cases from 3.3 (access token of share A on share B; emergency token on owner-only emergency routes) | S | 3.3 |
| S4 | Upgrade `react-router-dom` to a version that clears GHSA-wrjc-x8rr-h8h6 (v7 is a breaking change; check routing code) or document why it is not exploitable (all `<Link>` targets are internal constants) | S-M | 3.4 |
| S5 | Add charts to the Overview: activity per day (from the audit log), storage by file type, and a health-score trend; add one sentence stating the analytics objective on the page and in the docs | M | 2.4, 2.5 |
| S6 | Add ESLint (with the rules the code already assumes) and fix what it flags; delete `FolderTile.jsx`, `FolderTile.module.css`, `documentSort.js`; remove the stale comment in `api/index.js:8-9` | S-M | 2.3 | **Done (17 October):** ESLint added; `FolderTile.jsx` and `documentSort.js` no longer exist.
| S7 | Paginate `GET /api/documents` (cursor) or at least cap and sort on the server; keep the progressive rendering | M | 2.2, 2.6 |
| S8 | Add an automated responsive check (Playwright at 360, 768, 1280 on the main pages) and commit the screenshots or results | M | 2.2 |
| S9 | Commit the evidence folder (`test-results/` is git-ignored): at least the markdown test notes | S | 2.3, 3.x |
| S10 | Verify and record the production Set-Cookie header (with `Secure`) and the HSTS header on the deployed site (curl the live URL) | S | 3.2, 3.4 |

**Optional**

| # | Fix | Effort | Raises |
|---|---|---|---|
| O1 | Authenticator-app (TOTP) as a second MFA option | L | 3.2 |
| O2 | Escalating lockout and a per-IP component so a known address cannot be locked out indefinitely by an attacker | M | 3.2 |
| O3 | Split `FilesPage.jsx`, `documents.controller.js`, `emergency/service.js` into smaller modules | M | 2.3 |
| O4 | Central request-validation layer (a small schema helper) instead of per-handler checks | M | 3.1, 2.3 |
| O5 | OpenAPI description of the 66 authenticated routes | M | 2.2 |
| O6 | Analytics export (CSV of own activity and metrics) | S | 2.5 |
| O7 | Object storage with direct uploads; transactional email provider with a queue | L | 2.6 |
| O8 | Breach-notification and incident-response one-pager | S | 3.5, 2.6 |

---

## 6. What to say at the defense (only claims the evidence supports)

- **3.1 Input validation and error handling.** "Every route checks types by hand, there is a 100 KB JSON limit and a NoSQL-operator sanitiser; 25 hostile requests, including operator injection, path traversal and a 5 MB upload, all got 4xx. A forced server fault returns a fixed message and a request id with no stack, address or connection string. We also know our gaps: security events like lockouts and 429s are not logged yet." (`errorHandler.js:21-39`, `error-handler.test.js`, section 3.1)
- **3.2 Authentication.** "Passwords use scrypt at N=2^15 with a random salt. Login has an atomic 3-attempts-then-lock rule, an emailed 6-digit code with a five-minute life, five guesses and three resends, and it cannot be switched off in production. No account exists until the sign-up code is entered. Sessions slide for 30 minutes but never past 12 hours, and logout deletes the session on the server. All rate limits are stored in the database, not in memory." (`crypto.js:22`, `otpConfig.js:25-31`, `signup-flow.test.js:84`, `session-parallel.test.js`)
- **3.3 Authorization.** "There is no role field; access is decided by who holds the session, a share link with its gates, or a scoped emergency session. Every owner query filters by the server-side user id, the client never supplies one, and a test calls all 66 session routes as the wrong user. Emergency sessions can reach exactly eight routes, read-only, inside the chosen folders." (`cross-user.test.js`, `emergencyGuard.js:18-27`, matrix above)
- **3.4 Data protection.** "Files are AES-256-GCM encrypted with a per-account key that is only stored wrapped; IVs are random and auth tags are checked. We scanned the working tree and all 96 commits for keys and credentials and found placeholders only. We are not end-to-end encrypted: the server sees plaintext while it works, file names are readable, and the activity log cannot detect deletion of its newest entries. We say so in the privacy page." (`crypto.js:27-28,166-194,253-264`, section 3.4)
- **3.5 Privacy.** "Consent is a read-before-agree checkbox; the privacy page lists everything we collect, why, how long we keep it and the user's rights under RA 10173. A user can export their files and delete their account; we deleted a populated account and scanned every collection: nothing referencing it remained except IP-keyed rate-limit rows that expire on their own." (`SignupPage.jsx:371-396`, `PrivacyPage.jsx`, orphan check above). Do not claim recorded consent until C3 is done.
- **2.1 Design and innovation.** "Distinctive features are emergency access with a two-part key and a waiting period, a purpose watermark on share links, a tamper-evident activity log and a vault health score." Do not claim a written NoSQL justification until C1 exists.
- **2.2 MERN integration.** "19 Mongoose models; a test builds all indexes on an empty database and compares them with the schema, including unique, partial and TTL options. The REST API uses consistent status codes and one error shape; the client has one API layer, an in-memory cache that is cleared on logout, 401 and account switch, and never reloads the page on navigation." (`index-coverage.test.js`, `cache-safety.test.js`)
- **2.3 Code quality.** "716 automated tests; a clear folder structure; 96 commits with conventional messages. Known weaknesses: no linter, three source files over 600 lines, two unused files." (Step 0, section 2.3)
- **2.4 Integration and visualization.** "Data flows from upload through encryption and type checks into MongoDB, then into counters and an activity log that feed the Overview, the health score and daily expiry emails. The Overview is a decision checklist with action links; it has one graphic, the score ring, and no trend charts yet." Do not call it a visual dashboard.
- **2.5 Analytics.** "We compute usage metrics (most viewed, downloaded, recent, frequent, stale), sharing statistics, storage and a nine-check health score of 100 points; all returned correct values on real data in a local run. They are descriptive, per-user and current-state only; there is no time series or export." (live check, section 2.5)
- **2.6 Scalability, ethics, governance.** "Locally, with 2,000 documents, the first file row appears in about 3 seconds under 4x CPU and Slow 4G, with no collection scans. The limiting factors are the Vercel 4.5 MB body limit (we cap files at 4 MB), the 512 MB Atlas free tier (about 20 full 25 MB accounts), and the free email cap, which has no global guard yet. At ten times the users we would move files to object storage, upgrade Atlas, queue mail through a transactional provider and cache sessions." Real Vercel cold starts and Atlas latency were not measured; say so.
