const mongoose = require('mongoose');

const Document = require('../models/Document');
const Share = require('../models/Share');
const AuditEvent = require('../models/AuditEvent');
const Device = require('../models/Device');
const { recordEvent } = require('../utils/audit');
const { retentionDays } = require('../utils/auditConfig');
const { trashDocument } = require('../utils/trash');
const { readLabel } = require('./shares.controller');
const { readNote, versionSummary, listVersionRows } = require('./notesVersions.controller');
const { MAX_VERSIONS, VERSION_DAYS } = require('../utils/versions');
const { toListSummary, LIST_PROJECTION, moveItems } = require('./documents.controller');
const { NOT_HELD } = require('../utils/quarantineFilter');
const { describeReasons } = require('../utils/fileScanner');

const MAX_BATCH = 50;
const RECENT_LIMIT = 30;
const RECENT_TYPES = ['upload', 'view', 'download', 'rename', 'move', 'restore', 'expiry_set', 'expiry_cleared'];
const OPEN_TYPES = ['view', 'download'];

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function parseIds(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH) throw badRequest(`ids must be a list of 1 to ${MAX_BATCH} file ids.`);
  for (const id of ids) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 64) throw badRequest('Each id must be a text id.');
  }
  return [...new Set(ids)];
}

const asObjectIds = (ids) => ids.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

const setStarred = asyncHandler(async (req, res) => {
  const ids = parseIds(req.body);
  if (typeof req.body.starred !== 'boolean') throw badRequest('starred must be true or false.');
  const result = await Document.updateMany(
    { _id: { $in: asObjectIds(ids) }, userId: req.userId, deletedAt: null },
    { $set: { starred: req.body.starred } },
    { timestamps: false }
  );
  res.status(200).json({ starred: req.body.starred, updatedCount: result.matchedCount ?? 0 });
});

async function deviceLabels(userId, ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (wanted.length === 0) return new Map();
  const devices = await Device.find({ userId, _id: { $in: wanted } }).select('label');
  return new Map(devices.map((device) => [String(device._id), device.label]));
}

const listRecent = asyncHandler(async (req, res) => {
  const days = retentionDays();
  const latest = await AuditEvent.aggregate([
    { $match: { userId: req.userId, actor: null, targetId: { $ne: null }, type: { $in: RECENT_TYPES } } },
    { $sort: { at: -1 } },
    { $group: { _id: '$targetId', at: { $first: '$at' }, type: { $first: '$type' } } },
    { $sort: { at: -1 } },
    { $limit: RECENT_LIMIT * 3 },
  ]);
  const candidateIds = latest.map((row) => row._id).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (candidateIds.length === 0) return res.status(200).json({ retentionDays: days, items: [] });

  const [documents, opens] = await Promise.all([
    Document.aggregate([
      { $match: { _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) }, userId: req.userId, deletedAt: null, ...NOT_HELD } },
      { $project: LIST_PROJECTION },
    ]),
    AuditEvent.aggregate([
      { $match: { userId: req.userId, actor: null, targetId: { $in: candidateIds }, type: { $in: OPEN_TYPES } } },
      { $sort: { at: -1 } },
      { $group: { _id: '$targetId', at: { $first: '$at' }, deviceId: { $first: '$deviceId' } } },
    ]),
  ]);
  const byId = new Map(documents.map((doc) => [String(doc._id), doc]));
  const openOf = new Map(opens.map((row) => [row._id, row]));
  const rows = latest.filter((row) => byId.has(row._id)).slice(0, RECENT_LIMIT);
  const labels = await deviceLabels(req.userId, rows.map((row) => openOf.get(row._id)?.deviceId));
  const items = rows.map((row) => {
    const open = openOf.get(row._id);
    return {
      ...toListSummary(byId.get(row._id)),
      lastActivity: { type: row.type, at: row.at },
      lastOpenedAt: open?.at ?? null,
      openedOnDevice: open?.deviceId ? labels.get(String(open.deviceId)) ?? null : null,
      openedOnThisDevice: Boolean(open?.deviceId && req.deviceId && String(open.deviceId) === String(req.deviceId)),
    };
  });
  res.status(200).json({ retentionDays: days, items });
});

const getDetails = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error('Document not found.'), { status: 404 });
  const _id = new mongoose.Types.ObjectId(id);

  const [rows, shares, events, versionRows] = await Promise.all([
    Document.aggregate([
      { $match: { _id, userId: req.userId, deletedAt: null } },
      { $project: { ...LIST_PROJECTION, checksum: 1, noteCipher: 1, noteIv: 1, noteAuthTag: 1, scan: 1, quarantine: 1 } },
    ]),
    Share.find({ ownerUserId: req.userId, sourceDocumentIds: _id, ready: { $ne: false }, expiresAt: { $gt: new Date() } })
      .select('shareId expiresAt fileCount labelCipher labelIv labelAuthTag')
      .sort({ expiresAt: 1 }),
    AuditEvent.find({ userId: req.userId, actor: null, targetId: String(_id) }).sort({ at: -1 }).limit(5).select('type at deviceId'),
    listVersionRows(req.userId, _id),
  ]);
  const doc = rows[0];
  if (!doc) throw Object.assign(new Error('Document not found.'), { status: 404 });

  const labels = await deviceLabels(req.userId, [...events.map((event) => event.deviceId), ...versionRows.map((row) => row.deviceId)]);
  const purposes = [...new Set(shares.map((share) => readLabel(share, req.dek).purpose).filter(Boolean))];
  const summary = toListSummary(doc);
  res.status(200).json({
    id: summary.id,
    name: summary.filename,
    mimeType: summary.mimeType,
    type: summary.sniffedType,
    size: summary.size,
    folder: summary.folder,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    expiresAt: summary.docExpiresAt,
    daysUntilExpiry: summary.daysUntilExpiry,
    expiryStatus: summary.expiryStatus,
    starred: summary.starred,
    shared: { count: shares.length, links: shares.map((share) => ({ expiresAt: share.expiresAt })) },
    purposes,
    fingerprint: typeof doc.checksum === 'string' ? doc.checksum.slice(0, 12) : null,
    scan: doc.scan?.verdict
      ? { verdict: doc.scan.verdict, reasons: describeReasons(doc.scan.reasons), version: doc.scan.scannerVersion ?? null, at: doc.scan.scannedAt ?? null, state: doc.quarantine?.state ?? null }
      : null,
    note: readNote(doc, req.dek),
    hasNote: summary.hasNote,
    versions: versionRows.map((row) => versionSummary(row, labels, req.deviceId)),
    versionLimits: { max: MAX_VERSIONS, days: VERSION_DAYS },
    activity: events.map((event) => ({
      type: event.type,
      at: event.at,
      device: event.deviceId ? labels.get(String(event.deviceId)) ?? null : null,
      thisDevice: Boolean(event.deviceId && req.deviceId && String(event.deviceId) === String(req.deviceId)),
    })),
  });
});

const batchMove = asyncHandler(async (req, res, next) => {
  const ids = parseIds(req.body);
  if (typeof req.body.destination !== 'string' || req.body.destination.length > 1000) throw badRequest('destination must be a folder path ("" for the top level).');
  req.body = { items: ids.map((id) => ({ type: 'file', id })), destination: req.body.destination };
  await moveItems(req, res, next);
});

const batchTrash = asyncHandler(async (req, res) => {
  const ids = parseIds(req.body);
  const results = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const trashed = await trashDocument(req.userId, id);
    if (!trashed) {
      results.push({ id, status: 'not_found', message: 'File not found.' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await recordEvent(req, 'delete', { targetId: id });
    results.push({ id, status: 'trashed' });
  }
  res.status(200).json({ trashedCount: results.filter((result) => result.status === 'trashed').length, results });
});

module.exports = { setStarred, listRecent, getDetails, batchMove, batchTrash, MAX_BATCH, RECENT_LIMIT, RECENT_TYPES };
