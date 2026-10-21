const crypto = require('crypto');

const AuditEvent = require('../models/AuditEvent');
const User = require('../models/User');
const { hmacKey, retentionMs } = require('./auditConfig');

const MAX_APPEND_TRIES = 120;
let failureCount = 0;
let lastWarningAt = 0;

const logFailures = () => failureCount;

const isDuplicateKey = (error) => error && (error.code === 11000 || /E11000/.test(String(error.message)));

function canonicalFields(event) {
  const fields = [
    String(event.userId),
    Number(event.seq),
    event.type,
    event.deviceId ? String(event.deviceId) : null,
    event.targetId ? String(event.targetId) : null,
    new Date(event.at).toISOString(),
    event.country || null,
  ];
  if (event.actor) fields.push(event.actor);
  if (event.detail) fields.push(`detail:${event.detail}`);
  return JSON.stringify(fields);
}

function computeHash(prevHash, event) {
  return crypto.createHmac('sha256', hmacKey()).update(`${prevHash || ''}|${canonicalFields(event)}`).digest('hex');
}

const noHead = (head) => !head || !head.seq;

function headFilter(userId, head) {
  if (noHead(head)) return { _id: userId, $or: [{ 'auditHead.seq': { $exists: false } }, { 'auditHead.seq': 0 }] };
  return { _id: userId, 'auditHead.seq': head.seq, 'auditHead.hash': head.hash };
}

async function readHead(userId) {
  const user = await User.findById(userId).select('auditHead');
  return user ? { seq: user.auditHead?.seq || 0, hash: user.auditHead?.hash || '' } : null;
}

async function appendEvent({ userId, deviceId = null, type, targetId = null, country = null, actor = null, detail = null, at = new Date() }) {
  for (let attempt = 0; attempt < MAX_APPEND_TRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const head = await readHead(userId);
    if (!head) throw new Error('No such account.');

    const event = { userId, seq: head.seq + 1, type, deviceId, targetId, at, country, actor, detail };
    const hash = computeHash(head.hash, event);
    try {
      // eslint-disable-next-line no-await-in-loop
      const stored = { ...event };
      if (!actor) delete stored.actor;
      if (!detail) delete stored.detail;
      await AuditEvent.create({
        ...stored,
        prevHash: head.hash,
        hash,
        expiresAt: new Date(new Date(at).getTime() + retentionMs()),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // eslint-disable-next-line no-await-in-loop
      const taken = await AuditEvent.findOne({ userId, seq: head.seq + 1 });
      if (taken) {
        // eslint-disable-next-line no-await-in-loop
        await User.updateOne(headFilter(userId, head), { $set: { auditHead: { seq: taken.seq, hash: taken.hash, at: taken.at } } });
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne(headFilter(userId, head), { $set: { auditHead: { seq: event.seq, hash, at } } });
    return { seq: event.seq, hash };
  }
  throw new Error('Could not append to the activity log (too much contention).');
}

function countryFrom(req) {
  const raw = req?.headers?.['x-vercel-ip-country'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

function cityFrom(req) {
  const raw = req?.headers?.['x-vercel-ip-city'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value || value.length > 120) return null;
  try {
    const decoded = decodeURIComponent(value).replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    return decoded ? decoded.slice(0, 80) : null;
  } catch {
    return null;
  }
}

async function recordEvent(req, type, options = {}) {
  try {
    const userId = options.userId ?? req?.userId;
    if (!userId) return null;
    return await appendEvent({
      userId,
      type,
      deviceId: options.deviceId !== undefined ? options.deviceId : req?.deviceId || null,
      targetId: options.targetId !== undefined && options.targetId !== null ? String(options.targetId) : null,
      country: options.country !== undefined ? options.country : countryFrom(req),
      actor: options.actor || null,
      detail: options.detail || null,
    });
  } catch (error) {
    failureCount += 1;
    const now = Date.now();
    if (now - lastWarningAt > 60 * 1000) {
      lastWarningAt = now;
      console.warn(`Activity log: ${failureCount} event(s) could not be recorded so far (the actions themselves went ahead).`);
    }
    return null;
  }
}

async function verifyChain(userId) {
  const user = await User.findById(userId).select('auditHead');
  const head = { seq: user?.auditHead?.seq || 0, hash: user?.auditHead?.hash || '', at: user?.auditHead?.at || null };
  const events = await AuditEvent.find({ userId }).sort({ seq: 1 });
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const result = { ok: true, checked: ordered.length, firstSeq: null, lastSeq: null, brokenAtSeq: null, reason: null };
  const broken = (seq, reason) => ({ ...result, ok: false, brokenAtSeq: seq, reason });

  if (ordered.length === 0) {
    const expiredByAge = !head.at || Date.now() - new Date(head.at).getTime() > retentionMs();
    return head.seq === 0 || expiredByAge ? result : broken(head.seq, 'The newest events are missing.');
  }

  result.firstSeq = ordered[0].seq;
  result.lastSeq = ordered[ordered.length - 1].seq;
  let expectedPrev = ordered[0].prevHash || '';
  let expectedSeq = ordered[0].seq;
  for (const event of ordered) {
    if (event.seq !== expectedSeq) return broken(expectedSeq, 'An event is missing from the middle of the log.');
    if ((event.prevHash || '') !== expectedPrev) return broken(event.seq, 'This event does not follow the one before it.');
    if (computeHash(event.prevHash || '', event) !== event.hash) return broken(event.seq, 'This event was changed after it was recorded.');
    expectedPrev = event.hash;
    expectedSeq += 1;
  }

  const last = ordered[ordered.length - 1];
  if (last.seq < head.seq) return broken(last.seq + 1, 'The newest events are missing.');
  if (last.seq === head.seq && last.hash !== head.hash) return broken(last.seq, 'The newest event does not match the log\'s recorded end.');
  return result;
}

module.exports = { appendEvent, recordEvent, verifyChain, computeHash, countryFrom, cityFrom, logFailures, canonicalFields };
