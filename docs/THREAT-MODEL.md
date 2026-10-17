# Threat model

This is a student threat model. It lists what we protect, who might attack, and what stops each attack in the code. For each threat
we also write the risk that is left. We do not claim Warden is safe against every attacker. Warden is **not end-to-end encrypted**.

## What we protect (assets)

| Asset | Where it lives | Why it matters |
|---|---|---|
| File contents | MongoDB, as AES-256-GCM ciphertext | The point of the app. |
| The vault key (DEK) | MongoDB, only wrapped (under a key from the password and under a key from the recovery key). In a session, wrapped under half of the bearer token. | Whoever holds it opens the files. |
| Passwords and recovery keys | Only as scrypt hashes (the recovery key is shown once) | They unlock the vault key. |
| File names, folder names, sizes, dates, emails | MongoDB, readable by the server | Metadata can be sensitive. We say this plainly. |
| Private notes and share purpose labels | MongoDB, encrypted with the vault key | Short private text. |
| Session tokens | The user's `sessionStorage` tab, and a hash of part of it in MongoDB | They act as the user. |
| Activity log | MongoDB, with an HMAC chain | The user's record of what happened. |
| Secrets (`MONGO_URI`, SMTP password, `AUDIT_HMAC_KEY`, `CRON_SECRET`, `INVITE_CODE`) | Vercel environment variables | They control the deployment. We never put values in the repo. |

## Who might attack (actors)

- A stranger on the internet guessing passwords or codes.
- Someone who got a user's share link.
- A user who uploads something harmful on purpose, or by accident.
- Someone who gets a copy of the database (a leak).
- Someone who also holds a printed Emergency Kit.
- An operator (the person running the server, which is us).
- Someone with write access to the database.
- A person who reads the user's email.

## Threats and what stops them

### 1. Password guessing

- **Stops it:** scrypt makes each guess slow on a stolen database. The login limit is 3 wrong tries in 5 minutes, then a 5 minute
  lock, counted in one atomic database update. Real and unknown addresses answer the same way. A password is not enough: a six digit
  emailed code is also needed (5 guesses per code, 3 resends, 5 code emails an hour per account). The code cannot be switched off in
  production. There is also a limit of 20 login requests per 15 minutes per IP.
- **Tests:** `login-lockout.test.js`, `login-limiter.test.js`, `otp.test.js`, `enumeration-timing.test.js`, `deploy.test.js`.
- **Residual risk:** the lock is by address. Someone who knows an address can keep it locked by trying every 5 minutes. A weak
  password is still weak if the database leaks, because an offline attacker is not stopped by our online limits. Anyone who can read
  the user's mailbox gets the code. The second factor is email only.

### 2. Stolen session

- **Stops it:** sessions are rows in MongoDB. They expire after 30 minutes idle and at most 12 hours in total, even if busy. Logout
  deletes the row. A user can sign out other devices from Devices and activity. A password reset ends all sessions and trusted
  browsers. The vault key in a session is wrapped under a half of the token that the server does not store, so a copy of the
  `sessions` collection alone does not open the vault. A strict CSP and no third-party scripts reduce the chance that injected script
  reads the token.
- **Tests:** `session-parallel.test.js`, `session-lifetime.test.js`, `session-error.test.js`, `trusted-devices.test.js`,
  `password-reset.test.js`.
- **Residual risk:** the token is in `sessionStorage`. If script runs in the page (for example through a flaw in our code or a
  dependency), it can read it. A shared computer that stays signed in can be used until the session ends. A stolen "trusted
  browser" cookie skips the emailed code for 30 days on that browser, until the user removes it.

### 3. Stolen share link

- **Stops it:** the key is in the part of the link after `#`, which browsers do not send to the server. The owner can add an email
  gate (a code sent to one address), a password, a download limit (1 to 100) and an expiry (at most 30 days). Wrong share passwords
  are limited to 5 per 15 minutes per share. Code emails per share are limited to 5 per hour. Shared copies are separate encrypted
  copies, so a share does not give access to the rest of the vault. The health score on the Overview page warns about open links.
- **Tests:** `share-gates.test.js`, `shares.test.js`, `share-fragment.test.js`.
- **Residual risk:** a link with no gates opens for anyone who has it, until it expires, hits its limit or is stopped. The server
  makes the share key when the link is created, so it handles the key at that moment (it does not store it). A viewer can save
  or screenshot what they see. The purpose watermark only marks previews and image downloads.

### 4. Harmful upload

- **Stops it:** the scanner (`server/utils/fileScanner.js`) reads the bytes before encryption using simple rules. A program in
  disguise (a Windows, Linux or Mac program under another name) and the standard antivirus test string are **refused**. A file
  with active content (a PDF with JavaScript, an Office file with macros, an HTML or SVG file with script, an archive that looks
  abusive or cannot be inspected, a double extension) is **held in Quarantine**: stored encrypted, but hidden from every list, preview,
  download, share and export until the owner types RELEASE. A plain zip is refused and must go through Export / Import, which checks
  each file inside. The file type is sniffed from the bytes. Files are 4 MB at most. Upload limits (120 a minute, 600 an hour, 2,000
  documents) limit abuse by volume.
- **Tests:** `file-scanner.test.js`, `quarantine.test.js`, `quarantine-emergency.test.js`, `upload-limits.test.js`.
- **Residual risk:** these are **simple rules, not an antivirus**. They find very little real malware. A harmful file that matches no
  rule is saved as clean, and a harmless file that matches a rule is held. We never run the file, so we cannot see what a
  file does. Files uploaded before the scanner existed were not scanned. The user decides about held files, and a user can release
  a risky one. A user who downloads a file and opens it on their own computer is outside what Warden can protect.

### 5. Leaked database

- **Stops it:** file contents, private notes and share purpose labels are ciphertext. Passwords and recovery keys are scrypt
  hashes. The vault key is only wrapped. Sessions hold only a hash of part of the token. Login codes are stored as salted hashes.
  Emergency Access keeps only one half of its key in the database. The activity log holds ids, not names.
- **Residual risk:** the database holds file names, folder names, sizes, dates and email addresses in the clear, and the document
  expiry date. An offline attacker can try to guess weak passwords. The Atlas network setting is "allow from anywhere" (Vercel has
  no fixed IP on Hobby), so the database password is the only barrier. `DEPLOY.md` explains how we reduce that risk (long random
  password, dedicated user, 2FA on Atlas).

### 6. Leaked database plus an Emergency Kit

- **How it works:** Emergency Access splits a key in two. `E = K1 XOR K2`. K1 is the kit, shown to the owner once and given to the
  contact. K2 is stored on the server. The vault key is wrapped under E. The kit alone cannot open the vault. The database alone
  cannot open it. The server uses K2 only after the waiting period (3, 7 or 14 days) ends with no denial. The owner is emailed
  when a request is made (if that email cannot be sent, the request is refused) and can deny with one click.
- **Tests:** `emergency.test.js`, `emergency-allowlist.test.js`, `emergency-hardening.test.js`, `emergency-privacy.test.js`.
- **Residual risk:** a copy of the database **plus** the printed kit opens the vault, with no wait. A malicious operator who works
  with the contact could skip the wait. Folder scope is enforced by the server as policy, not by cryptography. We say this on the
  privacy page and in `docs/DEMO-EMERGENCY.md`.

### 7. Malicious operator

- **Stops it:** very little, honestly. The operator controls the code. While a user is signed in, the server holds their vault key
  for each request, so a changed server could read what that user opens. The operator can read all metadata.
- **What limits it:** the database alone does not hold keys to the files. Secrets are in environment variables, not in the
  repo. The code is in a public repository where changes can be seen. The user can see their sign-ins and actions in the activity log.
- **Residual risk:** this is the main cost of not being end-to-end. A user who cannot accept it should not use Warden for their most
  sensitive files. This is on the privacy page. Real end-to-end encryption is not built.

### 8. Log tampering

- **Stops it:** each activity event is signed with HMAC and chained to the one before it, using a key (`AUDIT_HMAC_KEY`) that is kept
  apart from the database password. The Verify log button re-checks the chain and reports edited entries and gaps. The log holds ids
  only, with no names, emails or IP addresses. Entries are kept 30 days.
- **Tests:** `audit-limits.test.js`, `devices-audit.test.js`.
- **Residual risk:** the chain cannot show that the **newest** events were removed by someone with write access to the database.
  Someone who holds the signing key could write a valid chain. Rotating the key makes older entries show as "cannot be verified". We
  do not claim the log cannot be changed. We claim that edits and gaps in the middle can be found.

## Other threats we considered

| Threat | What helps | Residual risk |
|---|---|---|
| Email flood or mail cap exhaustion | A daily mail cap of 300 (bulk mail stops at 150, so login codes keep room). Limits per IP and per address on every mail route. Invite mode. | With open sign-up, strangers can use up the bulk share. Sign-ups then answer "busy". |
| Mass tiny uploads | 120 per minute and 600 per hour per account, 2,000 documents per account, 25 MB quota. | A few uploads in flight at once can pass the document cap by a small amount. |
| NoSQL injection | Sanitiser strips `$` and `.` keys. Types are checked by hand. | Validation is spread over controllers. HTTP-level injection tests do not cover every owner route. |
| Access to another user's data | `userId` filter on every owner query. `cross-user.test.js` calls every session route as another account. | A new route must be added to that test, or the test fails (this is by design). |
| Open redirect in the router | Navigation targets are fixed or pass through `safeRedirectPath`. A test lists reviewed targets. | Two moderate react-router advisories stay until a major upgrade. |
| Account takeover through email | Codes are short lived and limited. | If the user's mailbox is taken, the attacker can get codes. Warden cannot fix this. |

## Things we did not model

Denial of service at network level (we rely on Vercel), physical access to the user's computer, bugs in Node, MongoDB, Vercel or
Gmail, and any attack on the supply chain of our dependencies beyond `npm audit`. We did not do a penetration test by an outside
party. The review on 10 October was a read-only Claude Code review. The only written record is the fix commit `d7543a6`. There is no
separate review report.
