const mongoose = require('mongoose');

const Device = require('../models/Device');
const Document = require('../models/Document');
const Share = require('../models/Share');
const TrustedDevice = require('../models/TrustedDevice');
const AuditEvent = require('../models/AuditEvent');
const { EVENT_TYPES } = require('../utils/auditTypes');
const { recordEvent, verifyChain } = require('../utils/audit');
const { destroySessionsForDevice, destroyOtherSessions } = require('../utils/sessionStore');
const { computeFlags, FLAG_LABELS } = require('../utils/suspicious');
const suspiciousConfig = require('../config/suspicious');
const { retentionDays } = require('../utils/auditConfig');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
const deviceNotFound = () => httpError(404, 'Device not found.');

const PAGE_SIZE = 50;
const MAX_EVENTS_READ = 5000;

/** Event types by group, for the timeline filter. */
const GROUPS = Object.freeze({
  vault: ['upload', 'view', 'download', 'rename', 'move', 'delete', 'restore', 'trash_emptied', 'export', 'import', 'account_export'],
  sharing: ['share_created', 'share_revoked', 'share_opened', 'share_downloaded', 'shares_stopped_all'],
  account: ['login', 'login_failed', 'logout', 'otp_sent', 'password_changed', 'trusted_added', 'trusted_removed', 'device_signed_out'],
});

const FILE_TARGET_TYPES = new Set(['upload', 'view', 'download', 'rename', 'move', 'delete', 'restore']);
const SHARE_TARGET_TYPES = new Set(['share_created', 'share_revoked', 'share_opened', 'share_downloaded']);

/** A country's English name from its two-letter code ("PH" -> "Philippines"), or the code itself. */
function countryName(code) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

const toDeviceSummary = (device, currentId) => ({
  id: String(device._id),
  label: device.label,
  current: currentId !== null && String(device._id) === String(currentId),
  firstSeenAt: device.firstSeenAt,
  lastSeenAt: device.lastSeenAt,
  country: device.lastCountry || null,
  countryName: countryName(device.lastCountry),
  city: device.lastCity || null,
  trusted: Boolean(device.trusted),
  signedOutAt: device.signedOutAt || null,
});

/**
 * GET /api/security/devices
 * The browsers that have signed in to this account: label, first seen, last active, place, whether it
 * skips the emailed code, and which one is THIS browser. No ids or hashes that could be replayed.
 */
const listDevices = asyncHandler(async (req, res) => {
  const devices = await Device.find({ userId: req.userId });
  const rows = devices
    .map((device) => toDeviceSummary(device, req.deviceId))
    .sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  res.status(200).json({ devices: rows });
});

/**
 * POST /api/security/devices/:id/sign-out
 * Ends every session of ONE device and removes its trust, so it needs the password AND an emailed code
 * next time. Another account's device (or an unknown id) is a 404.
 */
const signOutDevice = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw deviceNotFound();
  const device = await Device.findOne({ _id: req.params.id, userId: req.userId });
  if (!device) throw deviceNotFound();

  const sessionsEnded = await destroySessionsForDevice(req.userId, device._id);
  await TrustedDevice.deleteMany({ userId: req.userId, deviceId: device._id });
  await Device.updateOne({ _id: device._id, userId: req.userId }, { $set: { signedOutAt: new Date(), trusted: false } });
  await recordEvent(req, 'device_signed_out', { targetId: device._id });
  res.status(200).json({ success: true, sessionsEnded, self: req.deviceId !== null && String(device._id) === String(req.deviceId) });
});

/**
 * POST /api/security/devices/:id/forget-trusted
 * Removes ONE browser's "skip the emailed code" trust. Its sessions stay; the next sign-in there asks for a code.
 */
const forgetTrustedDevice = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw deviceNotFound();
  const device = await Device.findOne({ _id: req.params.id, userId: req.userId });
  if (!device) throw deviceNotFound();
  await TrustedDevice.deleteMany({ userId: req.userId, deviceId: device._id });
  await Device.updateOne({ _id: device._id, userId: req.userId }, { $set: { trusted: false } });
  await recordEvent(req, 'trusted_removed', { targetId: device._id });
  res.status(200).json({ success: true });
});

/**
 * POST /api/security/devices/sign-out-others    Body: { forgetTrusted?: boolean }
 * Signs out every session except the one making this request. With `forgetTrusted`, every other browser
 * also loses its trust. The caller's own session and trust are untouched.
 */
const signOutOthers = asyncHandler(async (req, res) => {
  const { forgetTrusted } = req.body || {};
  if (forgetTrusted !== undefined && typeof forgetTrusted !== 'boolean') throw httpError(400, 'forgetTrusted must be true or false.');

  const sessionsEnded = await destroyOtherSessions(req.userId, req.session.idHash);
  const others = (await Device.find({ userId: req.userId })).filter((device) => String(device._id) !== String(req.deviceId));
  const now = new Date();
  for (const device of others) {
    // eslint-disable-next-line no-await-in-loop
    await Device.updateOne({ _id: device._id, userId: req.userId }, { $set: { signedOutAt: now, ...(forgetTrusted ? { trusted: false } : {}) } });
    // eslint-disable-next-line no-await-in-loop
    await recordEvent(req, 'device_signed_out', { targetId: device._id });
  }
  if (forgetTrusted) {
    const mine = req.deviceId ? { userId: req.userId, deviceId: { $ne: req.deviceId } } : { userId: req.userId };
    const result = await TrustedDevice.deleteMany(mine);
    res.status(200).json({ success: true, sessionsEnded, devices: others.length, trustRemoved: result?.deletedCount ?? 0 });
    return;
  }
  res.status(200).json({ success: true, sessionsEnded, devices: others.length, trustRemoved: 0 });
});

const parseDate = (value, label) => {
  if (value === undefined || value === '') return null;
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) throw httpError(400, `${label} must be a date.`);
  return date;
};

/** Names for the events on one page, looked up now (never stored in the log). */
async function resolveTargets(userId, events) {
  const fileIds = [...new Set(events.filter((e) => FILE_TARGET_TYPES.has(e.type) && mongoose.Types.ObjectId.isValid(e.targetId)).map((e) => String(e.targetId)))];
  const shareIds = [...new Set(events.filter((e) => SHARE_TARGET_TYPES.has(e.type) && e.targetId).map((e) => String(e.targetId)))];
  const documents = fileIds.length ? await Document.find({ _id: { $in: fileIds }, userId }).select('filename deletedAt') : [];
  const shares = shareIds.length ? await Share.find({ ownerUserId: userId, shareId: { $in: shareIds } }).select('shareId sourceDocumentIds fileCount') : [];
  const firstDocIds = shares.map((share) => share.sourceDocumentIds?.[0]).filter(Boolean);
  const shareDocs = firstDocIds.length ? await Document.find({ _id: { $in: firstDocIds }, userId }).select('filename') : [];
  const docName = new Map([...documents, ...shareDocs].map((doc) => [String(doc._id), doc.filename]));
  const docById = new Map(documents.map((doc) => [String(doc._id), doc]));
  const shareById = new Map(shares.map((share) => [String(share.shareId), share]));
  return { docName, docById, shareById };
}

function describeTarget(event, lookup) {
  if (FILE_TARGET_TYPES.has(event.type)) {
    if (!event.targetId) return { kind: 'folder', name: null, gone: false };
    const doc = lookup.docById.get(String(event.targetId));
    return doc ? { kind: 'file', name: doc.filename, gone: false } : { kind: 'file', name: null, gone: true };
  }
  if (SHARE_TARGET_TYPES.has(event.type) && event.targetId) {
    const share = lookup.shareById.get(String(event.targetId));
    if (!share) return { kind: 'share', name: null, gone: true };
    const first = share.sourceDocumentIds?.[0];
    return { kind: 'share', name: (first && lookup.docName.get(String(first))) || null, gone: false, fileCount: share.fileCount || null };
  }
  if (event.type === 'device_signed_out' || event.type === 'trusted_removed') return { kind: 'device', name: null, gone: false };
  return { kind: 'none', name: null, gone: false };
}

/**
 * GET /api/security/activity?device=&group=vault|sharing|account&flagged=1&from=&to=&before=<seq>&limit=
 * Newest first, 50 a page (`before` is the seq of the last row of the previous page). Each row has what
 * happened, which device, from which country, when, and any suspicious flags. File and share names are
 * looked up now; a deleted file shows as "deleted file". Only this account's events are ever read.
 */
const listActivity = asyncHandler(async (req, res) => {
  const { device, group, before, flagged } = req.query;
  if (group !== undefined && group !== '' && !GROUPS[group]) throw httpError(400, 'group must be vault, sharing or account.');
  if (device !== undefined && device !== '' && (typeof device !== 'string' || !mongoose.Types.ObjectId.isValid(device))) throw httpError(400, 'device must be a device id.');
  const from = parseDate(req.query.from, 'from');
  const to = parseDate(req.query.to, 'to');
  const beforeSeq = before === undefined || before === '' ? null : Number(before);
  if (beforeSeq !== null && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) throw httpError(400, 'before must be an event number.');
  const asked = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), PAGE_SIZE) : PAGE_SIZE;

  const stored = await AuditEvent.find({ userId: req.userId }).sort({ seq: -1 }).limit(MAX_EVENTS_READ);
  const all = [...stored].sort((a, b) => b.seq - a.seq);
  const flagMap = computeFlags(all);

  const matching = all.filter((event) => {
    if (beforeSeq !== null && event.seq >= beforeSeq) return false;
    if (group && !GROUPS[group].includes(event.type)) return false;
    if (device && String(event.deviceId) !== String(device)) return false;
    if (flagged === '1' && !flagMap.has(event.seq)) return false;
    if (from && new Date(event.at) < from) return false;
    if (to && new Date(event.at) > to) return false;
    return true;
  });
  const page = matching.slice(0, limit);

  const devices = await Device.find({ userId: req.userId });
  const deviceById = new Map(devices.map((d) => [String(d._id), d]));
  const lookup = await resolveTargets(req.userId, page);

  const rows = page.map((event) => {
    const dev = event.deviceId ? deviceById.get(String(event.deviceId)) : null;
    return {
      id: String(event._id),
      seq: event.seq,
      type: event.type,
      at: event.at,
      country: event.country || null,
      countryName: countryName(event.country),
      device: dev ? { id: String(dev._id), label: dev.label, current: req.deviceId !== null && String(dev._id) === String(req.deviceId) } : null,
      target: describeTarget(event, lookup),
      flags: (flagMap.get(event.seq) || []).map((flag) => ({ code: flag, label: FLAG_LABELS[flag] })),
    };
  });

  const since = Date.now() - suspiciousConfig.bannerLookbackMs;
  const flaggedRecent = all.filter((event) => flagMap.has(event.seq) && new Date(event.at).getTime() >= since).length;

  res.status(200).json({
    events: rows,
    nextBefore: matching.length > limit ? page[page.length - 1].seq : null,
    flaggedRecent,
    retentionDays: retentionDays(),
  });
});

/**
 * POST /api/security/verify-log
 * Walks this account's remaining events and checks the hash chain. Says "intact" or where it is broken. It
 * detects edits to the database; it cannot protect against someone who also holds the server's signing key.
 */
const verifyLog = asyncHandler(async (req, res) => {
  const result = await verifyChain(req.userId);
  res.status(200).json({ ...result, retentionDays: retentionDays() });
});

// What the browser itself may report: a zip export or import happens entirely in the page, so the page says so.
const CLIENT_EVENTS = new Set(['export', 'import', 'account_export']);

/** POST /api/security/client-event    Body: { type: 'export' | 'import' | 'account_export' } */
const clientEvent = asyncHandler(async (req, res) => {
  const { type } = req.body || {};
  if (typeof type !== 'string' || !CLIENT_EVENTS.has(type) || !EVENT_TYPES.includes(type)) throw httpError(400, 'Unknown event.');
  await recordEvent(req, type);
  res.status(204).send();
});

module.exports = {
  listDevices,
  signOutDevice,
  forgetTrustedDevice,
  signOutOthers,
  listActivity,
  verifyLog,
  clientEvent,
  GROUPS,
  PAGE_SIZE,
};
