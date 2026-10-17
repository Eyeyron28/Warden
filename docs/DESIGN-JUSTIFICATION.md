# Design justification

This document explains why we built Warden the way we did, and what we gave up. We are students. Some choices were made because they
were simple enough for us to finish and test, not because they are the best possible choice. We say so where that is true.

## What Warden is

Warden is a hosted web app where a person keeps private documents in an encrypted vault. It is a MERN app: MongoDB, Express, React
(Vite) and Node. The client is static files. The API is one Express app that runs as one Vercel serverless function
(`api/index.js`). The data is in MongoDB Atlas (free M0 tier). Emails go through Gmail SMTP with Nodemailer. A daily Vercel Cron
runs two small jobs (see `vercel.json`).

Warden is **not end-to-end encrypted**. The server encrypts and decrypts files, so it sees the content while it works. We explain
why below, and we say it on the privacy page and in `docs/THREAT-MODEL.md`.

## Why a hosted vault

The first version of Warden ran on the owner's own computer (the README still says "locally-hosted"). That was easy to build, but a
vault that only works on one computer is not much use for sharing or for emergencies. We moved to a hosted app because:

- A person can reach their files from any browser without installing anything.
- Share links and Emergency Access need something that is online when the owner is not.
- Document expiry reminders need a daily job that can email the owner while they are signed out.
- It lets our classmates and panel try the app with a link.

The price of this choice is trust. When the app is hosted, whoever runs the server could in theory read what the server can read.
That is why we are careful to say what the server can and cannot see (see `docs/PRIVACY-AND-DPA.md`).

## Why MERN

- One language (JavaScript) in the browser and on the server.
- JSON from the database to the screen. A file record, a folder or a share is naturally one document.
- It fits serverless. The API is stateless between requests, and all state is in MongoDB.
- Free tiers exist for every part (Vercel Hobby, Atlas M0).

## Why a document database

A vault is a set of independent encrypted blobs with a few attributes we need to search by (owner, folder, deleted date, type). We
do not need joins. Wrapped keys sit on the user record. Time-limited things (sessions, codes, rate limit counters, shares, Trash)
use TTL indexes, so the database removes them by itself and we do not need a cleanup job for each.

We considered Postgres with object storage. It would be better for large files. We did not use it because it is more to set up and
more to pay for, and the 4 MB per file limit keeps files small enough for MongoDB. See `docs/SCALABILITY-AND-GOVERNANCE.md` for what
changes at larger sizes.

## Why scrypt

Passwords are hashed with scrypt (`server/utils/crypto.js`, N=2^15, r=8, p=1, random salt). scrypt is memory-hard, so guessing
passwords on a stolen database costs more memory than it does with a plain fast hash. It is built into Node, so we added no
dependency. The key that wraps the vault key uses a different context string from the password check, so the two outputs are
independent.

Argon2 is often recommended instead. We used scrypt because it ships with Node, so there was no new dependency to trust.

## Why AES-256-GCM

GCM encrypts and checks the data in one step. If the stored bytes were changed, decryption fails instead of returning wrong data.
Each encryption uses a new random 12 byte IV. Each account has one random 32 byte vault key (the DEK). The DEK is stored only
wrapped, once under a key from the password and once under a key from the recovery key. That is why changing the password does not
mean re-encrypting every file.

## Why the server encrypts (and why that is not end-to-end)

We chose to encrypt on the server because we wanted previews, file type checks from the bytes, the Quarantine scanner, thumbnails,
document expiry reminders and share links to work in a normal web app. Doing all of that with keys that only the browser holds is
possible but much harder, and we did not have the time to build and test it well.

The honest result: while a person is signed in, the server holds their vault key for each request. Anyone who controls the running
server could read what that person opens. The database alone holds only ciphertext, but it holds file names, folder names, sizes and
dates in the clear. Private notes and share purpose labels are encrypted. Document expiry dates are readable so a reminder can be
sent while nobody is signed in.

## Why database sessions and not JWT

The API runs on serverless functions, so there is no shared memory between requests. We wanted logout to really end a session and
we wanted to be able to sign out one device. A JWT cannot be taken back before it expires unless we also keep a list on the
server, and then it is no simpler than a session row.

So a session is a row in MongoDB (`server/models/Session.js`). The bearer token has two random parts. Only a hash of the first part
is stored. The vault key is wrapped under the second part, which the server never stores. Idle time is 30 minutes and the absolute
limit is 12 hours (`SESSION_ABSOLUTE_HOURS`). Only one function, `createSession`, makes sessions, and a test checks that.

The token is kept in `sessionStorage`, not a cookie. That means closing the tab ends the session. The risk is that script running
in the page could read it, so we use a strict Content-Security-Policy and no third-party scripts.

## Why a code by email

We wanted a second factor that every user already has and that needs no app. The code is six digits, lives 5 minutes, allows 5
guesses and 3 resends, and the login code cannot be switched off in production. The limit of this choice: anyone who can read the
user's mailbox can get the code. An authenticator app or a passkey would be stronger (see `docs/FUTURE-WORK.md`, not built).

## Why one Vercel project

The static client and the API share one origin. This lets the "trust this browser for 30 days" cookie be `HttpOnly`, `Secure` and
`SameSite=Strict`, and it means we do not need to open cross-origin access. `DEPLOY.md` has the steps.

## Why sign-up has a mode switch

`SIGNUP_MODE` is `invite` or `open`, and production refuses to start if it is not set. In invite mode the server asks for an invite
code before it even looks at the email. In open mode anyone can sign up. We built the switch because open sign-up lets strangers
make the app send emails, and a free Gmail account can only send a few hundred a day. The live site is in open mode (the owner confirmed this on 14 October 2026).

## What we kept from the first local version

- The encrypted vault with folders, Trash, share links and the recovery key.
- The idea that the owner, not us, holds the way to recover the vault.
- The strict approach to input: every route checks types by hand.

## What we removed, and why

- **Phone pairing and sync.** We removed the phone vault, and its old URLs now answer 410 (see `DEPLOY.md`). The reason: the app became a public website, so there is no local PC to pair a phone with.
- **USB backup and restore.** It needed a path on the server's own disk, which a serverless function does not have. We replaced it
  with Export and Import: the browser builds a zip from the authenticated downloads, and import sends each file back through the
  normal upload so every check still applies.

The commit history shows these changes (`Remove USB backup and restore, add browser zip export and import`, `remove phone vault`).

## Features we added because of what the hosted design needs

- Quarantine: simple rules on each upload, with risky files held (see `docs/QUARANTINE.md`).
- Rate limits stored in the database (see `docs/ROLES-AND-RATE-LIMITS.md`).
- A daily mail budget so one account cannot use up the whole Gmail allowance.
- An activity log chained with HMAC, so edits and gaps can be found.

## What we would still do differently

- Use object storage for files and keep only metadata in MongoDB.
- Use a proper email service with a domain we own, so codes reach the inbox.
- Add an authenticator app or passkeys.
- Give each piece of validation one shared helper.

These are listed in `docs/FUTURE-WORK.md`. None of them is built.
