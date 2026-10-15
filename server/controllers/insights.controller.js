const mongoose = require('mongoose');
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
  starred: Boolean(doc.starred),
});

const newestOpen = (a, b) => new Date(b.lastOpenedAt || 0) - new Date(a.lastOpenedAt || 0);

/** When a document was last touched: opened, or else created. */
const lastTouched = (doc) => new Date(doc.lastOpenedAt || doc.createdAt || 0).getTime();

/** Live (not trashed) documents of one account, with only the fields the insights need. */
function liveDocuments(userId) {
  return Document.find({ userId, deletedAt: LIVE.deletedAt }).select('filename folder viewCount downloadCount lastOpenedAt createdAt starred');
}

/**
 * The most-opened files in the last 30 days, from the activity log ("Frequently used"). Falls back to the
 * newest-opened files when the log has nothing yet. Trashed and deleted files never appear.
 */
async function frequentFor(userId, knownDocs, now = new Date()) {
  const since = new Date(now.getTime() - FREQUENT_WINDOW_DAYS * DAY_MS);
  // Counted inside MongoDB over the last 30 days of this account's `view` events (an index serves it), instead of
  // reading every `view` event the account ever had into memory and counting them here.
  const grouped = await AuditEvent.aggregate([
    { $match: { userId, type: 'view', targetId: { $ne: null }, at: { $gte: since } } },
    { $group: { _id: '$targetId', opens: { $sum: 1 } } },
    { $sort: { opens: -1 } },
    { $limit: 50 },
  ]);
  const counts = new Map(grouped.map((row) => [String(row._id), row.opens]));
  // Overview already holds every live document; "Frequently used" on its own asks only for the few it can show: the
  // most-opened ones, and (for the fallback below) the ones opened in the window.
  const docs =
    knownDocs ||
    (await Document.find({
      userId,
      deletedAt: LIVE.deletedAt,
      $or: [{ _id: { $in: [...counts.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id)) } }, { viewCount: { $gt: 0 }, lastOpenedAt: { $gte: since } }],
    }).select('filename folder viewCount downloadCount lastOpenedAt createdAt starred'));
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const ranked = [...counts.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, opens]) => ({ ...brief(byId.get(id)), opens }))
    .sort((a, b) => b.opens - a.opens || newestOpen(a, b));
  // Starred files come first (each group keeps its own order: most opened, then newest).
  const starredFirst = (list) => [...list].sort((a, b) => Number(b.starred) - Number(a.starred));
  if (ranked.length > 0) return starredFirst(ranked).slice(0, TOP);
  return starredFirst(docs
    .filter((doc) => (doc.viewCount || 0) > 0 && doc.lastOpenedAt && new Date(doc.lastOpenedAt) >= since)
    .sort(newestOpen)
    .map((doc) => ({ ...brief(doc), opens: doc.viewCount || 0 })))
    .slice(0, TOP);
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
  res.status(200).json({ items: await frequentFor(req.userId, null) });
});

module.exports = { getOverview, getStale, getFrequent, staleOf, frequentFor, sharingStats, STALE_DAYS };
