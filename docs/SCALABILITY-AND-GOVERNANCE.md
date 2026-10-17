# Scalability and governance

**Read this first.** We have not run a load test. Every number about "how many users" below is an **estimate** worked out from the
limits in the code and from the free tier limits we read. It is not a measurement. Where we did measure something (on a laptop, not
on Vercel or Atlas), we say so.

## Where we are today

| Item | Current value | Where it comes from |
|---|---|---|
| Hosting | Vercel Hobby, one Express function plus static files | `vercel.json`, `api/index.js` |
| Function time limit | 30 seconds (set in `vercel.json`) | `vercel.json` |
| Request body limit | 4.5 MB on Vercel, so our file limit is 4 MB | `DEPLOY.md` section 10 |
| Database | MongoDB Atlas M0, 512 MB storage, 500 connections | `DEPLOY.md` section 10 |
| Connections per function instance | at most 5 | `server/config/db.js` (`maxPoolSize: 5`) |
| Storage per account | 25 MB by default (`STORAGE_QUOTA_MB`) | `server/utils/storage.js` |
| Files per upload dialog | 10 | `client/src/utils/uploadSelection.js` |
| Upload speed limit per account | 120 per minute, 600 per hour | `server/utils/uploadLimits.js` |
| Documents per account | 2,000 | `server/utils/uploadLimits.js` |
| Emails per day for the whole app | 300 (`MAIL_DAILY_CAP`), bulk mail stops at 150 (`MAIL_BULK_SHARE` 0.5) | `server/utils/mailBudget.js`, `DEPLOY.md` |
| Cron jobs | two, once a day each (Trash purge 03:17 UTC, reminders 01:00 UTC) | `vercel.json` |

The Atlas region and the Vercel function region are set in the dashboards, not in the repo. The owner confirmed in the dashboards that the function
region is `sin1` and the Atlas database is in Singapore. `vercel.json` sets no region.

## What we measured

On a laptop, with a local throwaway MongoDB and 2,000 seeded documents (from the earlier performance work, see
`docs/SCORING-AUDIT.md` section 2.6):

- The document list took about 142 ms in the median on the server. The whole list is sent in one JSON answer. There is no paging.
- The MongoDB profiler showed no collection scan during a visit to every page.
- We did **not** measure real Atlas latency, real Vercel cold starts, or anything with many users at the same time.

## What fills up first

1. **Atlas storage (512 MB).** All file bytes are in MongoDB. At the default 25 MB quota, about 20 full accounts would fill 512 MB
   (512 divided by 25). This is an estimate, and real accounts will usually use far less than the quota. Held files, Trash and old
   file versions all count.
2. **Email.** Free Gmail allows only a few hundred messages a day (we read "about 500"; check before quoting). We cap the whole app at
   300 a day.
3. **Database connections.** 500 connections divided by 5 per instance is about 100 warm instances at the same moment. This is an
   estimate. Vercel may run many instances if traffic jumps.
4. **Database writes.** Rate limit counters and the session sliding both write to the database on requests. We did not measure how
   many writes per second M0 allows.
5. **Cold starts.** The first request after a quiet time connects to the database and checks the index marker. We did not measure
   this on Vercel.

## 10x and 100x

Today we expect tens of users, not thousands. "10x" and "100x" below mean ten times and a hundred times a class-sized group (we
take about 30 users as the starting point, which is an assumption).

| Area | About 300 users (10x) | About 3,000 users (100x) |
|---|---|---|
| **Storage** | If everyone used the whole 25 MB, that is about 7.5 GB, far over 512 MB. Real use would be lower, but the free tier would not hold it. | About 75 GB at full use. MongoDB is the wrong place for this. Files need object storage. |
| **Email** | Sign-up and login codes could pass 300 a day on a busy day. Login codes are protected because bulk mail stops at 150 and the rest is kept for login codes. Sign-ups would be refused with a "busy" answer. | Gmail SMTP cannot work. A mail service with our own domain is needed (also needed for SPF, DKIM and DMARC). |
| **Connections** | Probably fine. | Likely to need a paid Atlas tier or a connection proxy [estimate]. |
| **Request volume** | Likely fine on Hobby, but we did not test it. Vercel Hobby is for personal, non-commercial use. A school project fits that. A commercial launch would not. | Needs a paid plan and tests. |
| **Cron** | Two daily jobs, one email per account per run, at most 40 emails per run. At 300 users the reminder job will take several runs to finish. | Needs a queue or worker. |
| **File list** | One JSON list per request is fine for hundreds of documents (the cap is 2,000). | Needs paging on the server. |
| **Abuse** | Per-account upload limits and the document cap stop one account from filling the database with tiny files. | Needs monitoring and a way to remove abusive accounts. We have no admin role. |

## Future strategy (not built)

1. Move file bytes to object storage with direct uploads. Keep metadata in MongoDB. This removes the 4.5 MB body limit and the
   512 MB storage limit.
2. Use a transactional email provider on a domain we own. Use a queue with retries.
3. Move rate limit counters to a store made for counters (Redis or similar) if database writes become the limit.
4. Move index changes to a deploy step, so they do not happen on a request.
5. Add paging for the file list.
6. Add a totals-only admin page (see `docs/FUTURE-WORK.md`). It would show counts, not content.

Every item here is a plan. None of it exists yet.

## Governance

### Who can see what

| Who | What they can see |
|---|---|
| The owner | Their own files, notes, activity and devices. |
| Someone with database access | File names, folder names, sizes, dates, email addresses and ciphertext. Not file contents, unless they also have a live session token or the Emergency Kit. |
| Someone who controls the running server | More than that, while a user is signed in (the server holds the vault key for each request). |
| A share link holder | Only the shared copies, decrypted in their browser. |
| An emergency contact | Only the chosen folders, read-only, after the waiting period and only if the owner did not deny. |

### Rules built into the code

- **Retention.** Activity log entries 30 days (`AUDIT_RETENTION_DAYS`, default 30). Trash 30 days, then removed. Older versions of a
  file 30 days. Sessions 30 minutes idle, 12 hours at most. Login codes about 5 minutes. Trusted browsers 30 days.
- **Sign-up mode.** `SIGNUP_MODE` must be set, as `invite` or `open`, or production refuses to start.
- **Emergency Access.** It is opt-in. It uses a key split (see `docs/THREAT-MODEL.md`). Waiting period 3, 7 or 14 days. The owner is
  emailed and can deny with one click. After a denial a new request is blocked for 24 hours. Sessions are read-only and last at most 4
  hours. Every step is in the owner's activity log.
- **Activity log.** A chain of HMAC signed entries per account. It holds ids only, no file names, no email addresses, no IP addresses.
- **Quarantine.** Risky uploads are held and need the owner to type RELEASE. Held files are hidden from every list, preview, share and
  export.
- **No admin role.** See `docs/ROLES-AND-RATE-LIMITS.md` for why. The cost is that nobody can fix an account for a user.

### Ethics and limits we state openly

- The operator can read metadata. We say so on the privacy page.
- The privacy page is a plain-language draft for a student project. It is not a reviewed legal document.
- No data protection officer is appointed (student project), and we have no written breach notification procedure. The Data Privacy Act of 2012
  (RA 10173) expects a process to tell the National Privacy Commission and affected people after a breach. This is listed as a gap in
  `docs/PRIVACY-AND-DPA.md`.
- We do not address use by children.
- Warden should not be used to store real sensitive documents until a reviewed version exists.
