# Privacy and the Data Privacy Act

**This is a student project. This document is not legal advice and it is not a reviewed legal document.** The privacy page in the
app (`client/src/pages/public/PrivacyPage.jsx`) says the same. If this document and the privacy page ever differ, the page and the
code are the source of truth. Contact: warden.vault.app@gmail.com.

## What personal data we hold

| Data | Why we hold it | Stored how | Who can read it |
|---|---|---|---|
| Email address | To find the account and to send one-time codes and security notices | Plain text in the user record | Anyone with database access |
| Password | To lock the vault key | Never stored. Only a salted scrypt hash, and the wrapped vault key | Nobody can read the password |
| Recovery key | To recover the vault if the password is lost | Shown once. Only a scrypt hash is stored, plus a second wrapped copy of the vault key | Nobody can read the key |
| Agreement to the Terms and policy | To record that consent was given, and which version | `consent.acceptedAt` and `consent.policyVersion` on the user | Anyone with database access. Accounts made before this was added have no record |
| Files | The point of the service | AES-256-GCM ciphertext | Not readable from the database alone. Readable by the server while the owner is signed in, because Warden is not end-to-end |
| File names, folder names, types, sizes, upload dates, expiry dates | So the vault can list, sort and remind | Plain text | Anyone with database access |
| Private notes, share purpose labels | The owner's own text | Encrypted with the vault key | Same as files |
| Preview images | Thumbnails of images and PDFs | Encrypted (at most 40 KB each) | Same as files |
| Shared copies of files | Share links | Encrypted copies, key in the link's `#` part | The link holder, in their browser |
| Devices and trusted browsers | So the owner can see and end sign-ins | A hash of a random id or token, a label such as "Chrome on Windows", first and last seen, country and city from Vercel's headers. **No IP address** | Anyone with database access |
| Activity log | The owner's own record, and the integrity check | Ids only (no file names, emails or IPs), signed in a chain, kept 30 days | The owner. Anyone with database access |
| View and download counts | The Overview page | Counters on each file and share | Anyone with database access |
| Emergency contact (only if set up) | Emergency Access | Contact email and name, waiting period, scope, one half of a key | Anyone with database access |
| Sessions, login codes, rate limit counters | Security | Hashes and counters that expire by themselves | Anyone with database access |
| Held files | Quarantine | Stored encrypted like any file, with the reason codes | The owner |

We do not collect a name, phone number or IP address in the activity log. We have no analytics or tracking scripts, no
advertising, and we do not sell or share the data. The app uses one strictly functional cookie for devices (`warden_did`) and
an optional per-account cookie for trusted browsers (30 days). The session token is kept in the browser tab's `sessionStorage`.

## What is encrypted and what is not

**Encrypted:** file contents, previews, private notes, share purpose labels, the vault key (wrapped), shared copies and their
name list.

**Not encrypted (readable by the server and by whoever has the database):** file names, folder names, types, sizes, dates, expiry
dates, email addresses, contact emails, counters, and the fact that events happened.

**Not end-to-end.** The server encrypts and decrypts, so it handles file content and the vault key while a user is signed in. We say
this on the privacy page, in `docs/THREAT-MODEL.md`, and at the start of every demo.

Export zips built in the browser are **not encrypted**. They leave out held files, private notes and older versions.

## How long we keep data (retention)

| Data | How long | How it ends |
|---|---|---|
| Account and files | Until the user deletes them or deletes the account | User action |
| Files in Trash | 30 days | Removed by a database TTL index and by a daily job |
| Older versions of a file (up to 3 per file) | 30 days | TTL index |
| Activity log entries | 30 days (`AUDIT_RETENTION_DAYS`, default 30, range 1 to 365) | TTL index |
| Sessions | 30 minutes idle, 12 hours at most | TTL index |
| Login and sign-up codes | A few minutes (login code 5 minutes by default) | TTL index and deletion on use |
| Trusted browser records | 30 days | TTL index, or removed by the user |
| Share links and their copies | At most 30 days, or until the download limit, or until stopped | TTL index |
| Rate limit counters | Minutes to a day | TTL index |
| Server logs | Kept by Vercel for a time that depends on the plan | Vercel |

## Consent and the policy version

At sign-up the user must open the Terms and the Privacy policy and read them to the end before the checkbox can be used
(`client/src/pages/auth/SignupPage.jsx`). The server refuses a sign-up without `termsAccepted`. On success the server stores the
time and the policy version on the new account (`server/utils/policyVersion.js`, currently `2026-10-21`, which must equal the
value in `client/src/config.js`). Tests check that the two values match and that the page text and the version change together.

Limits: older accounts have no consent record. The client sends `termsAccepted: true` as a constant, so the server check shows
that the request was well formed, not that a person clicked. The record is as strong as the form is.

## User rights

| Right | How it works in Warden |
|---|---|
| To be informed | The privacy page lists what we collect, why, where, for how long, and the limits. The user's own activity log shows what happened on their account. |
| Access and portability | "Export my files" builds a zip of the user's files in the browser. We do not see or keep it. It is not encrypted. |
| Correction | The user can rename files and folders and change the password. Other fixes are by email. |
| Erasure and blocking | Delete a file (Trash, then permanent), or **Delete account** on the Account page. It needs the password, an emailed code and the typed email. It removes documents, previews, folders, shares and their copies, devices, activity log, sessions, trusted browsers, codes, Emergency Access data and the account. |
| Object and withdraw consent | Deleting the account withdraws consent. Other requests are by email. |
| Complaint | The privacy page names the National Privacy Commission of the Philippines (privacy.gov.ph). |

We tested deletion in the earlier audit by building a full account, deleting it, and scanning every collection for the user id, email,
document ids and share ids. Nothing was left except IP-keyed rate limit rows, which expire by themselves
(`docs/SCORING-AUDIT.md` section 3.5, and `server/test/account.test.js`). We did not repeat that scan for this document.

## Mapping to the Data Privacy Act of 2012 (RA 10173)

This is our own reading, as students. It is not a legal opinion.

| Principle | How Warden tries to meet it | Where to check |
|---|---|---|
| **Transparency** | A plain-language privacy page lists every item collected, who can read what, retention and rights. A read-before-agree step at sign-up. The user can see their own activity. Emails tell the user about new devices, password changes, shares with codes, and Emergency Access requests. | `PrivacyPage.jsx`, `SignupPage.jsx`, Devices and activity page |
| **Legitimate purpose** | Data is used only to run the vault: sign in, keep the vault working, send emails the user asks for, and protect accounts. No sale, no advertising, no analytics scripts. One-time codes are used only for the action they were sent for. | `PrivacyPage.jsx` ("How we use it"), `signup-flow.test.js` (a login code cannot complete sign-up or deletion) |
| **Proportionality** | Sign-up asks only for an email and a password. No name or phone. The activity log holds ids only. Short retention (30 days for events and Trash). Contents are encrypted. Deleting the account removes all of it. | Data table above, `server/utils/accountDeletion.js` |

## Gaps we know about

- Older accounts have no consent record.
- No data protection officer is appointed (student project).
- We have no written breach notification procedure. RA 10173 expects the National Privacy Commission and affected people to be told
  after certain breaches [to confirm the exact rules]. This is a gap.
- Some rights (correction beyond renaming, objection) are handled by email, by hand.
- The privacy page is a draft written by students. A real service would need a lawyer to review it.
- We do not address use by children.
- Operator access to metadata is a real privacy cost. We state it, we do not remove it.
- The database host and the email provider are processors. The privacy page names them in general terms. We have not signed data
  processing agreements with Vercel, Atlas or Gmail. We rely on their standard terms.
- Warden should not be used for real sensitive documents until it is reviewed.
