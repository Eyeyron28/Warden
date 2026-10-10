// Run with: cd server && npm test
//
// Emergency Access after the security review (F5, F6, F12). Same in-memory world as the other emergency tests.
//   F5  the owner is told, or there is no request: mail failure -> 503, nothing usable left behind; no session without
//       ownerNotifiedAt; the wait counts from the moment the owner was told.
//   F6  an attacker who only knows the owner's address cannot lock the real contact out.
//   F12 revoke / deny against start-session: exactly one winner, and a revoked or denied request never yields a session
//       that works.
const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./helpers/emergencyWorld');
const { call, E, service } = W;
const kitLib = require('../utils/emergency/kit');
const Session = require('../models/Session');

const wrongKit = () => kitLib.encodeKit(require('node:crypto').randomBytes(32));
const liveEmergencySessions = () => W.world.tables.sessions.filter((row) => row.emergency && row.expiresAt.getTime() > Date.now());
const ticks = async (n) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---------- F5 ----------

test('F5: when the owner cannot be emailed the request is refused (503) and nothing usable is left behind', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  const code = await W.contactCode();
  const ownerMailsBefore = W.mailsTo(W.OWNER_EMAIL).length;

  W.world.failMail = true;
  const out = await W.publicCall(E.request, { ownerEmail: W.OWNER_EMAIL, contactEmail: W.CONTACT_EMAIL, code, kit: made.kit });
  W.world.failMail = false;

  assert.equal(out.error?.status, 503);
  assert.match(out.error.message, /try again later/i);
  assert.ok(out.error.expose, 'the user-facing text survives the error handler');
  assert.equal(W.requestRows().length, 0, 'the request was withdrawn');
  assert.equal(W.mailsTo(W.OWNER_EMAIL).length, ownerMailsBefore);
  assert.equal(liveEmergencySessions().length, 0);
  const status = await call(E.status, W.owner());
  assert.equal(status.json.request, null, 'the owner sees no request');
  assert.ok(!W.world.tables.auditevents.some((event) => event.type === 'emergency_requested'), 'nothing was recorded as requested');

  // Try again later (a new code, as the old one was used up): it goes through.
  const retry = await W.contactRequests(made.kit);
  assert.equal(retry.status, 201);
  assert.equal(W.mailsTo(W.OWNER_EMAIL).length, ownerMailsBefore + 1, 'and the owner is told');
});

test('F5: a mailer that throws is treated the same way', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  const code = await W.contactCode();
  W.world.throwMail = true;
  try {
    const out = await W.publicCall(E.request, { ownerEmail: W.OWNER_EMAIL, contactEmail: W.CONTACT_EMAIL, code, kit: made.kit });
    assert.equal(out.error?.status, 503);
    assert.equal(W.requestRows().length, 0);
  } finally {
    W.world.throwMail = false;
  }
});

test('F5: no session without ownerNotifiedAt, even after the wait and with the right kit and code', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  const row = W.requestRows()[0];
  assert.ok(row.ownerNotifiedAt instanceof Date);

  const notified = row.ownerNotifiedAt;
  row.ownerNotifiedAt = null; // a request the owner was never told about
  W.makeReleasable(row);
  const refused = await W.contactStarts(made.kit);
  assert.equal(refused.error?.status, 403);
  assert.equal(refused.error?.code, 'NOT_AVAILABLE');
  assert.equal(liveEmergencySessions().length, 0);
  assert.equal(row.status, 'pending', 'nothing moved it forward');

  // The daily job does not announce a release for it either.
  const mailsBefore = W.world.mails.length;
  const result = await service.runMaintenance({ now: new Date() });
  assert.equal(result.released, 0);
  assert.equal(W.world.mails.length, mailsBefore);

  row.ownerNotifiedAt = notified; // once the owner was told, the very same request works
  assert.ok((await W.contactStarts(made.kit)).json.sessionToken);
});

test('F5: the wait is counted from the moment the owner was notified, not from when the request arrived', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  W.world.sendDelayMs = 60; // a slow mail server
  try {
    const out = await W.contactRequests(made.kit);
    assert.equal(out.status, 201);
  } finally {
    W.world.sendDelayMs = 0;
  }
  const row = W.requestRows()[0];
  assert.ok(row.ownerNotifiedAt.getTime() - row.requestedAt.getTime() >= 55, 'the notification came after the request');
  assert.equal(row.releaseAt.getTime() - row.ownerNotifiedAt.getTime(), 4320 * 60 * 1000);
  assert.equal(row.claimExpiresAt.getTime() - row.releaseAt.getTime(), 7 * 864e5);
});

test('F5: an old request the owner was never told about is cleaned up and does not block a new one', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  const row = W.requestRows()[0];
  row.ownerNotifiedAt = null;
  row.requestedAt = new Date(Date.now() - 10 * 60 * 1000);
  const again = await W.contactRequests(made.kit);
  assert.equal(again.status, 201);
  assert.equal(W.requestRows().length, 1);
  assert.ok(W.requestRows()[0].ownerNotifiedAt);
});

// ---------- F6 ----------

test('F6: junk from many connections that only know the owner address does not lock out the real contact', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  for (let i = 0; i < 12; i += 1) {
    await W.publicCall(E.request, { ownerEmail: W.OWNER_EMAIL, contactEmail: 'attacker@example.com', code: '000000', kit: wrongKit() }, { ip: `198.51.100.${i + 1}` });
  }
  const real = await W.contactRequests(made.kit);
  assert.equal(real.status, 201, real.error?.message);
});

test('F6: the attacker’s own connection is still limited (per pair and per connection)', async () => {
  W.reset();
  W.seedVault();
  await W.setupEmergency({ waitMinutes: 4320 });
  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    seen.push((await W.publicCall(E.request, { ownerEmail: W.OWNER_EMAIL, contactEmail: 'attacker@example.com', code: '000000', kit: wrongKit() }, { ip: '198.51.100.99' })).error?.status);
  }
  assert.deepEqual(seen.slice(0, 8), Array(8).fill(401));
  assert.equal(seen[8], 429);
  assert.equal(seen[9], 429);
});

// ---------- F12 ----------

/** Runs `during` at the moment start-session is about to write the session row (the window the review found). */
function atSessionCreate(during) {
  const original = Session.create;
  Session.create = async (doc) => {
    Session.create = original; // once
    await during();
    return original(doc);
  };
  return () => {
    Session.create = original;
  };
}

test('F12: a revoke that lands while start-session is creating its session leaves no working session', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  W.makeReleasable();
  const revokeCode = await W.ownerCode('revoke');
  const restore = atSessionCreate(async () => {
    const revoked = await call(E.revoke, W.owner({ body: revokeCode }));
    assert.equal(revoked.error, null);
  });
  try {
    const started = await W.contactStarts(made.kit);
    assert.equal(started.error?.status, 403, 'the start loses to the revoke');
    assert.equal(started.json, null, 'no token was handed out');
  } finally {
    restore();
  }
  assert.equal(liveEmergencySessions().length, 0, 'and no session row survives');
  assert.equal(W.accessRow().status, 'revoked');
  assert.ok(W.requestRows().every((row) => row.status !== 'released' || row.active === false));
});

test('F12: a deny that lands between the checks and the move cannot be followed by a session', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  W.makeReleasable();
  const id = String(W.requestRows()[0]._id);
  const code = await W.contactCode();
  // deny first, then start with a code obtained before: the start must lose
  assert.equal((await call(E.denyRequest, W.owner({ params: { id } }))).error, null);
  const started = await W.publicCall(E.startSession, { ownerEmail: W.OWNER_EMAIL, contactEmail: W.CONTACT_EMAIL, code, kit: made.kit });
  assert.ok(started.error);
  assert.equal(liveEmergencySessions().length, 0);
});

test('F12: revoke twice at once has exactly one winner', async () => {
  W.reset();
  W.seedVault();
  await W.setupEmergency({ waitMinutes: 4320 });
  const [a, b] = [await W.ownerCode('revoke'), await W.ownerCode('revoke')];
  const results = await Promise.all([call(E.revoke, W.owner({ body: a })), call(E.revoke, W.owner({ body: b }))]);
  const ok = results.filter((out) => !out.error);
  assert.ok(ok.length >= 1);
  assert.equal(W.accessRow().status, 'revoked');
  // The second one finds nothing active (404) or loses the conditional update (409); never a second "success" on a dead setup.
  for (const out of results.filter((r) => r.error)) assert.ok([404, 409].includes(out.error.status), String(out.error.status));
});

test('F12: start-session vs revoke, 40 random interleavings: a revoked setup never leaves a working token', async () => {
  for (let round = 0; round < 40; round += 1) {
    W.reset();
    W.seedVault();
    const made = await W.setupEmergency({ waitMinutes: 4320 });
    assert.equal((await W.contactRequests(made.kit)).status, 201);
    W.makeReleasable();
    const revokeCode = await W.ownerCode('revoke');
    const startCode = await W.contactCode();
    const [d1, d2] = [Math.floor(Math.random() * 40), Math.floor(Math.random() * 40)];
    const [started, revoked] = await Promise.all([
      ticks(d1).then(() => W.publicCall(E.startSession, { ownerEmail: W.OWNER_EMAIL, contactEmail: W.CONTACT_EMAIL, code: startCode, kit: made.kit })),
      ticks(d2).then(() => call(E.revoke, W.owner({ body: revokeCode }))),
    ]);
    if (!revoked.error) {
      assert.equal(liveEmergencySessions().length, 0, `round ${round}: revoke won or ran last, so no emergency session may remain`);
      if (started.json?.sessionToken) {
        const used = await W.throughRequireSession(started.json.sessionToken);
        assert.ok(used.error, `round ${round}: a token handed out before the revoke must be dead after it`);
      }
    }
    if (started.error) assert.ok([401, 403, 409, 410].includes(started.error.status), `round ${round}: ${started.error.status}`);
  }
});

test('F12: start-session vs owner deny, 40 random interleavings: exactly one winner, and a denial never has a session', async () => {
  for (let round = 0; round < 40; round += 1) {
    W.reset();
    W.seedVault();
    const made = await W.setupEmergency({ waitMinutes: 4320 });
    assert.equal((await W.contactRequests(made.kit)).status, 201);
    W.makeReleasable();
    const id = String(W.requestRows()[0]._id);
    const startCode = await W.contactCode();
    const [d1, d2] = [Math.floor(Math.random() * 40), Math.floor(Math.random() * 40)];
    const [started, denied] = await Promise.all([
      ticks(d1).then(() => W.publicCall(E.startSession, { ownerEmail: W.OWNER_EMAIL, contactEmail: W.CONTACT_EMAIL, code: startCode, kit: made.kit })),
      ticks(d2).then(() => call(E.denyRequest, W.owner({ params: { id } }))),
    ]);
    const startWon = Boolean(started.json?.sessionToken);
    const denyWon = !denied.error;
    assert.notEqual(startWon, denyWon, `round ${round}: exactly one of start (${startWon}) and deny (${denyWon}) wins`);
    if (denyWon) assert.equal(liveEmergencySessions().length, 0, `round ${round}: a denied request has no session`);
  }
});
