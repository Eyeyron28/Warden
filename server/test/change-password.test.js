const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');

const PASSWORD = 'Qx7!vTr29#mLpw';
const NEW_PASSWORD = 'Zk4$wNb83&hRtq';
const OWNER = 'pw.owner@example.com';
const OTHER = 'pw.other@example.com';

let live = { ok: false, reason: '' };
test.before(async () => {
  live = await startLiveApp('change_password');
});
test.after(async () => {
  if (live.ok) await live.stop();
});

const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    return fn(context);
  });

const codeFromMail = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];
const lastMailTo = (address) => live.mails.filter((mail) => mail.to === address).at(-1);

async function signUp(email) {
  const { api, mongoose } = live;
  const started = await api('POST', '/api/auth/signup/start', { json: { email, password: PASSWORD, termsAccepted: true } });
  assert.equal(started.status, 200, started.text);
  const verified = await api('POST', '/api/auth/signup/verify', { json: { email, password: PASSWORD, code: codeFromMail(lastMailTo(email)) } });
  assert.equal(verified.status, 200, verified.text);
  const user = await mongoose.models.User.findOne({ email }).lean();
  return { token: verified.body.sessionToken, recoveryKey: verified.body.recoveryKey, userId: String(user._id), email };
}

const unlock = (email, password) => live.api('POST', '/api/auth/unlock', { json: { email, password } });

async function upload(token, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  const response = await live.api('POST', '/api/documents', { token, form });
  assert.equal(response.status, 201, response.text);
  return response.body.id;
}

const start = (token, currentPassword = PASSWORD, newPassword = NEW_PASSWORD) =>
  live.api('POST', '/api/account/password/start', { token, json: { currentPassword, newPassword } });

const confirm = (token, challengeToken, code, newPassword = NEW_PASSWORD) =>
  live.api('POST', '/api/account/password/confirm', { token, json: { challengeToken, code, newPassword } });

const world = {};

it('sets up an owner with a file, a second session and a trusted browser, and another account', async () => {
  const { api, mongoose } = live;
  world.owner = await signUp(OWNER);
  world.other = await signUp(OTHER);
  world.docId = await upload(world.owner.token, 'plan.txt', 'the private plan');
  const second = await unlock(OWNER, PASSWORD);
  assert.equal(second.status, 200, second.text);
  world.secondToken = second.body.sessionToken;
  const devices = await api('GET', '/api/security/devices', { token: world.owner.token });
  await mongoose.models.TrustedDevice.create({
    userId: world.owner.userId,
    tokenHash: crypto.randomBytes(32).toString('hex'),
    label: 'a trusted browser',
    deviceId: devices.body.devices[0].id,
    expiresAt: new Date(Date.now() + 864e5),
  });
});

it('a wrong current password is refused and sends no code', async () => {
  const before = live.mails.length;
  const response = await start(world.owner.token, 'Not-the-password-1!');
  assert.equal(response.status, 401, response.text);
  assert.equal(live.mails.length, before);
});

it('a weak new password and the same password are refused before any code is sent', async () => {
  const before = live.mails.length;
  const weak = await start(world.owner.token, PASSWORD, 'short');
  assert.equal(weak.status, 400, weak.text);
  assert.ok(Array.isArray(weak.body.error?.errors) || weak.body.errors || weak.body.message || weak.body.error);
  const same = await start(world.owner.token, PASSWORD, PASSWORD);
  assert.equal(same.status, 400, same.text);
  assert.match(same.text, /different from your current password/);
  assert.equal(live.mails.length, before);
});

it('a session is needed', async () => {
  const response = await live.api('POST', '/api/account/password/start', { json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(response.status, 401);
});

it('another account cannot use or resend someone else\'s challenge', async () => {
  const started = await start(world.owner.token);
  assert.equal(started.status, 200, started.text);
  const code = codeFromMail(lastMailTo(OWNER));
  const stolen = await confirm(world.other.token, started.body.challengeToken, code);
  assert.equal(stolen.status, 401, stolen.text);
  const resent = await live.api('POST', '/api/account/password/resend', { token: world.other.token, json: { challengeToken: started.body.challengeToken } });
  assert.equal(resent.status, 401, resent.text);
  world.challenge = started.body.challengeToken;
  world.code = code;
});

it('a wrong code changes nothing; the right code afterwards still works', async () => {
  const wrong = await confirm(world.owner.token, world.challenge, world.code === '000000' ? '111111' : '000000');
  assert.equal(wrong.status, 401, wrong.text);
  assert.equal((await unlock(OWNER, PASSWORD)).status, 200, 'the old password still works');
});

it('an expired code is refused', async () => {
  const started = await start(world.owner.token);
  const code = codeFromMail(lastMailTo(OWNER));
  await live.mongoose.models.OtpChallenge.updateMany({ userId: world.owner.userId, purpose: 'password-change' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const response = await confirm(world.owner.token, started.body.challengeToken, code);
  assert.equal(response.status, 401, response.text);
  await live.mongoose.models.OtpChallenge.deleteMany({ userId: world.owner.userId });
});

it('the change: the new password works, the old one does not, and nothing is echoed', async () => {
  const { mongoose } = live;
  const started = await start(world.owner.token);
  assert.equal(started.status, 200, started.text);
  assert.ok(!started.text.includes(PASSWORD) && !started.text.includes(NEW_PASSWORD));
  const code = codeFromMail(lastMailTo(OWNER));

  const weak = await confirm(world.owner.token, started.body.challengeToken, code, 'short');
  assert.equal(weak.status, 400, weak.text);

  const done = await confirm(world.owner.token, started.body.challengeToken, code);
  assert.equal(done.status, 200, done.text);
  assert.ok(!done.text.includes(NEW_PASSWORD));

  assert.equal((await unlock(OWNER, PASSWORD)).status, 401, 'the old password no longer logs in');
  const fresh = await unlock(OWNER, NEW_PASSWORD);
  assert.equal(fresh.status, 200, fresh.text);
  world.freshToken = fresh.body.sessionToken;

  const notice = live.mails.filter((mail) => mail.to === OWNER && /password was changed/i.test(mail.subject)).at(-1);
  assert.ok(notice, 'the owner is told');
  assert.ok(!notice.text.includes(NEW_PASSWORD));

  const events = await mongoose.models.AuditEvent.find({ userId: world.owner.userId, type: 'password_changed' }).lean();
  assert.equal(events.length, 1);

});

it('the same code cannot be used twice', async () => {
  const again = await confirm(world.owner.token, world.challenge, world.code, 'Yy6#kPq41!zWmn');
  assert.equal(again.status, 401, again.text);
});

it('an old document still opens after the change', async () => {
  const view = await live.api('GET', `/api/documents/${world.docId}/view`, { token: world.freshToken });
  assert.equal(view.status, 200, view.text);
  assert.match(view.text, /the private plan/);
});

it('the current session survives; other sessions and trusted browsers are gone', async () => {
  const { api, mongoose } = live;
  assert.equal((await api('GET', '/api/auth/me', { token: world.owner.token })).status, 200, 'the session that made the change');
  assert.equal((await api('GET', '/api/auth/me', { token: world.secondToken })).status, 401, 'the other session');
  assert.equal(await mongoose.models.TrustedDevice.countDocuments({ userId: world.owner.userId }), 0);
});

it('the recovery key still unlocks the vault and the file still opens', async () => {
  const { api } = live;
  const started = await api('POST', '/api/auth/password-reset/start', { json: { email: OWNER } });
  assert.equal(started.status, 200, started.text);
  const verified = await api('POST', '/api/auth/password-reset/verify', { json: { challengeToken: started.body.challengeToken, code: codeFromMail(lastMailTo(OWNER)) } });
  assert.equal(verified.status, 200, verified.text);
  const reset = await api('POST', '/api/auth/password-reset/with-recovery-key', {
    json: { resetTicket: verified.body.resetTicket, recoveryKey: world.owner.recoveryKey, newPassword: 'Mm8!cVx52#bQrt' },
  });
  assert.equal(reset.status, 200, reset.text);
  const login = await unlock(OWNER, 'Mm8!cVx52#bQrt');
  assert.equal(login.status, 200, login.text);
  const view = await api('GET', `/api/documents/${world.docId}/view`, { token: login.body.sessionToken });
  assert.equal(view.status, 200, view.text);
  assert.match(view.text, /the private plan/);
});
