# Deploying Warden on Vercel (Hobby) with MongoDB Atlas (M0)

A step-by-step guide for a first-time Vercel user. Warden is one project: the React app (`client/`) is served as static files and the Express API (`server/`) runs as a single Vercel Function (`api/index.js`). Both are on the **same origin**, which is what lets the "trust this browser" cookie work (`SameSite=Strict`, `HttpOnly`, `Secure`).

> **Not verified against real Vercel:** this runbook was prepared and tested against a local stand-in for Vercel (see "What was and was not tested" at the end). The first real deployment is the first time it meets Vercel itself. Do the smoke test (section 9) before giving the link to anyone.

## 0. What you need

- A GitHub account with this repository.
- A [Vercel](https://vercel.com) account (the Hobby plan is enough).
- A [MongoDB Atlas](https://www.mongodb.com/atlas) account with a free **M0** cluster.
- A Gmail account for sending the emailed codes, with **2-Step Verification** turned on (needed to create an app password).
- About 20 minutes.

## 1. Prepare Atlas (database)

1. In Atlas open your project, **Database Access**, **Add New Database User**. Give it a long random password and the role **Read and write to any database** (or scope it to one database). Use a dedicated user for Warden, not your Atlas login.
2. **Network Access**, **Add IP Address**, **Allow access from anywhere** (`0.0.0.0/0`). Vercel does not have fixed IP addresses on the Hobby plan, so you cannot list them.
   - Why this is acceptable here: the database still needs the username and password, and the connection is TLS-encrypted. What you give up is the IP filter, so the password becomes the only barrier. Compensate: use a long random password (32+ characters), never reuse it, use a dedicated database user, and turn on Atlas **2FA** for your own login.
   - Safer options if you outgrow this: Vercel's paid static IPs or Secure Compute with a restricted allow-list, or a private-link connection (paid Atlas tiers).
3. **Connect, Drivers**: copy the connection string. It looks like `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority`. Insert a database name before the `?`, for example `.../warden?retryWrites=...`. Replace `PASSWORD` with the real one (URL-encode special characters such as `@` or `#`).
4. **Delete the sample data.** Atlas may have loaded a `sample_mflix` database. In **Browse Collections**, drop `sample_mflix` (and any other `sample_*` database) so nothing but Warden's data lives on the cluster.
5. Turn on **2FA on your Atlas account** (Account, Security).
6. Note the cluster's region; the next steps use it to pick the Vercel function region. The database round trip is the main latency cost.

## 2. Prepare Gmail (login codes and verification emails)

1. Turn on 2-Step Verification for the Gmail account used by Warden (Google Account, Security). Also use a strong unique password.
2. Create an **App password** (Google Account, Security, 2-Step Verification, App passwords). Copy the 16-character value once.
3. You will use: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the gmail address>`, `SMTP_PASS=<the app password>`.
4. Gmail limits sending (roughly 500 messages a day). That is fine for a student project and not for a public launch.

## 3. Import the project into Vercel

1. In Vercel: **Add New, Project**, **Import** your GitHub repository.
2. **Framework Preset:** `Other`. **Root Directory:** leave it as the repository root (the folder that contains `vercel.json` and `api/`).
3. Leave **Build Command**, **Output Directory** and **Install Command** untouched: they come from `vercel.json` (`client/dist` is the output; the server's dependencies are installed for the function).
4. **Do not click Deploy yet.** Add the environment variables first (next section). A deployment without them fails at start-up on purpose; that is the production safety check working.
5. Region: Project Settings, Functions, **Function Region**: pick the region nearest your Atlas cluster.
6. Under Settings, Functions confirm **Fluid compute** is on (the default for new projects). The function's `maxDuration` is set to 30 seconds in `vercel.json`.

## 4. Environment variables

Add these under **Settings, Environment Variables** for **Production**. Mark every secret as **Sensitive** so Vercel hides it after saving.

| Variable | Secret? | Value and notes |
|---|---|---|
| `MONGO_URI` | **Secret** | The Atlas connection string from step 1 (must include a database name and the password). |
| `PUBLIC_APP_URL` | no | Your site's **https origin only**: no path, no trailing slash, e.g. `https://warden-yourname.vercel.app`. Every emailed link and share link is built from it, and it is the origin the API accepts writes from. Set the real value after the first deploy (section 5). |
| `SMTP_HOST` | no | `smtp.gmail.com` |
| `SMTP_PORT` | no | `465` |
| `SMTP_USER` | **Secret** | The sending Gmail address. |
| `SMTP_PASS` | **Secret** | The Gmail app password. |
| `MAIL_FROM` | no | e.g. `Warden <your.gmail@gmail.com>` (Gmail rewrites the sender to your account anyway). |
| `SIGNUP_MODE` | no | `invite` (recommended) or `open`. |
| `INVITE_CODE` | **Secret** | Required when `SIGNUP_MODE=invite`. At least 16 characters, random. Share it only with the people you invite. |
| `REQUEST_ACCESS_TEXT` | no | Optional. One plain-text line (max 200 characters) shown on the landing page and the sign-up form in invite mode, e.g. `Email sam@example.com to ask for a code.` It is public and shown as text only. Never put the code in it. |
| `CRON_SECRET` | **Secret** | At least 16 random characters. Vercel sends it to the daily Trash-purge job. Optional but recommended. |
| `STORAGE_QUOTA_MB` | no | Optional. Per-account storage limit in MB; must be a positive number. Default 25. |
| `TRUST_PROXY_HOPS` | no | Optional. Leave it unset: the app uses **1** automatically on Vercel. If you set it, it must be `1`; any other value makes the rate limiter see the wrong IP address. |
| `OTP_ENABLED` | no | **Do not set it.** The emailed login code is on by default, and the server refuses to start in production if it is `false`. |
| `OTP_TTL_MINUTES` | no | Optional, 1 to 60 (default 5). |
| `AUDIT_HMAC_KEY` | **Secret** | **Required in production** (the server refuses to start without it). At least 32 random characters, e.g. from a password manager. It signs each entry of the activity log so changes to the stored log can be detected. Keep it separate from `MONGO_URI`: it protects nothing if the same person holds both. Rotating it makes older entries show as "cannot be verified". |
| `AUDIT_RETENTION_DAYS` | no | Optional. How long activity entries are kept (default 30). |
| `CORS_ORIGINS` | no | Not needed: the app and API share one origin, and `PUBLIC_APP_URL` is allowed automatically. |

Never put these values in the repository, in screenshots or in chat. `server/.env` is git-ignored; keep it that way.

**How invite-only sign-up behaves.** With `SIGNUP_MODE=invite` the sign-up form shows a required "Invite code" field first, and the server enforces it on its own: a missing, empty, wrong, oversized or wrong-typed code is refused with `INVITE_CODE_INVALID` before the email is looked at, so nothing is created and no email is sent. Wrong attempts are limited per IP address (5 per 15 minutes, 20 per hour); while a limit is active even the right code is refused until it ends. Only the exact value `open` turns invite checking off, so a typo in `SIGNUP_MODE` leaves the code required. If you rotate `INVITE_CODE`, redeploy; people who already signed up are not affected.

**Preview deployments:** each preview has its own URL, which will not match `PUBLIC_APP_URL`, so writes and emailed links from a preview URL will not work. Treat Production as the only working environment, or give previews their own `PUBLIC_APP_URL` and a separate database.

**What the server checks at start-up (production only).** It refuses to start unless `MONGO_URI`, `PUBLIC_APP_URL` (https), all of `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and a valid `SIGNUP_MODE` are present; `INVITE_CODE` is 16+ characters when invites are on; `OTP_ENABLED` is not `false`; and `STORAGE_QUOTA_MB` (if set) is a positive number. The error in the Vercel logs names the offending **variables only**, never their values.

## 5. First deploy, then set `PUBLIC_APP_URL`

1. Enter a placeholder `PUBLIC_APP_URL` (for example `https://placeholder.example.com`) so the first build can start, then click **Deploy**.
2. When it finishes, copy your real URL (shown on the project page, e.g. `https://warden-yourname.vercel.app`, or your own domain).
3. **Settings, Environment Variables**: edit `PUBLIC_APP_URL` to that exact origin, then **Deployments**, open the latest one, **Redeploy**. Variables are read at start-up, so a redeploy is required for the change to apply.
4. Open `https://<your-url>/api/health`. You should see `{"success":true,"status":"ok","database":"reachable"}`. If it says `unreachable`, check the Atlas network access and `MONGO_URI`.

## 6. Daily Trash purge (cron)

`vercel.json` contains one cron job that calls `/api/cron/purge-trash` once a day. Vercel Hobby allows cron jobs that run **at most once per day**, started any time within the scheduled hour. With `CRON_SECRET` set, Vercel sends it automatically and the endpoint removes Trash older than 30 days. Without it the endpoint answers 404 and nothing is lost: the database's TTL index and each account's own requests also purge expired Trash.

## 7. Security checklist before inviting anyone

- [ ] `SIGNUP_MODE=invite` and a long random `INVITE_CODE`.
- [ ] 2FA on Atlas and on the Gmail account; the Gmail app password is used, not the Gmail password.
- [ ] `sample_mflix` and other sample databases deleted.
- [ ] The Atlas database user is dedicated to Warden and has a long random password.
- [ ] No secrets in the repository.
- [ ] `/api/health` is OK and the smoke test below passes.

## 8. Rolling back

- **A bad deployment:** Vercel, **Deployments**, pick the last good one, open its menu, **Promote to Production** (Instant Rollback). The static files, the function and the cron schedule go back together.
- **A bad environment variable:** fix it under Environment Variables and **Redeploy**.
- **Data:** Vercel does not roll the database back, and Atlas M0 has no automatic backups. Use **Export** in the app (a zip of all your files, built in your browser) before risky changes.
- **Users stuck on an old page:** the app's service worker replaces itself on every deployment and shows a "New version available" bar; one reload gets the new version. (A browser still running the very first service worker version needs two reloads, once.)

## 9. Post-deploy smoke test

Run this on the real URL, with a throwaway email address you control.

1. [ ] `https://<your-url>/api/health` returns `ok` and `reachable`.
2. [ ] **Sign up**: the "Invite code" field is first and marked Required. A wrong code is refused under the field; the right code (spaces around it are fine) and a strong password create the account. Save the recovery key.
3. [ ] The verification **email arrives** (check spam). Its link starts with your `PUBLIC_APP_URL`. Open it: "Email verified".
4. [ ] **Log in**: the 6-digit code email arrives and the code works. "Trust this browser for 30 days" is ticked by default (with the note about shared computers); leave it ticked.
5. [ ] Open a new tab and log in again: no code is asked on this browser. In a private window the code **is** asked.
6. [ ] **Upload** a small PDF and a file of about 3.9 MB (both work). A file over 4 MB is refused with "File exceeds the 4MB size limit."
7. [ ] **Preview** the PDF; download it and check the name and extension.
8. [ ] **Share** the PDF with a password. Open the link in a **private window**, enter the password, view and download.
9. [ ] Move a file to **Trash**, then **restore** it.
   - **Forgot password:** on the login page choose "Forgot password", enter the email: a 6-digit code arrives. Enter it, choose "I have my recovery key", enter the key you saved and a new password: you land on the login page with a success message and a notification email arrives (no links in it). Log in with the new password and the emailed code; your files are still there. (Use a throwaway account: the other choice, "I don't have my recovery key", erases the vault.)
10. [ ] **Delete the account** (password, emailed code, type your email). You get a confirmation email and cannot log in again.

## 9b. Devices, activity and Overview

1. [ ] Sign in, open **Devices & activity**. This browser is listed as "This device" with a label such as "Chrome on Windows" and your country (the city and country come from Vercel's own headers; no IP is shown or stored).
2. [ ] Sign in from a second browser or a private window (the code email arrives; this is a new device, so a "New sign-in" email arrives too). Both devices are listed. Use **Sign out** on the second one and reload it: "Your session expired. Sign in again."
3. [ ] Open and download a file, then check the timeline: "Opened" and "Downloaded" entries appear, with no file names stored (names are looked up when you read it).
4. [ ] Press **Verify log**: it reports the chain intact.
5. [ ] In the email's **This wasn't me** link: it opens a page that only explains and links to the password reset.
6. [ ] Open **Overview**: most viewed, most downloaded, recently opened, files untouched for 180 days, share statistics. "My files" shows a "Frequently used" row after a few opens.
7. [ ] Reload a page while signed in: you stay signed in (the token is in this tab's sessionStorage). Close the tab and reopen the site: you are signed out.

## 9c. Emails and share-link previews

Every email goes through `server/utils/emailTemplates.js` (HTML plus a plain-text twin, sent as multipart/alternative, From name "Warden"). Check them in a real inbox after deploying:

1. [ ] From `server/`, with the real SMTP settings in `.env`: `node scripts/send-test-emails.js you@gmail.com --force` (`--force` is needed on a production environment; the samples use a fixed example code, never a real one). 13 messages arrive, each subject prefixed `[test]`.
2. [ ] Open them in Gmail on a computer and in the Gmail phone app, in light and in dark mode: the code sits alone in the highlighted box and a double-tap selects exactly the six digits; nothing runs off the screen at phone width; the inbox preview line reads well.
3. [ ] They land in **Inbox**, not Spam. If they land in Spam, mark one "Not spam" and check the sender (SPF and DKIM are Gmail's own when you send through Gmail SMTP; a different `MAIL_FROM` address than the account you log in with is the usual cause).
4. [ ] Trigger the real flows once (log in, "Forgot password", delete-account step 2, a share restricted to an email) and check each uses the same layout.

What Warden sends: sign-in code, account-deletion code, password-reset code, share code (to the recipient), verify account, new verification link, "someone tried to sign up with your email", "your password was changed", "your account was deleted", "a new device was paired", "new trusted browser". Subjects are fixed text: never a code, a file name or an address. These are transactional messages, so there is no unsubscribe link.

**Share-link previews.** A chat app that fetches a share link to draw a preview card gets `shared-preview.html` (written by `npm run build`, served for `/shared/*` by the rewrite in `vercel.json`): a generic title and description, `noindex`, and only the fixed Warden icon. It never contains a file name, purpose or owner. The key after `#` is never sent to Warden: browsers do not transmit fragments.

## 10. Limits to know about (Vercel Hobby)

Figures are from Vercel's documentation, read on 2026-10-07; limits change, so re-check the linked pages.

- **Request and response body: 4.5 MB** per function call ([Functions limits](https://vercel.com/docs/functions/limitations)). Warden caps an upload at 4 MB (the file plus a small multipart envelope fits under 4.5 MB). Phone sync therefore never puts a document in JSON (base64 would make 4 MB into about 5.3 MB): it lists metadata in pages of at most 200, downloads each document's ciphertext on its own request as raw bytes (4 MiB at most), and pushes one document per request as multipart. The JSON body limit is 100 kB.
- **Duration:** with Fluid compute, Hobby has a 300 s default and maximum. Warden sets 30 s in `vercel.json`, far above a login (one scrypt derivation takes well under a second) or any other operation here.
- **Memory:** 2 GB and 1 vCPU on Hobby. Uploads are processed in memory.
- **Cron:** once per day at most, with up to an hour of scheduling slack ([usage and limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)). Cron calls carry `Authorization: Bearer <CRON_SECRET>` ([managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)).
- **No disk or memory shared between requests.** Sessions, rate limits, trusted browsers, login challenges and shares all live in MongoDB. Drive backup and restore were removed (they needed a path on the server's own disk); the old URLs answer 410. **Export** builds a zip in the browser instead, and **Import** adds a zip back through the normal upload (so the same 4 MB and storage limits apply).
- **Atlas M0:** 512 MB of storage and a connection cap (500). Warden holds at most 5 connections per function instance.
- **Client IP:** Vercel overwrites `X-Forwarded-For` with the real client address ([request headers](https://vercel.com/docs/headers/request-headers)). Warden trusts exactly one proxy hop, so the rate limiter counts per real visitor and a forged header gains nothing.

## What was and was not tested

Tested locally against a stand-in for Vercel (static files, headers and rewrites from `vercel.json`; `api/index.js` as the function; a 4.5 MB body limit; a proxy hop that sets `X-Forwarded-For`; a mail sink instead of Gmail) and a throwaway single-node MongoDB replica set: signup, email verification, code login, trusted browser, uploads under and over the limit, previews, a password-protected share in a private window, Trash and restore, account deletion, 20 parallel cold requests, rate-limit keying, service worker replacement, headers and CSP.

**Not tested** (needs a real deployment): Vercel's actual routing and header application, real cold-start timing, Atlas M0 itself (connection counts and transactions on Atlas), real Gmail delivery, Vercel Cron, and the 4.5 MB limit as Vercel enforces it.

## Where the sign-in token lives

The session token is kept in the browser tab's sessionStorage so a reload keeps you signed in; closing the tab ends it, and it expires after 30 idle minutes on the server. The trade-off is that script running inside the page could read it, which is why there is no third-party script and why the Content-Security-Policy in `vercel.json` is strict (scripts only from this origin plus one hashed theme snippet, no frames, no plugins, `upgrade-insecure-requests`). `style-src 'unsafe-inline'` is still needed for React inline styles and was not removed.
