# Demo script (10 minutes)

This is the script for the defense demo. It runs on the live site in Chrome with **throwaway accounts only**. Never use a real
vault, a real document or a real person's email in a demo.

Live site: https://warden-vault.vercel.app. Source: github.com/Eyeyron28/Warden.

The longer Emergency Access script is in `docs/DEMO-EMERGENCY.md`. This one fits it into 10 minutes.

## Pre-demo checklist (do this the day before and again 30 minutes before)

- [ ] Open https://warden-vault.vercel.app/api/health. It must say `ok` and `reachable`. This also wakes the function.
- [ ] **Warm up the inboxes.** Gmail often puts the first message from a new sender in Spam. Send yourself a login code from each
      demo account, open the message in Spam, press **Not spam**, and add the sender to Contacts. Do this for every inbox you will
      use (see `DEPLOY.md` section 9d).
- [ ] Two throwaway email addresses you can open on stage: the **owner** and the **contact** (a plus-address such as
      `you+contact@gmail.com` works).
- [ ] A **prepared owner account** that already has: one folder "Taxes" with a file inside, one file outside it ("Passport"), and
      Emergency Access already set up with the kit saved or printed. Setting it up takes about 2 minutes, so do it before the demo.
- [ ] A **fresh email** for the live sign-up in step 1. Do not sign it up before the demo.
- [ ] Set `EMERGENCY_DEMO_MODE` to `true` in Vercel **Settings, Environment Variables** and redeploy, only for the demo. **Turn it off
      again after** (last step below). The server warns at start-up if it is on in production.
- [ ] Sign up on the live site is in open mode, so no invite code is needed. If that is ever switched to invite mode
      (`SIGNUP_MODE=invite`), keep the code on paper and never show it on the projector.
- [ ] The **demo-samples folder**: from the repository root run `node scripts/make-demo-samples.mjs`. It writes four harmless files
      into `demo-samples/`: `tax-form-with-script.pdf`, `logo-with-script.svg`, `holiday-photo.png` (really a PDF) and
      `statement.pdf.exe` (really text). None is real malware.
- [ ] A **spare phone** with a camera and a browser, to scan the share QR code. Check that it can reach the live site.
- [ ] Two browser windows: a normal window (owner) and a private window (contact and share viewer). Chrome only.
- [ ] A small ordinary file (a text file or a picture under 1 MB) and a small zip of a few files for Export / Import.
- [ ] Zoom the browser to about 125 percent so the back of the room can read it. Close other tabs and notifications.
- [ ] Have `docs/THREAT-MODEL.md` and `docs/KNOWN-LIMITS.md` open in a tab for questions.

## The demo

### 0. What this is (0:00 to 0:45)

Say plainly: "Warden is a hosted document vault. It is **not end-to-end encrypted**. The server encrypts and decrypts, so it can see
file contents while you are signed in and it can always read file names, sizes and dates. The scanner is simple rules, not an
antivirus." Say it first, so nobody can say we hid it.

*If something fails:* nothing to fail. Move on.

### 1. Sign up and sign in with a code (0:45 to 2:30)

1. Open the live site. Click **Sign up**. Use the fresh email and a long password.
2. Point out: the consent step (open and read the Terms and the Privacy policy to the end before the checkbox works), and that
   **no account exists yet**.
3. Enter the six digit code from the email. Now the account exists. The **recovery key** screen follows. Say: "This is shown once.
   If we lose both the password and this key, nobody can recover the vault, not even us." Tick the box and continue.
4. Sign out. Sign in again: password, then a new emailed code. Leave "Trust this browser" ticked and say what it does.

*If the email is slow:* check Spam. Wait 60 seconds (resend has a 60 second gap). If it still fails, switch to the prepared owner
account, which is already trusted in this browser.

*If sign-up says "busy":* the daily mail budget is used up. Say so, it is a real feature, and use the prepared owner account.

### 2. Upload and the transfer tray (2:30 to 4:00)

1. Press **New**, then **Upload file**. Choose three small files at once (the dialog takes up to 10).
2. The dialog closes at once and the **tray** at the bottom right shows each file. Hover the status icon of a row to show the
   tooltip. Point out "Sealed · checked".
3. Show that a file over 4 MB is refused with a clear message (have one ready, or just say it).

*If upload fails:* the tray row shows the reason and a **Retry** button. Press it. If the whole site is down, show the tests
(`docs/TEST-EVIDENCE.md`) and the screenshots in `docs/screenshots/`.

### 3. Quarantine (4:00 to 5:15)

1. Upload the four files from `demo-samples/`.
2. The tray shows **Held for review** in amber. Open **Quarantine** from the sidebar.
3. Open the Details of one held file and read the plain reasons (for example, a PDF with JavaScript). Try to download or share a
   held file: it is refused (409). Say: "These are simple rules. They catch little. They are not an antivirus."
4. Press **Release** on one file. Show that it asks for the typed word **RELEASE** and explains the risk. Release it. Details
   now says "Released after review".

*If a sample is not held:* say the rules are simple and that a file that matches no rule is saved as clean. Use `tax-form-with-script.pdf`,
which is the most reliable.

### 4. Share link with a password and a QR code (5:15 to 6:30)

1. Pick a file, press **Share**. Add a **password**, a short expiry and a **purpose** (for example "For testing").
2. Show the QR code. Scan it with the spare phone, or copy the link into the **private window**.
3. In the private window enter the password, view the file and note the faint purpose watermark.
4. Say: "The key is in the part of the link after the `#`. Browsers do not send that part to the server." Then say the honest limit:
   the server makes the share key when the link is created, and a viewer can still take a screenshot.

*If the phone cannot scan:* use the private window only. *If the link fails:* check that the share has not expired and that you typed
the password the same way.

### 5. Devices and activity, and Verify log (6:30 to 7:15)

1. Open **Devices & activity**. Show this browser as "This device", the timeline (uploads, share creation, sign-ins), and that
   it holds ids, not file names.
2. Press **Verify log**. It says the log is intact.
3. Say what it cannot do: it finds edits and gaps. It cannot detect that the **newest** events were removed by someone who can write
   to the database.

*If Verify log shows a problem:* do not hide it. Explain it, then show `server/test/audit-limits.test.js`.

### 6. Emergency Access (7:15 to 8:45)

Use the prepared owner account (Emergency Access already set up, `EMERGENCY_DEMO_MODE=true`, waiting period 2 minutes).

1. In the **private window**, open `<site>/emergency`. Enter the owner's email and the contact's email, **Send me a code**. Point out
   that the answer is the same whether or not the details are right.
2. Enter the code and the kit, **Send my request**. In the owner window show the banner and the email with the **Deny** link.
3. Say why it is built this way: the kit is half of a key, the server holds the other half, and the server uses its half only
   after the waiting period ends with no denial. A kit alone cannot open the vault. A copy of the database alone cannot either.
   A copy of the database **plus** the kit can. A dishonest operator who works with the contact could skip the wait. Folder limits
   are server policy, not cryptography.
4. **Do not wait here.** Go to step 7 while the 2 minutes pass. Come back and open the vault as the contact. It is read-only and only
   the "Taxes" folder shows.

*A denial blocks a new request for 24 hours.* So do not press Deny unless you are sure you will not repeat the demo that day. If you
need to repeat it, use the fast script in `docs/DEMO-EMERGENCY.md`.

*If the email with the code does not arrive:* check Spam. If Emergency Access fails live, show `docs/DEMO-EMERGENCY.md` and the tests
`emergency-allowlist.test.js` and `emergency-hardening.test.js`.

### 7. Export and Import (8:45 to 9:30)

1. Open **Export / Import**. Press **Export** and say: "The zip is built in your browser. We do not see it. It is **not encrypted**,
   and it leaves out held files, notes and old versions."
2. Choose the small zip and press **Import**. Watch the tray. Each file is checked on its own by the same rules.
3. Say: "A plain zip uploaded as a normal file is refused. It must go through here so that every file inside is scanned."

*If the import stops:* the tray says why (storage, upload limits, a held file). That is expected behaviour. Read the line aloud.

### 8. Go back to Emergency, then the honest limits (9:30 to 10:00)

1. Open the vault as the contact (kit and a new code). Show the read-only banner, and that `/trash` and `/account` redirect to
   Files.
2. Close with the limits, in your own words:
   - Not end-to-end. The server sees file content while you are signed in, and always sees names, sizes and dates.
   - The scanner is simple rules. Old files were not scanned.
   - The second factor is email only.
   - We tested in Chrome. We did not load test. We have not tested the live site for everything (`docs/TEST-EVIDENCE.md`).
   - It is a student project. Do not store real sensitive documents.

### After the demo

- [ ] In the owner account press **Turn off** on Emergency Access.
- [ ] In Vercel **remove `EMERGENCY_DEMO_MODE`** (or set it to `false`) and redeploy. Confirm the wizard no longer offers the
      2 minute option.
- [ ] Delete the throwaway accounts (**Account**, **Delete account**).
- [ ] Do not leave screenshots that show codes, kits, invite codes or emails in the shared folder.

## If the whole live site is down

1. Check `https://<site>/api/health`. Check Atlas Network Access and the `MONGO_URI` setting in Vercel (read the name, never show the value).
2. Roll back in Vercel with **Deployments, Promote to Production** (see `DEPLOY.md` section 8).
3. If it stays down, show the code and the evidence: `docs/TEST-EVIDENCE.md`, `docs/screenshots/`, and run `cd client && npm test`
   on the laptop (it needs no database).
