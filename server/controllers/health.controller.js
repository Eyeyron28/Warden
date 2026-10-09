const Document = require('../models/Document');
const Share = require('../models/Share');
const TrustedDevice = require('../models/TrustedDevice');
const AuditEvent = require('../models/AuditEvent');
const User = require('../models/User');
const { LIVE, TRASHED } = require('../utils/storage');
const { computeFlags } = require('../utils/suspicious');
const { computeVaultHealth } = require('../utils/vaultHealth');
const { daysUntil } = require('../utils/docExpiry');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAY = 24 * 60 * 60 * 1000;
const MAX_EVENTS_READ = 2000;

/** The facts the score is made of, for ONE account. Counts only; nothing about other accounts is read. */
async function gatherFacts(userId, now = new Date()) {
  const activeShare = { ownerUserId: userId, ready: true, expiresAt: { $gt: now } };
  const [openShares, oldShares, trusted, events, dated, trashNearPurge, user] = await Promise.all([
    Share.countDocuments({ ...activeShare, passwordVerifierHash: null, recipientEmail: null }),
    Share.countDocuments({ ...activeShare, createdAt: { $lt: new Date(now.getTime() - 14 * DAY) } }),
    TrustedDevice.find({ userId, expiresAt: { $gt: now } }).select('lastUsedAt'),
    AuditEvent.find({ userId, at: { $gte: new Date(now.getTime() - 30 * DAY) } }).sort({ seq: -1 }).limit(MAX_EVENTS_READ),
    Document.find({ userId, ...LIVE, docExpiresAt: { $ne: null } }).select('docExpiresAt'),
    Document.countDocuments({ userId, ...TRASHED, purgeAt: { $lte: new Date(now.getTime() + 7 * DAY) } }),
    User.findById(userId).select('expiryReminders'),
  ]);

  const flagMap = computeFlags(events);
  const since = now.getTime() - 30 * DAY;
  const suspiciousFlags = events.filter((event) => flagMap.has(event.seq) && new Date(event.at).getTime() >= since).length;
  const days = dated.map((doc) => daysUntil(doc.docExpiresAt, now));

  return {
    openShares,
    oldShares,
    trustedBrowsers: trusted.length,
    staleTrusted: trusted.filter((row) => now.getTime() - new Date(row.lastUsedAt).getTime() >= 20 * DAY).length,
    suspiciousFlags,
    expiredDocs: days.filter((d) => d < 0).length,
    expiringDocs: days.filter((d) => d >= 0 && d <= 30).length,
    remindersOn: user?.expiryReminders !== false,
    hasExpiryDates: dated.length > 0,
    trashNearPurge,
  };
}

/** GET /api/account/health - the caller's own score and checklist. */
const getHealth = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(computeVaultHealth(await gatherFacts(req.userId)));
});

/** GET /api/account/preferences */
const getPreferences = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('expiryReminders');
  res.status(200).json({ expiryReminders: user?.expiryReminders !== false });
});

/** PATCH /api/account/preferences  { expiryReminders: boolean } */
const updatePreferences = asyncHandler(async (req, res) => {
  const { expiryReminders } = req.body || {};
  if (typeof expiryReminders !== 'boolean') {
    const error = new Error('expiryReminders must be true or false.');
    error.status = 400;
    throw error;
  }
  await User.updateOne({ _id: req.userId }, { $set: { expiryReminders } });
  res.status(200).json({ expiryReminders });
});

module.exports = { getHealth, getPreferences, updatePreferences, gatherFacts };
