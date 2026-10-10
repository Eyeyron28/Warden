# Demonstrating Emergency Access

A script for showing the feature to a class or a panel in about ten minutes, with real (short) waiting periods.

**What you are showing, honestly.** Warden encrypts uploads on the server, so this is **not end-to-end**. Emergency Access is a **2-of-2 key split with a time gate**: the contact holds half of a key (the kit), the server holds the other half and uses it only after the owner's waiting period ends without a denial. A stolen kit alone, or a leaked database alone, cannot open the vault. A leaked database **plus** the kit can. A malicious operator colluding with the contact can bypass the wait. Folder limits are enforced by the server (policy), not by cryptography. Say this out loud; it is the point of the demo.

## Before you start (once)

1. In Vercel, **Settings, Environment Variables**, add `EMERGENCY_DEMO_MODE` = `true` for **Production**, then redeploy. This allows a **2-minute** waiting period and nothing else changes. **Turn it off again after the demo** (last step).
2. Have two browsers ready: your normal window (the **owner**) and a **private window** (the **contact**). Use two email inboxes you can open (or one, with a plus-address such as `you+contact@gmail.com`): the owner's, and the contact's.
3. The owner account needs a folder (for example "Taxes") with a file in it, and one file outside it (for example "Passport").

## The demo

### 1. Owner sets it up (about 2 minutes)

- Sign in as the owner. Open **Emergency Access** in the sidebar. Note the small badge: *Demo mode: short waits are enabled.*
- Press **Set up** and walk the wizard: the contact's name and email, then the waiting period (choose **2 minutes (demo)**, which shows a *Demo* badge), then **Selected folders** and tick "Taxes", then confirm. Press **Email me a code**, enter it, and **Create**.
- The **Emergency Kit** screen shows the kit code and a QR once. Press **Print kit sheet** to show the A4 sheet in the print preview (it has the contact's name, the address, the three steps, the kit and the date, and nothing about the owner's password or email). Tick *I've saved or printed the kit* and press **Done**. Copy the kit code somewhere you can reach it from the private window.

### 2. The contact asks, and the owner denies

- In the **private window** open `<your-url>/emergency`. Step 1: enter the owner's email and the contact's email, **Send me a code**. Point out that the answer is the same whether or not the details are right.
- Step 2: enter the emailed code and the kit, **Send my request**. The page shows when access can be available (Asia/Manila time).
- Back in the owner's window: the **banner** across the top ("Someone requested emergency access…"), the owner's email with a one-click **Deny** link, and the **Emergency Access** page with a live countdown. Press **Deny**.
- In the private window try step 3 (**Open the vault**): a new code and the kit are refused with the same generic message. Say why: the request was denied. (A new request is blocked for 24 hours after a denial; if you need to repeat the demo straight away, run `node scripts/emergency-demo.js --fast` or move `deniedAt` back in the database. Do not wait a day.)

### 3. A real release and the read-only vault

- Use a **second contact** (a new request after turning access off and setting up again), or wait out the cooldown. Make a request the same way, then **do nothing** for 2 minutes. The owner's card changes to "Your contact can open your vault".
- In the private window, step 3: owner's email, contact's email, **Send me a new code**, then the code and the kit, **Open the vault**.
- The contact lands in **emergency mode**: a banner says it is read-only and when it ends; the sidebar has only **Files**; only the "Taxes" folder is visible, and its path starts at "Taxes". Open and download the file. Type `/trash`, `/account` and `/overview` into the address bar: each redirects to Files. There is no upload, rename, delete, share or search outside the folder.
- Optional: in the browser console, `fetch('/api/documents/<id>', { method: 'DELETE', headers: { authorization: 'Bearer ' + sessionStorage.getItem('warden.session') } })` answers **403** (read-only). The "Passport" file's id answers **404**.

### 4. The owner's timeline

- As the owner open **Devices & activity**, filter by **Emergency access**. You see the configuration, the request, the denial, the release, the session start (flagged, with the warning banner) and each file viewed or downloaded, all marked **Trusted contact**, with no file names stored.
- Press **Verify log**: it says **Intact**.
- On **Emergency Access** press **Turn off** (emailed code). The contact's session ends at once ("Emergency access ended").

### 5. Put it back

- In Vercel remove `EMERGENCY_DEMO_MODE` (or set it to `false`) and redeploy. Confirm that the wizard no longer offers the 2-minute option.

## Without the browser

`cd server && MONGO_URI="<a throwaway database>" node scripts/emergency-demo.js` runs the whole flow against a throwaway database with real 2-minute waits (about five minutes), or add `--fast` to skip the waits. It never reads `server/.env`, never sends email and deletes the account it creates.
