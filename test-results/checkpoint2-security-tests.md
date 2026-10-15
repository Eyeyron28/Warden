> **Historic snapshot, 2026-09-22, redacted.** This is the original Checkpoint 2 run, kept as evidence of how the checks were done.
> Tokens, recovery keys, passwords, hash prefixes, LAN addresses and local paths were removed before it was added to the repository.
> The app has changed since: the per-file cap is now 4 MB (not 20 MB), `POST /api/auth/setup` was replaced by the two-step sign-up
> (an emailed code first), and every account has its own vault. The lockout (3 attempts, then 5 minutes) and the other checks still
> behave as described. Current behaviour is covered by the automated tests in `server/test` and `client/src`.

# Warden — Checkpoint 2 Security Tests

**Run date:** 2026-09-22
**Backend under test:** `server/server.js`, started directly with `MONGO_URI` overridden via shell environment variable to `mongodb://localhost:27017/warden_checkpoint_test`, `PORT=5000` (HTTPS, as normal). The real `warden` database was never opened for writes at any point — see "Safety / cleanup" at the bottom for the read-only proof.
**Frontend under test:** `client`, started normally with `vite --host` (port 5173, HTTPS via the project's mkcert cert).
**TLS validation:** all Node-side HTTPS calls in this run had `NODE_EXTRA_CA_CERTS` set to the mkcert root CA (the mkcert root CA, from `mkcert -CAROOT`), so certificates were genuinely verified, not bypassed.
**No app code was changed and nothing was committed for this task.**

One incidental non-app-code fix was needed to get the UI screenshots working at all: `client/.env`'s `VITE_API_BASE_URL` was still pointing at a stale LAN IP (`<LAN IP>`) from a previous Wi-Fi network; the PC is currently on `<LAN IP>`. This is the same class of issue documented in `server/server.js`'s cert-SAN comment. It was updated to the current IP and the Vite dev server restarted so the frontend could reach the backend for screenshots. This is a config value, not application code, and is unrelated to the throwaway database.

---

## Test 1 — Invalid Input (setup, fresh DB)

**Procedure:** `POST /api/auth/setup` with `{"password":"password1234"}` against a fresh (no user yet) `warden_checkpoint_test`. Then `POST /api/auth/setup` again with a strong password and keep the returned session token for later tests.

**Expected:** 400 with password-policy errors for the weak password; 201 with a session token for the strong one.

**Actual:**

Weak password — `HTTP 400`
```json
{
  "success": false,
  "error": {
    "message": "Password does not meet the security requirements.",
    "status": 400,
    "errors": [
      "Must include an uppercase letter.",
      "Must include a special character.",
      "Must not contain a common word or password.",
      "Must not contain a sequential or repeated pattern (e.g. 1234, aaaa)."
    ]
  }
}
```

Strong password (a test value, not recorded here) — `HTTP 201`
```json
{
  "sessionToken": "<redacted>",
  "recoveryKey": "<redacted>"
}
```

**Result: PASS**

---

## Test 2 — Invalid Input (21 MB upload)

**Procedure:** `POST /api/documents` (authenticated) with a generated 21 MB in-memory file.

**Expected:** 413 with the message "File exceeds the 20MB size limit."

**Actual:** `HTTP 413`
```json
{
  "success": false,
  "error": {
    "message": "File exceeds the 20MB size limit.",
    "status": 413
  }
}
```

**Result: PASS**

---

## Test 3 — Protected API Without Token

**Procedure:** `GET /api/documents` with no `Authorization` header.

**Expected:** 401.

**Actual:** `HTTP 401`
```json
{
  "success": false,
  "error": {
    "message": "Missing or invalid Authorization header.",
    "status": 401
  }
}
```

**Result: PASS**

---

## Test 4 — Password Storage Check

**Procedure:** Connected directly to `warden_checkpoint_test` with the `mongodb` driver (not the app) and listed the field **names** on the one `users` document.

**Expected:** No plain password field, no unwrapped encryption key field.

**Actual:**
```json
{
  "fieldNames": [
    "_id", "passwordHash", "salt", "recoveryKeyHash",
    "wrappedDEKPassword", "wrappedDEKPasswordIv", "wrappedDEKPasswordAuthTag",
    "wrappedDEKRecovery", "wrappedDEKRecoveryIv", "wrappedDEKRecoveryAuthTag",
    "failedAttempts", "createdAt", "__v"
  ],
  "hasPlainPasswordField": false,
  "hasUnwrappedKeyField": false,
  "passwordHashPrefix": "<redacted>"
}
```
Only a hash (`passwordHash`) and AES-GCM-wrapped copies of the DEK (`wrappedDEKPassword*`, `wrappedDEKRecovery*`) are stored — no `password` field, no bare `dek`/`key` field. Only a short prefix of `passwordHash` was printed, and it is redacted here.

**Result: PASS**

---

## Test 5 — Secure Error Response

**Procedure:** Uploaded a small real document, created two share links for it, then hit `GET /api/shared/:token` for:
(a) a made-up random token,
(b) a real share revoked via `POST /api/shares/:token/revoke` (the real API, same as the owner clicking "revoke"),
(c) a real share whose `expiresAt` was set directly in `warden_checkpoint_test` to 60s in the past.

**Expected:** Same generic status/message for all three, no stack trace.

**Actual:** All three — `HTTP 404`
```json
{
  "success": false,
  "error": {
    "message": "This link is invalid or has expired.",
    "status": 404
  }
}
```
Identical status and message across fake/revoked/expired, no distinguishing detail, no stack trace in any response body.

**Result: PASS**

*(Waited 60s after this step before Test 7, so the shared-token rate limiter's window — shared across this whole IP — was fully reset before the clean 11-request count.)*

---

## Test 6 — Invalid Login (lockout)

**Procedure:** `POST /api/auth/unlock` with a wrong password 3 times in a row, then once more with the correct password.

**Expected (as stated in the test plan):** 401 × 3, then locked (with `lockedUntil`/`minutesRemaining`), and the correct password also refused.

**Actual — wrong attempt 1:** `HTTP 401`
```json
{ "success": false, "error": { "message": "Incorrect password.", "status": 401 } }
```
**Actual — wrong attempt 2:** `HTTP 401`
```json
{ "success": false, "error": { "message": "Incorrect password.", "status": 401 } }
```
**Actual — wrong attempt 3:** `HTTP 403` (not 401 — see note below)
```json
{
  "success": false,
  "error": {
    "message": "Too many failed attempts. Try again in 5 minutes.",
    "status": 403,
    "locked": true,
    "lockedUntil": "2026-09-22T15:09:34.280Z",
    "minutesRemaining": 5
  }
}
```
**Actual — correct password while locked:** `HTTP 403` (same lockout body as above, `minutesRemaining: 5`) — the password was never even checked, since the lockout check runs before password verification.

**Note on the discrepancy:** the test plan's phrasing ("401 x3, then locked") reads as if the lockout is a separate 4th state. In the actual implementation (`server/controllers/auth.controller.js`, `FAILED_ATTEMPTS_LOCKOUT_THRESHOLD = 3`), crossing the threshold **on** the 3rd failure immediately locks the account and returns `403` with the lockout body on that same request, rather than a plain `401`. So the real sequence is `401, 401, 403(locked)`, and the 4th (correct-password) request is also `403(locked)`. This is arguably tighter than the plan's literal wording (the lockout engages one request earlier, and even the right password is rejected immediately), so it's reported as a pass on the underlying security property — but the exact status-code sequence differs from the plan's literal text, which is why it's called out explicitly rather than silently matched.

UI confirmation: with the lockout still active, the unlock screen (`/`) was loaded and any password submitted — it showed **"Too many failed attempts. Try again in 3 minutes."** live in the form (see `fig2-lockout.png`).

**Result: PASS** (lockout triggers correctly, correct password is refused while locked, `lockedUntil`/`minutesRemaining` present — status-code sequence differs from the plan's literal "401 x3" wording, noted above rather than glossed over)

---

## Test 7 — Rate Limit

**Procedure:** `GET /api/shared/fake-token` 11 times within one minute, from the same IP, after the 60s cooldown following Test 5.

**Expected:** Request 11 returns 429 "Too many requests. Please try again shortly."

**Actual:** Requests 1–10 → `HTTP 404` (generic invalid-link body, expected since `fake-token` doesn't exist — the limiter itself doesn't reject them). Request 11 → `HTTP 429`
```json
{
  "success": false,
  "error": {
    "message": "Too many requests. Please try again shortly.",
    "status": 429
  }
}
```
Screenshot: `fig10-rate-limit.png`.

**Result: PASS**

---

## Test 8 — HTTPS Check

**Procedure:** `GET https://<LAN IP>:5000/api/health` (this PC's actual current LAN IP — `ipconfig` was checked directly, since `server/.env`'s `LAN_IP` value was stale) with `NODE_EXTRA_CA_CERTS` set to the mkcert root CA, so Node's default strict TLS validation (`rejectUnauthorized: true`, unchanged) was in effect — not bypassed. Then the same URL over plain `http://`.

**Expected:** HTTPS → 200 with a valid certificate. Plain HTTP → fails.

**Actual:**
- `https://<LAN IP>:5000/api/health` → `HTTP 200`, `{"success":true,"status":"ok"}`. The request succeeded under Node's default (strict) certificate validation with no `rejectUnauthorized: false` override anywhere — if the cert's SAN list hadn't covered this IP or the CA weren't trusted, this call would have thrown a TLS error instead of returning a response at all.
- `http://<LAN IP>:5000/api/health` → **failed**: `curl: (52) Empty reply from server`. The server only speaks TLS on port 5000 (`https.createServer` in `server/server.js`), so a plaintext HTTP request gets no valid HTTP response at all.

**Result: PASS**

---

## Test 9 — Database Access Check

**Procedure:** Raw TCP connection attempt to `<LAN IP>:27017` (this PC's LAN IP, not localhost) with a 3-second timeout. Located the running `mongod`'s config for its configured `bindIp`.

**Expected:** Connection refused.

**Actual:**
- `mongod.cfg` (`C:\Program Files\MongoDB\Server\8.3\bin\mongod.cfg`, the file the `MongoDB` Windows service actually runs with — confirmed via `sc qc MongoDB`) has:
  ```yaml
  net:
    port: 27017
    bindIp: 127.0.0.1
  ```
- Connecting to `<LAN IP>:27017` → `ECONNREFUSED` after ~2.0s (within the 3s timeout).
- Sanity check, connecting to `127.0.0.1:27017` → connects immediately, confirming the port is genuinely live and it's specifically the LAN address being refused, not the whole service being down.

**Result: PASS**

---

## Screenshots

- `fig2-lockout.png` — unlock screen showing "Too many failed attempts. Try again in 3 minutes." after Test 6.
- `fig5-weak-password.png` — setup screen's live requirement checklist for `password1234`, showing the same failing checks Test 1 got from the API (uppercase, special character, common word, sequential pattern).
- `fig10-rate-limit.png` — rendered capture of Test 7's 11th request returning 429.

---

## Summary

| # | Test | Result |
|---|------|--------|
| 1 | Invalid input — weak/strong password on setup | PASS |
| 2 | Invalid input — 21MB upload | PASS |
| 3 | Protected API without token | PASS |
| 4 | Password storage check | PASS |
| 5 | Secure error response (fake/revoked/expired share) | PASS |
| 6 | Invalid login / lockout | PASS (see status-code note above) |
| 7 | Rate limit | PASS |
| 8 | HTTPS check | PASS |
| 9 | Database access check | PASS |

**9/9 PASS.** No failures. One documented nuance in Test 6 (exact status-code sequence vs. the plan's literal wording — underlying security behavior is correct).

---

## Safety / cleanup

- The backend was run against `warden_checkpoint_test` only, via a `MONGO_URI` environment variable override at process launch (`server/.env` itself was never edited — `dotenv` doesn't overwrite an already-set environment variable, so the real DB was never a possible target for any of these requests).
- Before dropping anything, the real `warden` database was checked **read-only** (`listDatabases` + `countDocuments`, no writes) and confirmed present and unmodified: 1 user, 4 documents, separate from `warden_checkpoint_test` (which had its own, independent data).
- `warden_checkpoint_test` was dropped at the end of this run. Confirmed via `listDatabases()` immediately after: it no longer appears; `warden` still does.
- **The real "warden" database was never used, written to, or otherwise touched by any test in this run.**
- No app code was changed. No commits were made. `test-results/` was added to `.gitignore`.
