const Document = require('../models/Document');
const Share = require('../models/Share');
const AuditEvent = require('../models/AuditEvent');
const { LIVE } = require('../utils/storage');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 180;
const TOP = 5;
const RECENT = 10;
const FREQUENT_WINDOW_DAYS = 30;
const EXPIRING_SOON_DAYS = 7;
const MAX_STALE_LIST = 300;

/** What the Overview shows for one document; never any content. */
const brief = (doc) => ({
  id: String(doc._id),
  filename: doc.filename,
  folder: doc.folder,
  viewCount: doc.viewCount || 0,
  downloadCount: doc.downloadCount || 0,
  lastOpenedAt: doc.lastOpenedAt || null,
  createdAt: doc.createdAt,
});

const newestOpen = (a, b) => new Date(b.lastOpenedAt || 0) - new Date(a.lastOpenedAt || 0);

/** When a document was last touched: opened, or else created. */
const lastTouched = (doc) => new Date(doc.lastOpenedAt || doc.createdAt || 0).getTime();

/** Live (not trashed) documents of one account, with only the fields the insights need. */
function liveDocuments(userId) {
  return Document.find({ userId, deletedAt: LIVE.deletedAt }).select('filename folder viewCount downloadCount lastOpenedAt createdAt');
}

/**
 * The most-opened files in the last 30 days, from the activity log ("Frequently used"). Falls back to the
 * newest-opened files when the log has nothing yet. Trashed and deleted files never appear.
 */
async function frequentFor(userId, docs, now = new Date()) {
  const since = new Date(now.getTime() - FREQUENT_WINDOW_DAYS * DAY_MS);
  const events = (await AuditEvent.find({ userId, type: 'view' })).filter((event) => event.targetId && new Date(event.at) >= since);
  const counts = new Map();
  for (const event of events) counts.set(String(event.targetId), (counts.get(String(event.targetId)) || 0) + 1);
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const ranked = [...counts.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, opens]) => ({ ...brief(byId.get(id)), opens }))
    .sort((a, b) => b.opens - a.opens || newestOpen(a, b));
  if (ranked.length > 0) return ranked.slice(0, TOP);
  return docs
    .filter((doc) => (doc.viewCount || 0) > 0 && doc.lastOpenedAt && new Date(doc.lastOpenedAt) >= since)
    .sort(newestOpen)
    .slice(0, TOP)
    .map((doc) => ({ ...brief(doc), opens: doc.viewCount || 0 }));
}

/** Files not opened (or, never opened, not created) for at least `days`, oldest first. */
function staleOf(docs, now = new Date(), days = STALE_DAYS) {
  const cutoff = now.getTime() - days * DAY_MS;
  return docs
    .filter((doc) => lastTouched(doc) <= cutoff)
    .sort((a, b) => lastTouched(a) - lastTouched(b))
    .map((doc) => ({ ...brief(doc), idleDays: Math.floor((now.getTime() - lastTouched(doc)) / DAY_MS) }));
}

/** Link statistics from the share records: counts and a file name only, never who opened them. */
async function sharingStats(userId, now = new Date()) {
  const shares = await Share.find({ ownerUserId: userId, ready: { $ne: false }, expiresAt: { $gt: now } }).select('shareId openCount lastOpenedAt expiresAt sourceDocumentIds fileCount');
  const soon = now.getTime() + EXPIRING_SOON_DAYS * DAY_MS;
  const opened = shares.filter((share) => (share.openCount || 0) > 0).sort((a, b) => b.openCount - a.openCount || newestOpen(a, b));
  const top = opened[0] || null;
  let topName = null;
  if (top?.sourceDocumentIds?.[0]) {
    const doc = await Document.findOne({ _id: top.sourceDocumentIds[0], userId, deletedAt: LIVE.deletedAt }).select('filename');
    topName = doc?.filename || null;
  }
  return {
    active: shares.length,
    neverOpened: shares.filter((share) => !share.openCount).length,
    expiringSoon: shares.filter((share) => new Date(share.expiresAt).getTime() <= soon).length,
    mostOpened: top ? { openCount: top.openCount, name: topName, fileCount: top.fileCount || null, lastOpenedAt: top.lastOpenedAt || null } : null,
  };
}

/**
 * GET /api/insights/overview
 * Everything the Overview page shows, from this account's own counters and events. Trashed files are left out
 * (the same "live" rule the file list and the quota use).
 */
const getOverview = asyncHandler(async (req, res) => {
  const now = new Date();
  const docs = await liveDocuments(req.userId);
  const byViews = [...docs].filter((d) => (d.viewCount || 0) > 0).sort((a, b) => b.viewCount - a.viewCount || newestOpen(a, b));
  const byDownloads = [...docs].filter((d) => (d.downloadCount || 0) > 0).sort((a, b) => b.downloadCount - a.downloadCount || newestOpen(a, b));
  const recent = [...docs].filter((d) => d.lastOpenedAt).sort(newestOpen);
  const stale = staleOf(docs, now);
  res.status(200).json({
    totals: { files: docs.length },
    mostViewed: byViews.slice(0, TOP).map(brief),
    mostDownloaded: byDownloads.slice(0, TOP).map(brief),
    recentlyOpened: recent.slice(0, RECENT).map(brief),
    frequent: await frequentFor(req.userId, docs, now),
    stale: { count: stale.length, days: STALE_DAYS },
    sharing: await sharingStats(req.userId, now),
  });
});

/** GET /api/insights/stale - the files behind the "stale" count, oldest first (at most 300). */
const getStale = asyncHandler(async (req, res) => {
  const docs = await liveDocuments(req.userId);
  const stale = staleOf(docs);
  res.status(200).json({ days: STALE_DAYS, total: stale.length, items: stale.slice(0, MAX_STALE_LIST) });
});

/** GET /api/insights/frequent - the "Frequently used" row of My files (at most 5; empty when nothing was opened). */
const getFrequent = asyncHandler(async (req, res) => {
  const docs = await liveDocuments(req.userId);
  res.status(200).json({ items: await frequentFor(req.userId, docs) });
});

module.exports = { getOverview, getStale, getFrequent, staleOf, frequentFor, sharingStats, STALE_DAYS };
