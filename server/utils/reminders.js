const Document = require('../models/Document');
const User = require('../models/User');
const ReminderLog = require('../models/ReminderLog');
const { LIVE } = require('./storage');
const { THRESHOLDS, daysUntil, dueThreshold, thresholdsCovered } = require('./docExpiry');
const { sendEmail } = require('./email');
const { dropReminders } = require('./reminderCleanup');
const { templates } = require('./emailTemplates');

// One run must fit a Vercel Hobby function (30 s): stop starting new users after DEADLINE_MS, and cap the
// emails per run. Whatever is left is simply picked up by the next run, because nothing is marked until a user
// is handled.
const DEADLINE_MS = 20 * 1000;
const MAX_EMAILS = 40;
const WINDOW_DAYS = THRESHOLDS[0];

const isDuplicate = (err) => err && (err.code === 11000 || /E11000/.test(String(err.message)));

/**
 * Works out, for one account, which files are due a reminder, claims them (insert-first under the unique
 * (userId, fileId, threshold) index, so two overlapping runs can never both send), and returns the buckets.
 */
async function claimFor(userId, documents, now) {
  const claimed = []; // { fileId, threshold }
  for (const doc of documents) {
    const days = daysUntil(doc.docExpiresAt, now);
    const due = dueThreshold(days);
    if (due === null) continue;
    // Marks every threshold at or above the due one; only the due one is "sent" and counted. The larger ones are
    // behind the file already (it was set close to its date) and must never fire later for the same date.
    let won = false;
    for (const threshold of thresholdsCovered(due)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ReminderLog.create({ userId, fileId: doc._id, threshold, sent: threshold === due });
        if (threshold === due) won = true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
    }
    if (won) claimed.push({ fileId: doc._id, threshold: due, days });
  }
  return claimed;
}

/** Buckets for the email: how many files are expired, due within 7, 30 and 60 days. Counts only. */
function bucketsOf(claimed) {
  const counts = { expired: 0, within7: 0, within30: 0, within60: 0 };
  for (const item of claimed) {
    if (item.days <= 0) counts.expired += 1; // the day itself and past it
    else if (item.threshold === 7) counts.within7 += 1;
    else if (item.threshold === 30) counts.within30 += 1;
    else counts.within60 += 1;
  }
  return counts;
}

/**
 * Mongo's TTL index removes purged Trash files without telling us, so rows for files that no longer exist are
 * swept here (they are harmless but would otherwise stay forever).
 */
async function pruneOrphans() {
  const ids = await ReminderLog.distinct('fileId');
  if (ids.length === 0) return 0;
  const existing = new Set((await Document.distinct('_id', { _id: { $in: ids } })).map(String));
  return dropReminders(null, ids.filter((id) => !existing.has(String(id))));
}

/**
 * The daily reminder job. Idempotent: running it twice sends once. Logs and returns COUNTS only; it never
 * writes an email address or a file name anywhere.
 *
 * @returns {Promise<{ users: number, emails: number, files: number, failed: number, skippedOptOut: number, remaining: boolean }>}
 */
async function runReminders({ now = new Date(), deadlineMs = DEADLINE_MS, maxEmails = MAX_EMAILS } = {}) {
  const started = Date.now();
  const horizon = new Date(now.getTime() + (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
  const filter = { ...LIVE, docExpiresAt: { $lt: horizon } };
  const userIds = await Document.distinct('userId', filter);

  const pruned = await pruneOrphans().catch(() => 0);
  const result = { pruned, users: 0, emails: 0, files: 0, failed: 0, skippedOptOut: 0, remaining: false };
  for (const userId of userIds) {
    if (Date.now() - started > deadlineMs || result.emails >= maxEmails) {
      result.remaining = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findOne({ _id: userId }).select('email emailVerified expiryReminders');
    if (!user || !user.emailVerified) continue;
    if (user.expiryReminders === false) {
      result.skippedOptOut += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const documents = await Document.find({ userId, ...filter }).select('_id docExpiresAt');
    result.users += 1;
    // eslint-disable-next-line no-await-in-loop
    const claimed = await claimFor(userId, documents, now);
    if (claimed.length === 0) continue;

    // eslint-disable-next-line no-await-in-loop
    const sent = await sendEmail({ to: user.email, ...templates.expiringDocuments(bucketsOf(claimed)) }).catch(() => false);
    if (sent) {
      result.emails += 1;
      result.files += claimed.length;
    } else {
      // Not delivered: release the claim so the next run tries again.
      result.failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await ReminderLog.deleteMany({ userId, $or: claimed.map((item) => ({ fileId: item.fileId, threshold: item.threshold })) });
    }
  }
  console.log(`Reminders: ${result.users} accounts checked, ${result.emails} emails, ${result.files} documents, ${result.failed} failed, ${result.pruned} stale rows removed${result.remaining ? ', more next run' : ''}.`);
  return result;
}

module.exports = { runReminders, pruneOrphans, claimFor, bucketsOf, DEADLINE_MS, MAX_EMAILS };
