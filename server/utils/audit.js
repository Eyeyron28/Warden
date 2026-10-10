const crypto = require('crypto');

const AuditEvent = require('../models/AuditEvent');
const User = require('../models/User');
const { hmacKey, retentionMs } = require('./auditConfig');

/**
 * The activity log: what happened on an account, signed in a hash chain that detects edits and gaps.
 *
 * Every event stores `hash` = HMAC-SHA-256(AUDIT_HMAC_KEY, prevHash | its own fields), where prevHash is
 * the previous event's hash (empty for the first). The newest {seq, hash, at} is also kept on the user
 * ("auditHead"). Verifying walks the events that are left (the TTL removes only the oldest, so the oldest
 * remaining event's prevHash is the trusted starting point) and checks every link, then compares the end
 * with the head. That detects an edited event and a gap in the middle. It detects a cut-off end only while the
 * head still points at the old end.
 *
 * LIMIT (proved by a test in test/audit-limits.test.js): the head lives in the same database as the events, so
 * someone who can WRITE to the database can delete the newest events and move the head back to match, and the
 * check still passes. That needs no key. It also cannot protect against someone who holds the server's HMAC key,
 * and removing the very oldest events looks exactly like the normal 30-day expiry. Closing the first gap would
 * need the head kept somewhere the database writer cannot reach (an external anchor).
 *
 * No file names, e-mail addresses, share purposes, content or IP addresses are ever stored here.
 */

const MAX_APPEND_TRIES = 120; // every writer that loses adopts the winner's event, so a crowd still drains
let failureCount = 0;
let lastWarningAt = 0;

/** Failures of best-effort logging so far (for tests and for the warning below). */
const logFailures = () => failureCount;

const isDuplicateKey = (error) => error && (error.code === 11000 || /E11000/.test(String(error.message)));

/** The fields that are signed, in a fixed order. */
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
  // Only when set, so every event written before this field existed still verifies.
  if (event.actor) fields.push(event.actor);
  return JSON.stringify(fields);
}

function computeHash(prevHash, event) {
  return crypto.createHmac('sha256', hmacKey()).update(`${prevHash || ''}|${canonicalFields(event)}`).digest('hex');
}

const noHead = (head) => !head || !head.seq;

/** The compare-and-swap filter that matches exactly this head (including "no head yet"). */
function headFilter(userId, head) {
  if (noHead(head)) return { _id: userId, $or: [{ 'auditHead.seq': { $exists: false } }, { 'auditHead.seq': 0 }] };
  return { _id: userId, 'auditHead.seq': head.seq, 'auditHead.hash': head.hash };
}

async function readHead(userId) {
  const user = await User.findById(userId).select('auditHead');
  return user ? { seq: user.auditHead?.seq || 0, hash: user.auditHead?.hash || '' } : null;
}

/**
 * Adds one event to a user's chain. Safe under concurrency: the next number is claimed by inserting the
 * event (a unique index on {userId, seq} lets only one writer have it), then the head is moved with a
 * compare-and-swap. A writer that loses the race adopts the winner's event as the head and tries again.
 * If a writer died between the insert and the head move, the next writer repairs the head the same way.
 *
 * @returns {Promise<{ seq: number, hash: string }>}
 */
async function appendEvent({ userId, deviceId = null, type, targetId = null, country = null, actor = null, at = new Date() }) {
  for (let attempt = 0; attempt < MAX_APPEND_TRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const head = await readHead(userId);
    if (!head) throw new Error('No such account.');

    const event = { userId, seq: head.seq + 1, type, deviceId, targetId, at, country, actor };
    const hash = computeHash(head.hash, event);
    try {
      // eslint-disable-next-line no-await-in-loop
      // The actor field exists only on events an Emergency Access contact caused, so every other row keeps its old shape.
      const stored = { ...event };
      if (!actor) delete stored.actor;
      await AuditEvent.create({
        ...stored,
        prevHash: head.hash,
        hash,
        expiresAt: new Date(new Date(at).getTime() + retentionMs()),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Somebody else has this number. Make the head catch up to it and go round again.
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

/** A two-letter country code from the hosting platform's header, or null (always null in development). */
function countryFrom(req) {
  const raw = req?.headers?.['x-vercel-ip-country'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

/** A city name from the hosting platform's header (it arrives URL-encoded), or null. Never stored in events. */
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

/**
 * The one helper every controller uses. BEST EFFORT: it never throws and never delays the user's action
 * longer than one write; a failure is counted and warned about (without any personal data) and the
 * action goes on.
 *
 * @param {import('express').Request | null} req signed-in request (userId, deviceId) - or pass `userId` in options
 * @param {string} type one of EVENT_TYPES (utils/auditTypes.js)
 * @param {{ targetId?: any, userId?: any, deviceId?: any, country?: string | null }} [options]
 */
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

/**
 * Walks one account's remaining events and checks the chain.
 *
 * @returns {Promise<{
 *   ok: boolean, checked: number, firstSeq: number | null, lastSeq: number | null,
 *   brokenAtSeq: number | null, reason: string | null,
 * }>}
 */
async function verifyChain(userId) {
  const user = await User.findById(userId).select('auditHead');
  const head = { seq: user?.auditHead?.seq || 0, hash: user?.auditHead?.hash || '', at: user?.auditHead?.at || null };
  const events = await AuditEvent.find({ userId }).sort({ seq: 1 });
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const result = { ok: true, checked: ordered.length, firstSeq: null, lastSeq: null, brokenAtSeq: null, reason: null };
  const broken = (seq, reason) => ({ ...result, ok: false, brokenAtSeq: seq, reason });

  if (ordered.length === 0) {
    // Nothing left to check: fine if the newest event is old enough to have expired on its own,
    // otherwise the end of the log has been cut off.
    const expiredByAge = !head.at || Date.now() - new Date(head.at).getTime() > retentionMs();
    return head.seq === 0 || expiredByAge ? result : broken(head.seq, 'The newest events are missing.');
  }

  result.firstSeq = ordered[0].seq;
  result.lastSeq = ordered[ordered.length - 1].seq;
  // The oldest remaining event's prevHash is the trusted anchor (older ones expired).
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
  // last.seq > head.seq happens only if a write stopped between saving an event and moving the head;
  // the chain above is valid, so it is accepted (the next event repairs the head).
  return result;
}

module.exports = { appendEvent, recordEvent, verifyChain, computeHash, countryFrom, cityFrom, logFailures, canonicalFields };
