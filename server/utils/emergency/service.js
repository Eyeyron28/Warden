const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../../models/User');
const { logSecurity } = require('../securityLog');
const Folder = require('../../models/Folder');
const Session = require('../../models/Session');
const OtpChallenge = require('../../models/OtpChallenge');
const EmergencyAccess = require('../../models/EmergencyAccess');
const EmergencyRequest = require('../../models/EmergencyRequest');
const { createSession, destroySession, destroyEmergencySessions } = require('../sessionStore');
const { startChallenge, consumeChallenge, resendChallenge, PURPOSES: OTP_PURPOSES, expectedSendMs } = require('../otpChallenge');
const { consumeBudget, isBudgetExhausted } = require('../../middleware/rateLimit');
const { ipKey } = require('../clientIp');
const { sendEmail, normalizeRecipient } = require('../email');
const { templates } = require('../emailTemplates');
const { recordEvent, countryFrom } = require('../audit');
const { getPublicAppUrl } = require('../publicAppUrl');
const { fullPathOf } = require('../folders');
const AuditEvent = require('../../models/AuditEvent');
const { aliasesFor } = require('./scope');
const config = require('./config');
const kitLib = require('./kit');
const codes = require('./codes');

const ACTIONS = Object.freeze(['setup', 'regenerate', 'revoke', 'approve-now']);
const GENERIC_FAILURE = 'The details or the code are not correct, or access is not available.';
const NEUTRAL_CODE_MESSAGE = 'If these details match an active setup, we sent a code to the contact’s email.';
const DAY = 24 * 60 * 60 * 1000;
const UNNOTIFIED_GRACE_MS = 2 * 60 * 1000;

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  if (status >= 500) error.expose = true;
  return Object.assign(error, extra);
}
const genericFailure = () => httpError(401, GENERIC_FAILURE);
const tooManyAttempts = () => httpError(429, 'Too many attempts. Please try again later.');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isId = (value) => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && /^[0-9a-f]{24}$/i.test(value);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const cleanEmail = (value) => (typeof value === 'string' ? normalizeRecipient(value) : null);

const ownerKey = (ownerEmail) => sha256(String(ownerEmail || '').trim().toLowerCase());

async function findAccessFor(ownerEmail, contactEmail) {
  if (!ownerEmail || !contactEmail) return null;
  const user = await User.findOne({ email: ownerEmail }).select('_id email');
  if (!user) return null;
  const access = await EmergencyAccess.findOne({ userId: user._id, status: 'active' });
  if (!access) return null;
  const same = crypto.timingSafeEqual(Buffer.from(sha256(access.contactEmail), 'hex'), Buffer.from(sha256(contactEmail), 'hex'));
  return same ? { access, user } : null;
}

const FAIL_PAIR = { name: 'emergency-fail-pair-ip', max: 8, windowMs: 60 * 60 * 1000 };
const FAIL_IP = { name: 'emergency-fail-ip', max: 25, windowMs: 60 * 60 * 1000 };
const CODE_MAILS_OWNER = { name: 'emergency-code-owner', max: 5, windowMs: 60 * 60 * 1000 };

const pairKey = (ownerEmail, contactEmail, ip) => sha256(`${ownerKey(ownerEmail)}|${sha256(String(contactEmail || '').trim().toLowerCase())}|${ipKey(ip)}`);

async function assertNotLocked(ownerEmail, contactEmail, ip) {
  if (await isBudgetExhausted({ ...FAIL_PAIR, key: pairKey(ownerEmail, contactEmail, ip) })) throw tooManyAttempts();
  if (await isBudgetExhausted({ ...FAIL_IP, key: ipKey(ip) })) throw tooManyAttempts();
}

async function noteFailure(ownerEmail, contactEmail, ip) {
  await consumeBudget({ ...FAIL_PAIR, key: pairKey(ownerEmail, contactEmail, ip) });
  await consumeBudget({ ...FAIL_IP, key: ipKey(ip) });
}

let sendMs = null;
async function timedSend(message) {
  const started = Date.now();
  const sent = await sendEmail(message);
  const took = Date.now() - started;
  sendMs = sendMs === null ? took : sendMs * 0.7 + took * 0.3;
  return sent;
}
const expectedMs = () => (sendMs === null ? expectedSendMs() : sendMs);

function denyUrlFor(token) {
  const origin = getPublicAppUrl();
  return origin && token ? `${origin}/api/emergency/public/deny/${token}` : null;
}

const finishFields = (now) => ({ active: false, finishedAt: now, expiresAt: new Date(now.getTime() + config.LIMITS.FINISHED_REQUEST_TTL_MS), denyTokenHash: null });

async function cancelOpenRequests(accessId, status = 'cancelled') {
  const now = new Date();
  const result = await EmergencyRequest.updateMany({ accessId, active: true, status: { $in: ['pending', 'released'] } }, { $set: { status, ...finishFields(now) } });
  return result?.modifiedCount ?? result?.nModified ?? 0;
}

const audit = (req, userId, type, extra = {}) => recordEvent(req || null, type, { userId, deviceId: null, actor: 'emergency', ...extra });

async function scopeFolders(userId, scope) {
  if (scope.mode !== 'folders') return [];
  const folders = await Folder.find({ _id: { $in: scope.folderIds }, userId });
  return folders.map((folder) => ({ id: String(folder._id), path: fullPathOf(folder) }));
}

function parseScope(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Choose what the contact may see.');
  if (raw.mode === 'all') return { mode: 'all', folderIds: [] };
  if (raw.mode !== 'folders') throw httpError(400, 'Scope must be the whole vault or chosen folders.');
  const ids = Array.isArray(raw.folderIds) ? raw.folderIds : null;
  if (!ids || ids.length === 0 || ids.length > config.LIMITS.MAX_SCOPE_FOLDERS || !ids.every(isId)) {
    throw httpError(400, `Choose between 1 and ${config.LIMITS.MAX_SCOPE_FOLDERS} folders.`);
  }
  return { mode: 'folders', folderIds: [...new Set(ids.map(String))] };
}

async function validateSetupInput(user, body) {
  const contactEmail = cleanEmail(body?.contactEmail);
  if (!contactEmail) throw httpError(400, 'Enter the contact’s email address.');
  if (contactEmail === String(user.email).toLowerCase()) throw httpError(400, 'The contact must be someone other than you.');
  const waitMinutes = Number(body?.waitMinutes);
  if (!config.allowedWaits().includes(waitMinutes)) {
    throw httpError(400, `The waiting period must be one of: ${config.allowedWaits().map((m) => `${m} minutes`).join(', ')}.`);
  }
  const label = typeof body?.contactLabel === 'string' ? body.contactLabel.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if ([...label].length > config.LIMITS.CONTACT_LABEL_MAX) throw httpError(400, `The contact’s name can be at most ${config.LIMITS.CONTACT_LABEL_MAX} characters.`);
  const scope = parseScope(body?.scope);
  if (scope.mode === 'folders') {
    const found = await Folder.countDocuments({ _id: { $in: scope.folderIds }, userId: user._id });
    if (found !== scope.folderIds.length) throw httpError(400, 'One of the chosen folders no longer exists.');
  }
  return { contactEmail, waitMinutes, contactLabel: label, scope };
}

async function startOwnerCode(req, action) {
  if (!ACTIONS.includes(action)) throw httpError(400, 'Unknown action.');
  const user = await User.findById(req.userId).select('_id email');
  if (!user) throw httpError(404, 'Account not found.');
  return startChallenge({ user, secret: crypto.randomBytes(32), purpose: OTP_PURPOSES.emergencySetup, accessId: action });
}

async function resendOwnerCode(req, challengeToken) {
  return resendChallenge({
    challengeToken,
    purpose: OTP_PURPOSES.emergencySetup,
    userId: req.userId,
    findUser: (id) => User.findById(id).select('_id email'),
  });
}

async function useOwnerCode(req, action, challengeToken, code) {
  const { claimed } = await consumeChallenge({ challengeToken, code, purpose: OTP_PURPOSES.emergencySetup, userId: req.userId });
  if (claimed.accessId !== action) throw genericFailure();
}

function describe(access, folders) {
  return {
    configured: true,
    contactEmail: access.contactEmail,
    contactLabel: access.contactLabel || '',
    waitMinutes: access.waitMinutes,
    scope: { mode: access.scope.mode, folders },
    kitVersion: access.kitVersion,
    createdAt: access.createdAt,
  };
}

async function setup(req, body, { challengeToken, code }) {
  const user = await User.findById(req.userId).select('_id email');
  if (!user) throw httpError(404, 'Account not found.');
  const existing = await EmergencyAccess.findOne({ userId: user._id });
  const replacing = Boolean(existing && existing.status === 'active' && body?.replace === true);
  if (existing && existing.status === 'active' && !replacing) throw httpError(409, 'Emergency access is already set up. Replace the kit or turn it off first.');
  const input = await validateSetupInput(user, body);
  await useOwnerCode(req, 'setup', challengeToken, code);

  if (replacing) {
    await cancelOpenRequests(existing._id);
    await destroyEmergencySessions(req.userId);
    await OtpChallenge.deleteMany({ userId: req.userId, purpose: { $in: Object.values(codes.PURPOSES) } });
    await audit(req, user._id, 'emergency_revoked', { targetId: existing._id });
    sendEmail({ to: existing.contactEmail, ...templates.emergencyContactKitChanged({ kind: 'revoked' }) }).catch(() => false);
  }
  const split = kitLib.createSplit(req.dek);
  if (existing) await EmergencyAccess.deleteOne({ _id: existing._id });
  const access = await EmergencyAccess.create({
    userId: user._id,
    contactEmail: input.contactEmail,
    contactLabel: input.contactLabel,
    waitMinutes: input.waitMinutes,
    scope: input.scope,
    ...split.stored,
    kitVersion: 1,
    status: 'active',
  });
  await audit(req, user._id, 'emergency_configured', { targetId: access._id });
  sendEmail({ to: user.email, ...templates.emergencyOwnerSetupChanged({ kind: 'configured', when: new Date() }) }).catch(() => false);
  return { ...describe(access, await scopeFolders(user._id, access.scope)), kit: kitLib.encodeKit(split.k1) };
}

async function regenerateKit(req, { challengeToken, code }) {
  const access = await EmergencyAccess.findOne({ userId: req.userId, status: 'active' });
  if (!access) throw httpError(404, 'Emergency access is not set up.');
  await useOwnerCode(req, 'regenerate', challengeToken, code);
  const split = kitLib.createSplit(req.dek);
  const updated = await EmergencyAccess.findOneAndUpdate(
    { _id: access._id, status: 'active' },
    { $set: { ...split.stored }, $inc: { kitVersion: 1 } },
    { new: true }
  );
  if (!updated) throw httpError(409, 'Emergency access changed. Please try again.');
  await cancelOpenRequests(access._id);
  await destroyEmergencySessions(req.userId);
  await OtpChallenge.deleteMany({ userId: req.userId, purpose: { $in: Object.values(codes.PURPOSES) } });
  await audit(req, req.userId, 'emergency_kit_regenerated', { targetId: access._id });
  const user = await User.findById(req.userId).select('email');
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerSetupChanged({ kind: 'regenerated', when: new Date() }) }).catch(() => false);
  sendEmail({ to: access.contactEmail, ...templates.emergencyContactKitChanged({ kind: 'regenerated' }) }).catch(() => false);
  return { ...describe(updated, await scopeFolders(req.userId, updated.scope)), kit: kitLib.encodeKit(split.k1) };
}

async function revoke(req, { challengeToken, code }) {
  const access = await EmergencyAccess.findOne({ userId: req.userId, status: 'active' });
  if (!access) throw httpError(404, 'Emergency access is not set up.');
  await useOwnerCode(req, 'revoke', challengeToken, code);
  const revoked = await EmergencyAccess.findOneAndUpdate(
    { _id: access._id, status: 'active' },
    { $set: { status: 'revoked', k2: crypto.randomBytes(32), wrappedDek: '', wrappedDekIv: '', wrappedDekAuthTag: '', kitHash: '', kitSalt: '' } }
  );
  if (!revoked) throw httpError(409, 'Emergency access changed. Please look again.');
  await cancelOpenRequests(access._id);
  await destroyEmergencySessions(req.userId);
  await OtpChallenge.deleteMany({ userId: req.userId, purpose: { $in: Object.values(codes.PURPOSES) } });
  await audit(req, req.userId, 'emergency_revoked', { targetId: access._id });
  const user = await User.findById(req.userId).select('email');
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerSetupChanged({ kind: 'revoked', when: new Date() }) }).catch(() => false);
  sendEmail({ to: access.contactEmail, ...templates.emergencyContactKitChanged({ kind: 'revoked' }) }).catch(() => false);
  return { configured: false };
}

async function status(req) {
  const access = await EmergencyAccess.findOne({ userId: req.userId, status: 'active' });
  const origin = getPublicAppUrl();
  const base = {
    allowedWaits: config.allowedWaits(),
    demoMode: config.demoMode(),
    claimDays: config.claimDays(),
    contactUrl: origin ? `${origin}/emergency` : null,
  };
  if (!access) return { ...base, configured: false };
  const request = await EmergencyRequest.findOne({ accessId: access._id, active: true, ownerNotifiedAt: { $ne: null } });
  const sessions = await Session.countDocuments({ userId: req.userId, emergency: true, expiresAt: { $gt: new Date() } });
  const started = await AuditEvent.find({ userId: req.userId, type: 'emergency_session_started', at: { $gte: new Date(Date.now() - 30 * DAY) } }).sort({ seq: -1 });
  return {
    ...base,
    ...describe(access, await scopeFolders(req.userId, access.scope)),
    request: request
      ? {
          id: String(request._id),
          status: request.status,
          requestedAt: request.requestedAt,
          releaseAt: request.releaseAt,
          claimExpiresAt: request.claimExpiresAt,
          approvedEarly: Boolean(request.approvedEarlyAt),
          released: request.status === 'released' || request.releaseAt.getTime() <= Date.now(),
        }
      : null,
    activeSessions: sessions,
    recentSessions: { last30Days: started.length, lastStartedAt: started[0]?.at ?? null },
  };
}

async function ownerDeny(req, requestId) {
  if (!isId(requestId)) throw httpError(404, 'Request not found.');
  const now = new Date();
  const denied = await EmergencyRequest.findOneAndUpdate(
    { _id: requestId, userId: req.userId, status: 'pending', active: true },
    { $set: { status: 'denied', deniedAt: now, deniedBy: 'owner', ...finishFields(now) } },
    { new: true }
  );
  if (!denied) throw httpError(409, 'This request can no longer be denied. If a session already started, turn emergency access off.');
  await audit(req, req.userId, 'emergency_denied', { targetId: denied._id });
  logSecurity('emergency_denied', { bucket: 'owner' });
  const user = await User.findById(req.userId).select('email');
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerDenied({ when: now }) }).catch(() => false);
  return { denied: true };
}

async function approveNow(req, requestId, { challengeToken, code }) {
  if (!isId(requestId)) throw httpError(404, 'Request not found.');
  const open = await EmergencyRequest.findOne({ _id: requestId, userId: req.userId, status: 'pending', active: true });
  if (!open) throw httpError(404, 'Request not found.');
  await useOwnerCode(req, 'approve-now', challengeToken, code);
  const now = new Date();
  const approved = await EmergencyRequest.findOneAndUpdate(
    { _id: open._id, status: 'pending', active: true },
    { $set: { releaseAt: now, approvedEarlyAt: now, claimExpiresAt: new Date(now.getTime() + config.claimDays() * DAY) } },
    { new: true }
  );
  if (!approved) throw httpError(409, 'This request changed. Please look again.');
  await audit(req, req.userId, 'emergency_approved_early', { targetId: approved._id });
  await noticeRelease(approved, { approvedEarly: true, audited: true });
  return { approved: true, releaseAt: approved.releaseAt };
}

async function noticeRelease(request, { approvedEarly = false, audited = false } = {}) {
  const claimed = await EmergencyRequest.findOneAndUpdate(
    { _id: request._id, releaseNoticedAt: null, status: { $in: ['pending', 'released'] }, active: true },
    { $set: { releaseNoticedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return false;
  const access = await EmergencyAccess.findOne({ _id: claimed.accessId, status: 'active' });
  const user = await User.findById(claimed.userId).select('email');
  if (access) sendEmail({ to: access.contactEmail, ...templates.emergencyContactAvailable({ claimDays: config.claimDays() }) }).catch(() => false);
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerReleased({ approvedEarly, claimDays: config.claimDays(), denyUrl: null }) }).catch(() => false);
  if (!audited) await audit(null, claimed.userId, 'emergency_released', { targetId: claimed._id });
  return true;
}

async function requestCode({ ownerEmail, contactEmail }) {
  const owner = cleanEmail(ownerEmail);
  const contact = cleanEmail(contactEmail);
  const started = Date.now();
  let real = false;
  if (owner && contact) {
    const found = await findAccessFor(owner, contact);
    if (found) {
      real = true;
      const withinBudget = await consumeBudget({ ...CODE_MAILS_OWNER, key: ownerKey(owner) });
      if (withinBudget) {
        const open = await EmergencyRequest.findOne({ accessId: found.access._id, active: true });
        const dead = open && !open.ownerNotifiedAt && open.requestedAt.getTime() < Date.now() - UNNOTIFIED_GRACE_MS;
        const purpose = open && !dead ? codes.PURPOSES.session : codes.PURPOSES.request;
        const startedSend = Date.now();
        await codes.issueContactCode({ access: found.access, purpose, to: found.access.contactEmail }).catch(() => false);
        const took = Date.now() - startedSend;
        sendMs = sendMs === null ? took : sendMs * 0.7 + took * 0.3;
      }
    }
  }
  if (!real) {
    await wait(expectedMs() * (0.85 + Math.random() * 0.3) - (Date.now() - started));
  }
  return { message: NEUTRAL_CODE_MESSAGE };
}

async function authenticateContact({ ownerEmail, contactEmail, kit, code, purpose, ip, consume }) {
  const owner = cleanEmail(ownerEmail);
  const contact = cleanEmail(contactEmail);
  const ownerTyped = owner || String(ownerEmail || '');
  const contactTyped = contact || String(contactEmail || '');
  await assertNotLocked(ownerTyped, contactTyped, ip);

  const found = owner && contact ? await findAccessFor(owner, contact) : null;
  const k1 = kitLib.parseKit(kit);
  const kitOk = kitLib.kitMatches(found?.access || null, k1);
  const codeCheck = await codes.checkContactCode({ access: found?.access || null, purpose, code });
  if (!found || !kitOk || !codeCheck.ok) {
    await noteFailure(ownerTyped, contactTyped, ip);
    throw genericFailure();
  }
  return { access: found.access, user: found.user, k1, codeId: codeCheck.id, consume: () => codes.consumeContactCode(codeCheck.id), ownerAddress: ownerTyped, contactAddress: contactTyped, consumeNow: consume };
}

async function submitRequest({ ownerEmail, contactEmail, code, kit, req }) {
  const auth = await authenticateContact({ ownerEmail, contactEmail, kit, code, purpose: codes.PURPOSES.request, ip: req?.ip });
  const { access, user } = auth;

  await EmergencyRequest.deleteMany({ accessId: access._id, active: true, ownerNotifiedAt: null, requestedAt: { $lt: new Date(Date.now() - UNNOTIFIED_GRACE_MS) } });

  const denied = await EmergencyRequest.findOne({ accessId: access._id, status: 'denied', deniedAt: { $gt: new Date(Date.now() - config.LIMITS.DENY_COOLDOWN_MS) } });
  if (denied) throw httpError(429, 'The owner denied the last request. You can ask again 24 hours after that.');
  if (await EmergencyRequest.findOne({ accessId: access._id, active: true })) {
    throw httpError(409, 'There is already an open request for this vault.');
  }
  if (!(await auth.consume())) {
    await noteFailure(auth.ownerAddress, auth.contactAddress, req?.ip);
    throw genericFailure();
  }

  const now = new Date();
  const waitMs = access.waitMinutes * 60 * 1000;
  const releaseAt = new Date(now.getTime() + waitMs);
  const denyToken = crypto.randomBytes(32).toString('base64url');
  let request;
  try {
    request = await EmergencyRequest.create({
      accessId: access._id,
      userId: access.userId,
      status: 'pending',
      active: true,
      requestedAt: now,
      releaseAt,
      claimExpiresAt: new Date(releaseAt.getTime() + config.claimDays() * DAY),
      ownerNotifiedAt: null,
      denyTokenHash: sha256(denyToken),
      requestCountry: countryFrom(req),
    });
  } catch (error) {
    if (error && (error.code === 11000 || /E11000/.test(String(error.message)))) throw httpError(409, 'There is already an open request for this vault.');
    throw error;
  }

  let notified = false;
  try {
    notified = (await sendEmail({ to: user.email, ...templates.emergencyOwnerRequestReceived({ releaseAt, denyUrl: denyUrlFor(denyToken) }) })) === true;
  } catch {
    notified = false;
  }
  if (!notified) {
    logSecurity('emergency_refused', { bucket: 'owner-notice-not-sent' });
    await EmergencyRequest.deleteOne({ _id: request._id });
    throw httpError(503, 'We could not process your request right now. Please try again later.');
  }

  const notifiedAt = new Date();
  const confirmedReleaseAt = new Date(notifiedAt.getTime() + waitMs);
  const confirmed = await EmergencyRequest.findOneAndUpdate(
    { _id: request._id, active: true, ownerNotifiedAt: null },
    { $set: { ownerNotifiedAt: notifiedAt, releaseAt: confirmedReleaseAt, claimExpiresAt: new Date(confirmedReleaseAt.getTime() + config.claimDays() * DAY) } },
    { new: true }
  );
  if (!confirmed) throw httpError(409, 'This request changed. Please try again.');
  await audit(req, access.userId, 'emergency_requested', { targetId: request._id, country: countryFrom(req) });
  sendEmail({ to: access.contactEmail, ...templates.emergencyContactReceipt({ releaseAt: confirmedReleaseAt }) }).catch(() => false);
  return { requested: true, releaseAt: confirmedReleaseAt };
}

async function startSession({ ownerEmail, contactEmail, code, kit, req }) {
  const auth = await authenticateContact({ ownerEmail, contactEmail, kit, code, purpose: codes.PURPOSES.session, ip: req?.ip });
  const { access, user, k1 } = auth;
  const now = new Date();

  let request = await EmergencyRequest.findOne({ accessId: access._id, active: true });
  if (!request) throw httpError(409, 'There is no open request. Request access first.', { code: 'NO_REQUEST' });
  if (!request.ownerNotifiedAt) throw httpError(403, 'Access is not available.', { code: 'NOT_AVAILABLE' });
  if (request.claimExpiresAt.getTime() <= now.getTime()) {
    await EmergencyRequest.updateOne({ _id: request._id, active: true }, { $set: { status: 'expired', ...finishFields(now) } });
    throw httpError(410, 'The time to start a session has passed. Make a new request.', { code: 'EXPIRED' });
  }
  if (request.status === 'pending') {
    if (request.releaseAt.getTime() > now.getTime()) {
      throw httpError(409, 'The waiting period has not ended yet.', { code: 'NOT_YET', releaseAt: request.releaseAt });
    }
    const moved = await EmergencyRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending', active: true, ownerNotifiedAt: { $ne: null }, releaseAt: { $lte: now } },
      { $set: { status: 'released', releasedAt: now, denyTokenHash: null } },
      { new: true }
    );
    if (!moved) {
      request = await EmergencyRequest.findOne({ _id: request._id });
      if (!request || request.status !== 'released') {
        await noteFailure(auth.ownerAddress, auth.contactAddress, req?.ip);
        throw httpError(403, 'Access is not available.', { code: 'NOT_AVAILABLE' });
      }
    } else {
      request = moved;
    }
  } else if (request.status !== 'released') {
    throw httpError(403, 'Access is not available.', { code: 'NOT_AVAILABLE' });
  }

  if (!(await auth.consume())) {
    await noteFailure(auth.ownerAddress, auth.contactAddress, req?.ip);
    throw genericFailure();
  }
  const dek = kitLib.unwrapWithKit(access, k1);
  if (!dek) throw genericFailure();

  const folders = await scopeFolders(access.userId, access.scope);
  const scopePaths = folders.map((folder) => folder.path);
  const token = await createSession(access.userId, dek, {
    emergency: { accessId: access._id, requestId: request._id, scopeMode: access.scope.mode, scopePaths, absoluteMs: config.LIMITS.SESSION_ABSOLUTE_MS },
  });

  const [stillReleased, stillActive] = await Promise.all([
    EmergencyRequest.findOne({ _id: request._id, status: 'released', active: true }),
    EmergencyAccess.findOne({ _id: access._id, status: 'active' }),
  ]);
  if (!stillReleased || !stillActive) {
    await destroySession(token);
    throw httpError(403, 'Access is not available.', { code: 'NOT_AVAILABLE' });
  }

  await noticeRelease(request);
  await audit(req, access.userId, 'emergency_session_started', { targetId: request._id, country: countryFrom(req) });
  sendEmail({ to: user.email, ...templates.emergencyOwnerSessionStarted({ when: now, scopeMode: access.scope.mode }) }).catch(() => false);
  return {
    sessionToken: token,
    endsAt: new Date(now.getTime() + config.LIMITS.SESSION_ABSOLUTE_MS),
    scope: { mode: access.scope.mode, folders: aliasesFor(scopePaths).map((entry) => entry.alias) },
  };
}

async function listFolderChoices(userId) {
  const folders = await Folder.find({ userId });
  return folders.map((folder) => ({ id: String(folder._id), path: fullPathOf(folder) })).sort((a, b) => a.path.localeCompare(b.path));
}

async function denyByToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { denied: false };
  const now = new Date();
  const denied = await EmergencyRequest.findOneAndUpdate(
    { denyTokenHash: sha256(token), status: 'pending', active: true },
    { $set: { status: 'denied', deniedAt: now, deniedBy: 'email-link', ...finishFields(now) } },
    { new: true }
  );
  if (!denied) return { denied: false };
  await audit(null, denied.userId, 'emergency_denied', { targetId: denied._id });
  logSecurity('emergency_denied', { bucket: 'email-link' });
  const user = await User.findById(denied.userId).select('email');
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerDenied({ when: now }) }).catch(() => false);
  return { denied: true };
}

async function runMaintenance({ now = new Date() } = {}) {
  const result = { reminders: 0, released: 0, expired: 0 };

  await EmergencyRequest.deleteMany({ active: true, ownerNotifiedAt: null, requestedAt: { $lt: new Date(now.getTime() - UNNOTIFIED_GRACE_MS) } });

  const stale = await EmergencyRequest.find({ active: true, claimExpiresAt: { $lte: now } });
  for (const request of stale) {
    // eslint-disable-next-line no-await-in-loop
    const done = await EmergencyRequest.findOneAndUpdate({ _id: request._id, active: true }, { $set: { status: 'expired', ...finishFields(now) } });
    if (done) result.expired += 1;
  }

  const due = await EmergencyRequest.find({ status: 'pending', active: true, ownerNotifiedAt: { $ne: null }, releaseAt: { $lte: now }, releaseNoticedAt: null });
  for (const request of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await noticeRelease(request)) result.released += 1;
  }

  const open = await EmergencyRequest.find({ status: 'pending', active: true, ownerNotifiedAt: { $ne: null } });
  for (const request of open) {
    const last = request.lastOwnerReminderAt || request.requestedAt;
    if (now.getTime() - new Date(last).getTime() < config.LIMITS.OWNER_REMINDER_EVERY_MS) continue;
    // eslint-disable-next-line no-await-in-loop
    const claimed = await EmergencyRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending', active: true, lastOwnerReminderAt: request.lastOwnerReminderAt || null },
      { $set: { lastOwnerReminderAt: now } }
    );
    if (!claimed) continue;
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findById(request.userId).select('email');
    if (user) {
      // eslint-disable-next-line no-await-in-loop
      await sendEmail({ to: user.email, ...templates.emergencyOwnerReminder({ releaseAt: request.releaseAt, released: request.releaseAt.getTime() <= now.getTime(), denyUrl: null }) }).catch(() => false);
      result.reminders += 1;
    }
  }
  return result;
}

const CONTACT_CODE_PURPOSES = Object.values(codes.PURPOSES);

async function cleanupForUser(userId, options = {}) {
  const opts = options.session ? { session: options.session } : {};
  await destroyEmergencySessions(userId);
  await EmergencyRequest.deleteMany({ userId }, opts);
  await EmergencyAccess.deleteMany({ userId }, opts);
  await OtpChallenge.deleteMany({ userId, purpose: { $in: [...CONTACT_CODE_PURPOSES, OTP_PURPOSES.emergencySetup] } }, opts);
}

async function invalidateForKeyChange(userId) {
  const access = await EmergencyAccess.findOne({ userId });
  if (!access) return false;
  const user = await User.findById(userId).select('email');
  await cleanupForUser(userId);
  await audit(null, userId, 'emergency_revoked', { targetId: access._id });
  if (user) sendEmail({ to: user.email, ...templates.emergencyOwnerSetupChanged({ kind: 'invalidated', when: new Date() }) }).catch(() => false);
  if (access.status === 'active') sendEmail({ to: access.contactEmail, ...templates.emergencyContactKitChanged({ kind: 'revoked' }) }).catch(() => false);
  return true;
}

module.exports = {
  listFolderChoices,
  ACTIONS,
  GENERIC_FAILURE,
  NEUTRAL_CODE_MESSAGE,
  startOwnerCode,
  resendOwnerCode,
  setup,
  regenerateKit,
  revoke,
  status,
  ownerDeny,
  approveNow,
  requestCode,
  submitRequest,
  startSession,
  denyByToken,
  runMaintenance,
  cleanupForUser,
  invalidateForKeyChange,
  noticeRelease,
};
