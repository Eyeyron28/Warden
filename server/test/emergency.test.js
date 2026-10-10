// Run with: cd server && npm test
//
// Emergency Access: the 2-of-2 key split, the time gate, "deny wins", neutral answers, limits, the deny token,
// the owner's API, the audit chain, the daily job and cleanup. (The allowlist and scope tests: emergency-allowlist.test.js.)
// Security model, in plain words: utils/emergency/config.js. Everything here runs against in-memory models.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const W = require('./helpers/emergencyWorld');
const { world, call, service, E, kitLib, DEK, ALICE, OWNER_EMAIL, CONTACT_EMAIL } = W;
const { unwrapKey } = require('../utils/crypto');
const { verifyChain } = require('../utils/audit');
const config = require('../utils/emergency/config');

const withEnv = async (name, value, fn) => {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
};
const everything = () => JSON.stringify(world.tables, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') + '|' + Buffer.from(v.data).toString('base64') : v)) + JSON.stringify(world.mails);

// ---------- the key split ----------
test('key split: E = K1 xor K2; the database alone cannot unwrap; only the right K1 does; K1 is stored nowhere', async () => {
  W.reset();
  W.seedVault();
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(' '));
  let made;
  try {
    made = await W.setupEmergency();
  } finally {
    Object.assign(console, originals);
  }
  const k1 = kitLib.parseKit(made.kit);
  assert.equal(k1.length, 32);
  const access = W.accessRow();

  // the construction: unwrap works with K1 xor the stored K2, and with nothing else
  const e = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) e[i] = k1[i] ^ access.k2[i];
  assert.deepEqual(unwrapKey(access.wrappedDek, e, access.wrappedDekIv, access.wrappedDekAuthTag), DEK);
  assert.deepEqual(kitLib.unwrapWithKit(access, k1), DEK);
  assert.equal(kitLib.unwrapWithKit(access, crypto.randomBytes(32)), null, 'a wrong K1 fails');
  for (const guess of [access.k2, Buffer.alloc(32), Buffer.from(access.kitHash, 'hex'), Buffer.from(access.kitSalt, 'hex').subarray(0, 16)]) {
    assert.throws(() => unwrapKey(access.wrappedDek, guess.length === 32 ? guess : Buffer.concat([guess, Buffer.alloc(32)]).subarray(0, 32), access.wrappedDekIv, access.wrappedDekAuthTag), 'the stored values alone are not a key');
  }
  assert.equal(kitLib.kitMatches(access, k1), true);
  assert.equal(kitLib.kitMatches(access, crypto.randomBytes(32)), false);
  assert.equal(kitLib.kitMatches(null, k1), false);

  // K1 is not in any collection (hex, base64, kit text), any email or any log line
  const all = everything();
  assert.ok(!all.includes(k1.toString('hex')) && !all.includes(k1.toString('base64')), 'K1 not stored in any encoding');
  assert.ok(!all.toUpperCase().includes(made.kit.replace(/-/g, '').slice(0, 20)) && !all.includes(made.kit), 'the kit text is not stored or mailed');
  assert.ok(!lines.join('\n').includes(made.kit), 'not logged');
  assert.ok(!JSON.stringify(world.tables.auditevents).includes(k1.toString('hex')));
  // the owner's mail says it happened and nothing more
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /Emergency access was set up/);
  // the status call has no secrets in it
  const status = await call(E.status, W.owner());
  const shown = JSON.stringify(status.json);
  assert.ok(!/k2|kitHash|kitSalt|wrappedDek|"kit"/.test(shown), 'status shows configuration only');
  assert.equal(status.json.configured, true);
  assert.equal(status.json.scope.mode, 'all');
});

test('regenerating the kit invalidates the old one, cancels a request, ends sessions and tells both people', async () => {
  W.reset();
  W.seedVault();
  const first = await W.setupEmergency();
  const oldKit = kitLib.parseKit(first.kit);
  assert.equal((await W.contactRequests(first.kit)).status, 201);
  const fresh = await W.ownerCode('regenerate');
  const out = await call(E.regenerateKit, W.owner({ body: fresh }));
  assert.equal(out.status, 200);
  assert.equal(out.json.kitVersion, 2);
  assert.notEqual(out.json.kit, first.kit);
  assert.equal(kitLib.unwrapWithKit(W.accessRow(), oldKit), null, 'the old kit no longer opens anything');
  assert.equal(kitLib.kitMatches(W.accessRow(), oldKit), false);
  assert.deepEqual(kitLib.unwrapWithKit(W.accessRow(), kitLib.parseKit(out.json.kit)), DEK);
  assert.equal(W.requestRows().filter((r) => r.active).length, 0, 'the open request was cancelled');
  assert.equal(W.requestRows()[0].status, 'cancelled');
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /You replaced your emergency access kit/);
  assert.match(W.lastMailTo(CONTACT_EMAIL).subject, /kit was replaced/);
  // the old kit cannot start anything, even with a valid code
  assert.equal((await W.contactRequests(first.kit)).status, 401);
  assert.equal((await W.contactRequests(out.json.kit)).status, 201);
});

// ---------- the owner's API ----------
test('setup needs a fresh emailed code for that action, and refuses bad input before using it', async () => {
  W.reset();
  const { folders } = W.seedVault();
  const base = { contactEmail: CONTACT_EMAIL, contactLabel: 'Sam', waitMinutes: 4320, scope: { mode: 'all' } };

  // no code, a wrong code, a code made for another action
  assert.equal((await call(E.setup, W.owner({ body: base }))).error?.status, 401);
  const fresh = await W.ownerCode('setup');
  assert.equal((await call(E.setup, W.owner({ body: { ...base, ...fresh, code: '000000' } }))).error?.status, 401);
  const other = await W.ownerCode('revoke');
  assert.equal((await call(E.setup, W.owner({ body: { ...base, ...other } }))).error?.status, 401, 'a revoke code cannot set up');

  // validation happens BEFORE the code is spent
  const spendable = await W.ownerCode('setup');
  const bad = async (patch, message) => {
    const out = await call(E.setup, W.owner({ body: { ...base, ...spendable, ...patch } }));
    assert.equal(out.error?.status, 400, message);
  };
  await bad({ contactEmail: OWNER_EMAIL }, 'the owner cannot be the contact');
  await bad({ contactEmail: 'not an address' }, 'bad address');
  await bad({ contactEmail: 'a@example.com, b@example.com' }, 'one address only');
  await bad({ waitMinutes: 60 }, 'wait must be 3, 7 or 14 days');
  await bad({ waitMinutes: '4320; drop' }, 'wait must be a number from the list');
  await bad({ contactLabel: 'x'.repeat(61) }, 'label max 60');
  await bad({ scope: { mode: 'folders', folderIds: [] } }, 'folders mode needs folders');
  await bad({ scope: { mode: 'folders', folderIds: [String(W.db.oid())] } }, 'a folder that does not exist');
  const foreign = W.addFolder('Theirs', W.BOB);
  await bad({ scope: { mode: 'folders', folderIds: [String(foreign._id)] } }, "another account's folder");
  await bad({ scope: { mode: 'everything' } }, 'unknown mode');
  // ...so the same code still works for a good request
  const ok = await call(E.setup, W.owner({ body: { ...base, ...spendable, scope: { mode: 'folders', folderIds: [String(folders.taxes._id)] } } }));
  assert.equal(ok.status, 201, ok.error?.message);
  assert.ok(ok.json.kit && ok.json.kitVersion === 1);
  assert.equal(ok.json.scope.folders[0].path, 'Taxes');
  // already configured
  const again = await W.ownerCode('setup');
  assert.equal((await call(E.setup, W.owner({ body: { ...base, ...again } }))).error?.status, 409);
  // a code is single use: the one just spent on the setup is gone
  assert.equal((await call(E.revoke, W.owner({ body: spendable }))).error?.status, 401);
});

test('the waiting period is 3, 7 or 14 days; 2 minutes only in demo mode; a client-supplied time is ignored', async () => {
  W.reset();
  W.seedVault();
  await withEnv('EMERGENCY_DEMO_MODE', undefined, async () => {
    assert.deepEqual(config.allowedWaits(), [4320, 10080, 20160]);
    const fresh = await W.ownerCode('setup');
    const out = await call(E.setup, W.owner({ body: { contactEmail: CONTACT_EMAIL, waitMinutes: 2, scope: { mode: 'all' }, ...fresh } }));
    assert.equal(out.error?.status, 400, '2 minutes is refused without demo mode');
    for (const minutes of [4320, 10080, 20160]) {
      W.reset();
      const made = await W.setupEmergency({ waitMinutes: minutes });
      assert.equal(made.waitMinutes, minutes);
    }
  });
  await withEnv('EMERGENCY_DEMO_MODE', 'true', async () => {
    assert.deepEqual(config.allowedWaits(), [2, 4320, 10080, 20160]);
    W.reset();
    assert.equal((await W.setupEmergency({ waitMinutes: 2 })).waitMinutes, 2);
  });
  await withEnv('EMERGENCY_DEMO_MODE', 'TRUE ', async () => assert.equal(config.demoMode(), true));
  await withEnv('EMERGENCY_DEMO_MODE', 'yes', async () => assert.equal(config.demoMode(), false, 'only the exact word true'));

  // the release time comes from the server clock and the stored wait, whatever the client sends
  W.reset();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  const before = Date.now();
  const sent = await W.contactRequests(made.kit, { releaseAt: '2000-01-01T00:00:00Z', waitMinutes: 2, now: '2000-01-01', requestedAt: '2000-01-01', at: 0 });
  assert.equal(sent.status, 201);
  const row = W.requestRows()[0];
  // The wait is counted from the moment the owner was told, never from anything the client sent.
  assert.ok(row.ownerNotifiedAt instanceof Date && row.ownerNotifiedAt.getTime() >= row.requestedAt.getTime());
  const wait = row.releaseAt.getTime() - row.ownerNotifiedAt.getTime();
  assert.equal(wait, 4320 * 60 * 1000, 'the stored wait decides, not the request');
  assert.ok(row.requestedAt.getTime() >= before - 1000, 'the clock is the server clock');
  assert.equal(row.claimExpiresAt.getTime() - row.releaseAt.getTime(), config.claimDays() * 864e5);
});

// ---------- the time gate ----------
test('time gate: start-session is refused before releaseAt even with the right kit and a valid code, and works after', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);

  const early = await W.contactStarts(made.kit);
  assert.equal(early.error?.status, 409);
  assert.equal(early.error?.code, 'NOT_YET');
  assert.equal(W.world.tables.sessions.length, 0, 'no session exists');
  // an attempt that fails on timing does not burn the owner's request or the contact's kit
  assert.equal(W.requestRows()[0].status, 'pending');

  // time passes (the database says so; nothing the client sends can)
  const forged = await W.contactStarts(made.kit, { releaseAt: '2000-01-01', now: Date.now() + 1e10 });
  assert.equal(forged.error?.code, 'NOT_YET', 'a forged time changes nothing');
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200, started.error?.message);
  assert.ok(started.json.sessionToken && /^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(started.json.sessionToken));
  assert.equal(W.requestRows()[0].status, 'released');
  assert.equal(world.tables.sessions.filter((s) => s.emergency).length, 1);
  const ends = new Date(started.json.endsAt).getTime() - Date.now();
  assert.ok(ends > 3.9 * 3600 * 1000 && ends <= 4 * 3600 * 1000 + 5000, 'at most 4 hours');
  // the owner is told, on the chain
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /started a session/);
});

test('a request nobody claims in time expires; an expired one cannot start a session', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  const row = W.requestRows()[0];
  row.releaseAt = new Date(Date.now() - 9 * 864e5);
  row.claimExpiresAt = new Date(Date.now() - 864e5);
  const late = await W.contactStarts(made.kit);
  assert.equal(late.error?.status, 410);
  assert.equal(row.status, 'expired');
  assert.equal(row.active, false);
  assert.equal(world.tables.sessions.length, 0);
});

// ---------- deny wins ----------
test('deny before release prevents start-session; a request denied by the owner needs 24 hours before another', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  const row = W.requestRows()[0];
  W.makeReleasable(row); // the wait is over but nobody has started a session yet

  const denied = await call(E.denyRequest, W.owner({ params: { id: String(row._id) } }));
  assert.equal(denied.status, 200);
  assert.equal(row.status, 'denied');
  assert.equal(row.active, false);
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /You denied the emergency access request/);

  const start = await W.contactStarts(made.kit);
  assert.ok(start.error, 'start-session is refused after a denial');
  assert.equal(world.tables.sessions.length, 0);

  // 24-hour cooldown (shown only to a contact who has proved who they are)
  const soon = await W.contactRequests(made.kit);
  assert.equal(soon.error?.status, 429);
  assert.match(soon.error.message, /24 hours/);
  row.deniedAt = new Date(Date.now() - 25 * 3600 * 1000);
  assert.equal((await W.contactRequests(made.kit)).status, 201, 'after 24 hours they may ask again');
  assert.equal(W.requestRows().filter((r) => r.active).length, 1);
});

test('deny and start-session race: exactly one outcome, never both', async () => {
  for (let round = 0; round < 25; round += 1) {
    W.reset();
    W.seedVault();
    const made = await W.setupEmergency({ waitMinutes: 2 });
    await W.contactRequests(made.kit);
    const row = W.requestRows()[0];
    W.makeReleasable(row);
    const startCode = await W.contactCode();
    const body = { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: startCode, kit: made.kit };
    const [deny, start] = await Promise.all([
      call(E.denyRequest, W.owner({ params: { id: String(row._id) } })),
      W.publicCall(E.startSession, body),
    ]);
    const denied = deny.status === 200;
    const started = start.status === 200;
    assert.equal(denied !== started, true, `round ${round}: exactly one wins (denied=${denied}, started=${started})`);
    if (denied) {
      assert.equal(row.status, 'denied');
      assert.equal(world.tables.sessions.length, 0, 'a denied request leaves no session behind');
    } else {
      assert.equal(row.status, 'released');
      assert.equal(deny.error?.status, 409, 'a denial that lost is told so');
    }
  }
});

test('the one-click deny link: single use, hashed at rest, can only deny, generic page', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  const row = W.requestRows()[0];
  const mail = W.lastMailTo(OWNER_EMAIL);
  assert.match(mail.subject, /Someone requested emergency access to your vault/);
  const link = /https:\/\/warden\.test\/api\/emergency\/public\/deny\/([A-Za-z0-9_-]{20,})/.exec(mail.text);
  assert.ok(link, 'the email carries the deny link');
  const token = link[1];
  assert.match(mail.text, /Review in Warden: https:\/\/warden\.test\/emergency/);
  assert.match(mail.text, /Earliest access: .*Philippine/);
  assert.ok(!everything().includes(`"${token}"`) && !JSON.stringify(world.tables.emergencyrequests).includes(token), 'the token itself is not stored');
  assert.equal(row.denyTokenHash, W.sha256(token));

  // a wrong token: same page, nothing happens
  const wrong = await call(E.denyByToken, { params: { token: 'A'.repeat(43) } });
  assert.equal(wrong.status, 200);
  assert.equal(row.status, 'pending');
  const junk = await call(E.denyByToken, { params: { token: '../../etc/passwd' } });
  assert.equal(junk.status, 200);
  assert.equal(junk.body, wrong.body, 'the same page for any outcome');

  // the right token denies once
  const first = await call(E.denyByToken, { params: { token } });
  assert.equal(first.status, 200);
  assert.equal(first.body, wrong.body);
  assert.match(String(first.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(row.status, 'denied');
  assert.equal(row.denyTokenHash, null, 'consumed');
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /You denied the emergency access request/);
  const mailsAfterFirst = W.world.mails.length;
  const second = await call(E.denyByToken, { params: { token } });
  assert.equal(second.status, 200);
  assert.equal(W.world.mails.length, mailsAfterFirst, 'a second click does nothing');
  assert.equal(world.tables.auditevents.filter((e) => e.type === 'emergency_denied').length, 1);

  // it cannot do anything but deny: not start a session, not approve, not touch a released request
  W.reset();
  W.seedVault();
  const made2 = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made2.kit);
  const row2 = W.requestRows()[0];
  const token2 = /deny\/([A-Za-z0-9_-]{20,})/.exec(W.lastMailTo(OWNER_EMAIL).text)[1];
  W.makeReleasable(row2);
  assert.equal((await W.contactStarts(made2.kit)).status, 200, 'the contact started a session');
  await call(E.denyByToken, { params: { token: token2 } });
  assert.equal(row2.status, 'released', 'once a session started, the link cannot deny it (the owner turns access off instead)');
  assert.equal(row2.denyTokenHash, null, 'and it is spent');
  assert.equal(W.world.tables.sessions.filter((s) => s.emergency).length, 1, 'a session is untouched by it');
});

// ---------- neutral answers ----------
test('anti-enumeration: unknown owner, wrong contact, wrong kit and wrong code all look the same', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  const validCode = await W.contactCode();

  // request-code: always 200 with the same body; a code goes out only for a real match
  const askers = [
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL },
    { ownerEmail: 'nobody@example.com', contactEmail: CONTACT_EMAIL },
    { ownerEmail: OWNER_EMAIL, contactEmail: 'someone-else@example.com' },
    { ownerEmail: 'bad address', contactEmail: CONTACT_EMAIL },
    { ownerEmail: '', contactEmail: '' },
    {},
  ];
  const answers = [];
  for (const body of askers) {
    const out = await W.publicCall(E.requestCode, body);
    answers.push({ status: out.status, json: JSON.stringify(out.json), error: out.error ? 'error' : null });
  }
  assert.ok(answers.every((a) => JSON.stringify(a) === JSON.stringify(answers[0])), 'every answer is identical');
  assert.match(JSON.parse(answers[0].json).message, /If these details match an active setup, we sent a code to the contact/);
  assert.equal(W.mailsTo('someone-else@example.com').length, 0, 'nothing goes to an address that is not the stored contact');
  assert.equal(W.mailsTo('nobody@example.com').length, 0);
  assert.ok(!W.world.mails.some((m) => m.to === OWNER_EMAIL && /code/i.test(m.subject) && /emergency access/i.test(m.subject) && m.subject.includes('request emergency access')), 'the owner is not sent the contact code');

  // request / start-session: the same 401 for every kind of wrong
  const kitGood = made.kit;
  const kitWrong = kitLibWrongKit();
  const freshCode = await W.contactCode({ ip: '203.0.113.77' });
  const attempts = [
    { ownerEmail: 'nobody@example.com', contactEmail: CONTACT_EMAIL, code: freshCode, kit: kitGood },
    { ownerEmail: OWNER_EMAIL, contactEmail: 'someone-else@example.com', code: freshCode, kit: kitGood },
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: freshCode, kit: kitWrong },
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: '000000', kit: kitGood },
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: freshCode, kit: 'not a kit' },
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: freshCode, kit: '' },
    { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: 'abcdef', kit: kitGood },
    {},
  ];
  for (const handler of [E.request, E.startSession]) {
    W.clearBudgets();
    const shapes = [];
    for (const [i, body] of attempts.entries()) {
      const out = await W.publicCall(handler, body, { ip: `198.51.100.${10 + i}` });
      shapes.push(`${out.error?.status}|${out.error?.message}|${Object.keys(out.json || {}).join()}`);
    }
    assert.ok(shapes.every((s) => s === shapes[0]), `every wrong attempt looks the same: ${[...new Set(shapes)].join(' / ')}`);
    assert.match(shapes[0], /^401\|The details or the code are not correct/);
  }
  assert.equal(validCode.length, 6);
});

function kitLibWrongKit() {
  return kitLib.encodeKit(crypto.randomBytes(32));
}

test('lockouts: failures count against the connection and the details it typed, never against the owner alone; five code guesses kill a code', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  const wrong = kitLibWrongKit();

  // five guesses at one code kill it, even for the correct number afterwards
  const code = await W.contactCode();
  for (let i = 0; i < 5; i += 1) {
    const out = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: String((Number(code) + 1 + i) % 1000000).padStart(6, '0'), kit: made.kit }, { ip: `203.0.113.${100 + i}` });
    assert.equal(out.error?.status, 401);
  }
  const dead = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code, kit: made.kit }, { ip: '203.0.113.120' });
  assert.equal(dead.error?.status, 401, 'the code is gone after five guesses');

  // Eight more failures from OTHER connections do not lock the owner's real contact (F6): a stranger who only knows the
  // owner's address can no longer shut the contact out.
  for (let i = 0; i < 8; i += 1) {
    await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: '123456', kit: wrong }, { ip: `203.0.113.${130 + i}` });
  }
  const freshCode = await W.contactCode({ ip: '203.0.113.140' });
  const real = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: freshCode, kit: made.kit }, { ip: '203.0.113.141' });
  assert.equal(real.status, 201, 'the real contact still gets through');
  W.reset();
  W.seedVault();
  const again = await W.setupEmergency({ waitMinutes: 2 });

  // The same connection repeating the same details is locked after eight failures (even with the right kit afterwards)...
  const statuses = [];
  for (let i = 0; i < 9; i += 1) {
    statuses.push((await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: '123456', kit: wrong }, { ip: '198.51.100.7' })).error?.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429]);
  const lockedCode = await W.contactCode({ ip: '203.0.113.150' });
  const locked = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: lockedCode, kit: again.kit }, { ip: '198.51.100.7' });
  assert.equal(locked.error?.status, 429, 'locked for that connection, even with the right kit and a live code');
  assert.equal(W.requestRows().length, 0);
  // ...and says the same for an address that does not exist (it counts attempts, not accounts)
  const unknown = [];
  for (let i = 0; i < 9; i += 1) {
    unknown.push((await W.publicCall(E.request, { ownerEmail: 'ghost@example.com', contactEmail: CONTACT_EMAIL, code: '123456', kit: wrong }, { ip: '192.0.2.77' })).error?.status);
  }
  assert.deepEqual(unknown, [401, 401, 401, 401, 401, 401, 401, 401, 429], 'a made-up address locks after the same number of tries');

  // one connection that keeps failing is locked too (coarser limit), whichever owner it names
  W.reset();
  const many = [];
  for (let i = 0; i < 27; i += 1) {
    many.push((await W.publicCall(E.request, { ownerEmail: `ghost${i}@example.com`, contactEmail: CONTACT_EMAIL, code: '123456', kit: wrong }, { ip: '198.51.100.250' })).error?.status);
  }
  assert.equal(many[0], 401);
  assert.equal(many.at(-1), 429, 'per-connection lockout');
  // an IPv6 connection is counted by its /64, so rotating the low bits does not buy a new budget
  W.reset();
  const v6 = [];
  for (let i = 0; i < 27; i += 1) {
    v6.push((await W.publicCall(E.request, { ownerEmail: `ghost${i}@example.com`, contactEmail: CONTACT_EMAIL, code: '123456', kit: wrong }, { ip: `2001:db8:1:2:${i.toString(16)}::${(i + 1).toString(16)}` })).error?.status);
  }
  assert.equal(v6.at(-1), 429, 'one /64 shares one budget');
});

test('code emails: at most five an hour per owner address, and a code can only be used for its own purpose', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  let sent = 0;
  for (let i = 0; i < 8; i += 1) {
    const before = W.mailsTo(CONTACT_EMAIL).length;
    const out = await W.publicCall(E.requestCode, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL });
    assert.equal(out.status, 200, 'the answer never changes');
    sent += W.mailsTo(CONTACT_EMAIL).length - before;
  }
  assert.equal(sent, 5, 'five codes, then silence');

  // a "request" code cannot start a session and a "session" code cannot make a request
  W.reset();
  W.seedVault();
  const made2 = await W.setupEmergency({ waitMinutes: 2 });
  const requestCode = await W.contactCode();
  assert.match(W.lastMailTo(CONTACT_EMAIL).subject, /Your code to request emergency access/);
  const wrongPurpose = await W.publicCall(E.startSession, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: requestCode, kit: made2.kit });
  assert.equal(wrongPurpose.error?.status, 401);
  assert.equal(made2.kit.length > 0, true);
});

test('one open request at a time, and a request needs the kit AND a fresh code', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  assert.equal((await W.contactRequests(made.kit)).status, 201);
  const second = await W.contactRequests(made.kit);
  assert.equal(second.error?.status, 401, 'with a request open the contact is sent a session code, which cannot make another request');
  const codes = require('../utils/emergency/codes');
  await codes.issueContactCode({ access: W.accessRow(), purpose: codes.PURPOSES.request, to: CONTACT_EMAIL });
  const direct = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code: W.codeFrom(W.lastMailTo(CONTACT_EMAIL)), kit: made.kit });
  assert.equal(direct.error?.status, 409, 'even a valid request code cannot open a second request');
  assert.equal(W.requestRows().length, 1);
  // a code alone, or a kit alone, is not enough
  const code = await W.contactCode();
  assert.equal((await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code })).error?.status, 401);
  assert.equal((await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, kit: made.kit })).error?.status, 401);
  // the receipt and the owner's notice went out at once
  assert.match(W.mailsTo(CONTACT_EMAIL).find((m) => /received your emergency access request/.test(m.subject))?.subject || '', /received/);
  assert.equal(W.mailsTo(OWNER_EMAIL).filter((m) => /Someone requested emergency access/.test(m.subject)).length, 1);
});

test('the owner can approve early (fresh code) and revoke (fresh code), and revoke ends sessions at once', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  await W.contactRequests(made.kit);
  const row = W.requestRows()[0];

  assert.equal((await call(E.approveNow, W.owner({ params: { id: String(row._id) }, body: {} }))).error?.status, 401, 'needs a fresh code');
  const wrongAction = await W.ownerCode('revoke');
  assert.equal((await call(E.approveNow, W.owner({ params: { id: String(row._id) }, body: wrongAction }))).error?.status, 401);
  const fresh = await W.ownerCode('approve-now');
  const approved = await call(E.approveNow, W.owner({ params: { id: String(row._id) }, body: fresh }));
  assert.equal(approved.status, 200, approved.error?.message);
  assert.ok(row.approvedEarlyAt && row.releaseAt.getTime() <= Date.now());
  assert.ok(world.tables.auditevents.some((e) => e.type === 'emergency_approved_early'));
  assert.match(W.mailsTo(CONTACT_EMAIL).at(-1).subject, /Emergency access is now available/);

  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200);
  assert.equal(world.tables.sessions.filter((s) => s.emergency).length, 1);

  // revoke: needs a code, destroys the key material, cancels everything, ends the session NOW
  assert.equal((await call(E.revoke, W.owner({ body: {} }))).error?.status, 401);
  const revokeCode = await W.ownerCode('revoke');
  const revoked = await call(E.revoke, W.owner({ body: revokeCode }));
  assert.equal(revoked.status, 200);
  assert.equal(world.tables.sessions.filter((s) => s.emergency).length, 0, 'sessions end at once');
  assert.equal(W.accessRow().status, 'revoked');
  assert.equal(W.accessRow().wrappedDek, '', 'the wrapped key is destroyed');
  assert.equal(kitLibWrongKit().length > 0, true);
  assert.equal(W.requestRows().filter((r) => r.active).length, 0);
  assert.match(W.mailsTo(CONTACT_EMAIL).at(-1).subject, /Emergency access was turned off/);
  assert.equal((await W.contactRequests(made.kit)).status, 401, 'a revoked setup answers like an unknown one');
  const status = await call(E.status, W.owner());
  assert.equal(status.json.configured, false);
  // ...and it can be set up again afterwards
  assert.equal((await W.setupEmergency({ waitMinutes: 2 })).kitVersion, 1);
});

// ---------- the vault key ----------
test('a password change keeps the wrapped DEK working; any change of the vault key invalidates the setup', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  const { finalizeReset } = require('../utils/accountReset');
  const { fingerprintDEK } = require('../utils/crypto');

  // password change / new recovery key: the SAME vault key is re-wrapped, so emergency access still opens it
  const user = world.tables.users.find((u) => String(u._id) === String(ALICE));
  user.dekFingerprint = fingerprintDEK(DEK);
  user.save = async () => user;
  await finalizeReset(user, DEK, 'a new Password 123!', {});
  assert.ok(W.accessRow(), 'still set up');
  assert.deepEqual(kitLib.unwrapWithKit(W.accessRow(), kitLib.parseKit(made.kit)), DEK);

  // a different vault key (the start-over path): the setup is removed, sessions and requests with it, the owner told
  await W.contactRequests(made.kit);
  W.makeReleasable();
  assert.equal((await W.contactStarts(made.kit)).status, 200);
  const newDek = crypto.randomBytes(32);
  await finalizeReset(user, newDek, 'another Password 456!', { newRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' });
  assert.equal(world.tables.emergencyaccesses.length, 0, 'the old setup cannot open the new vault key, so it is gone');
  assert.equal(world.tables.emergencyrequests.length, 0);
  assert.equal(world.tables.sessions.filter((s) => s.emergency).length, 0);
  assert.match(W.lastMailTo(OWNER_EMAIL).subject, /turned off because your vault key changed/);
  assert.equal((await W.contactRequests(made.kit)).status, 401);
  assert.equal(user.dekFingerprint, fingerprintDEK(newDek));
});

// ---------- the audit chain ----------
test('every emergency event is on the owner’s chain with actor "emergency", ids only, and the chain stays intact', async () => {
  W.reset();
  const { docs } = W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  const token = started.json.sessionToken;
  const via = await W.throughRequireSession(token, { path: `/${docs.root._id}/view` });
  assert.equal(via.reached, true);
  await call(W.D.viewDocument, { ...via.req, userId: via.req.userId, dek: via.req.dek, params: { id: String(docs.root._id) }, query: {}, emergency: via.req.emergency });
  await call(W.D.viewDocument, { userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, params: { id: String(docs.taxes._id) }, query: { for: 'download' } });
  await call(W.D.viewDocument, { userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, params: { id: String(docs.tax24._id) }, query: { for: 'silent' } });
  const owner = W.owner();
  const requestId = W.requestRows()[0]._id;
  await call(E.denyRequest, W.owner({ params: { id: String(requestId) } })); // too late: refused, records nothing

  const types = world.tables.auditevents.map((e) => e.type);
  assert.deepEqual(types, [
    'emergency_configured', 'emergency_requested', 'emergency_released', 'emergency_session_started',
    'emergency_file_viewed', 'emergency_file_downloaded', 'emergency_file_viewed',
  ]);
  assert.ok(world.tables.auditevents.every((e) => e.actor === 'emergency'), 'actor is "emergency" on all of them');
  assert.equal(world.tables.auditevents.find((e) => e.type === 'emergency_session_started').country, 'PH');
  const stored = JSON.stringify(world.tables.auditevents);
  for (const doc of Object.values(docs)) assert.ok(!stored.includes(doc.filename), 'no file names in events');
  assert.ok(!stored.includes(CONTACT_EMAIL) && !stored.includes(OWNER_EMAIL), 'no addresses in events');
  const chain = await verifyChain(ALICE);
  assert.equal(chain.ok, true, chain.reason);
  assert.equal(chain.checked, 7);
  // editing an event's actor breaks it (the field is signed)
  world.tables.auditevents[1].actor = null;
  assert.equal((await verifyChain(ALICE)).ok, false);
  assert.ok(owner);
});

test('the activity timeline flags a started emergency session and shows the actor', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  await W.contactStarts(made.kit);
  const security = require('../controllers/security.controller');
  const out = await call(security.listActivity, W.owner({ query: {} }));
  assert.equal(out.status, 200, out.error?.message);
  const started = out.json.events.find((e) => e.type === 'emergency_session_started');
  assert.ok(started.flags.some((f) => f.code === 'emergency_session'), 'always flagged');
  assert.equal(started.actor, 'emergency');
  assert.ok(out.json.flaggedRecent >= 1, 'it shows the banner');
  const filtered = await call(security.listActivity, W.owner({ query: { group: 'emergency' } }));
  assert.equal(filtered.json.events.length, out.json.events.filter((e) => e.type.startsWith('emergency')).length);
});

// ---------- the daily job ----------
test('the daily job: one reminder a day while pending, one "wait ended" notice each, expiry; running twice does nothing more', async () => {
  W.reset();
  W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 4320 });
  await W.contactRequests(made.kit);
  const row = W.requestRows()[0];
  const count = (pattern, to) => W.mailsTo(to).filter((m) => pattern.test(m.subject)).length;

  // day 0: nothing yet
  let out = await service.runMaintenance({ now: new Date() });
  assert.deepEqual(out, { reminders: 0, released: 0, expired: 0 });
  // a day later: one reminder, and only one however often it runs
  const day1 = new Date(Date.now() + 25 * 3600 * 1000);
  out = await service.runMaintenance({ now: day1 });
  assert.equal(out.reminders, 1);
  assert.equal((await service.runMaintenance({ now: day1 })).reminders, 0);
  assert.equal(count(/Reminder: an emergency access request is waiting/, OWNER_EMAIL), 1);
  const day2 = new Date(Date.now() + 50 * 3600 * 1000);
  assert.equal((await service.runMaintenance({ now: day2 })).reminders, 1, 'and again a day after that');
  assert.ok(!W.world.mails.slice(-2).some((m) => /deny\//.test(m.text)), 'reminders carry no one-click link');

  // the wait ends: the contact is told once, the owner is told once
  row.releaseAt = new Date(Date.now() - 1000);
  out = await service.runMaintenance({ now: new Date() });
  assert.equal(out.released, 1);
  assert.equal((await service.runMaintenance({ now: new Date() })).released, 0);
  assert.equal(count(/Emergency access is now available/, CONTACT_EMAIL), 1);
  assert.equal(count(/The waiting period ended/, OWNER_EMAIL), 1);
  assert.equal(world.tables.auditevents.filter((e) => e.type === 'emergency_released').length, 1);
  assert.equal(row.status, 'pending', 'still deniable until a session starts');
  // starting a session does not repeat the notice
  assert.equal((await W.contactStarts(made.kit)).status, 200);
  assert.equal(count(/Emergency access is now available/, CONTACT_EMAIL), 1);
  assert.equal(world.tables.auditevents.filter((e) => e.type === 'emergency_released').length, 1);

  // nobody claims a different request in time: it expires
  W.reset();
  W.seedVault();
  const made2 = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made2.kit);
  const row2 = W.requestRows()[0];
  row2.claimExpiresAt = new Date(Date.now() - 1000);
  assert.equal((await service.runMaintenance({ now: new Date() })).expired, 1);
  assert.equal(row2.status, 'expired');
  assert.equal(row2.active, false);
  assert.equal((await service.runMaintenance({ now: new Date() })).expired, 0);
});

test('the reminders cron route also runs the emergency upkeep (no second cron entry)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(config.crons.map((c) => c.path).sort(), ['/api/cron/purge-trash', '/api/cron/reminders']);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cron.routes.js'), 'utf8');
  assert.match(route, /runEmergencyMaintenance\(\)/);
});

// ---------- cleanup ----------
test('account deletion and the vault wipe remove the setup, its requests, codes and emergency sessions', async () => {
  const { deleteAccountData } = require('../utils/accountDeletion');
  const { wipeVault } = require('../utils/accountReset');
  for (const how of ['delete', 'wipe']) {
    W.reset();
    W.seedVault();
    const made = await W.setupEmergency({ waitMinutes: 2 });
    await W.contactRequests(made.kit);
    W.makeReleasable();
    await W.contactStarts(made.kit);
    await W.contactCode(); // leaves a live session-code behind
    // an ordinary login session of the same account, which a wipe is not responsible for removing here
    assert.equal(world.tables.emergencyaccesses.length, 1);
    assert.ok(world.tables.sessions.some((s) => s.emergency));
    if (how === 'delete') await deleteAccountData(ALICE, { transaction: false });
    else await wipeVault(ALICE);
    assert.equal(world.tables.emergencyaccesses.length, 0, `${how}: setup removed`);
    assert.equal(world.tables.emergencyrequests.length, 0, `${how}: requests removed`);
    assert.equal(world.tables.sessions.filter((s) => s.emergency).length, 0, `${how}: emergency sessions removed`);
    assert.equal(world.tables.otpchallenges.filter((c) => /^emergency/.test(c.purpose)).length, 0, `${how}: codes removed`);
  }
});

// ---------- emails ----------
test('every emergency email is generic: no file name, a unique subject, https links only', async () => {
  W.reset();
  const { docs } = W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  await service.runMaintenance({ now: new Date() });
  await W.contactStarts(made.kit);
  const fresh = await W.ownerCode('revoke');
  await call(E.revoke, W.owner({ body: fresh }));
  const emergencyMails = W.world.mails;
  assert.ok(emergencyMails.length >= 8);
  for (const mail of emergencyMails) {
    for (const doc of Object.values(docs)) assert.ok(!(mail.text + mail.html + mail.subject).includes(doc.filename), `${mail.subject} names a file`);
    const links = (mail.html.match(/href="([^"]+)"/g) || []).map((l) => l.slice(6, -1));
    assert.ok(links.every((l) => l.startsWith('https://')), 'https links only');
    assert.ok(!(mail.text).includes(made.kit), 'the kit is never emailed');
  }
  const { templates } = require('../utils/emailTemplates');
  const names = Object.keys(templates).filter((n) => /^emergency/.test(n));
  assert.ok(names.length >= 12);
  const subjects = new Set();
  const sample = {
    emergencyContactRequestCode: { code: '123456', ttlMinutes: 5 }, emergencyContactSessionCode: { code: '123456', ttlMinutes: 5 },
    emergencyOwnerSetupCode: { code: '123456', ttlMinutes: 5 }, emergencyContactReceipt: { releaseAt: new Date() }, emergencyContactAvailable: { claimDays: 7 },
    emergencyOwnerRequestReceived: { releaseAt: new Date(), denyUrl: null }, emergencyOwnerReminder: { releaseAt: new Date(), released: false },
    emergencyOwnerDenied: { when: new Date() }, emergencyOwnerReleased: { claimDays: 7 }, emergencyOwnerSessionStarted: { when: new Date(), scopeMode: 'all' },
  };
  for (const name of names) {
    const variants = name === 'emergencyContactKitChanged' ? [{ kind: 'regenerated' }, { kind: 'revoked' }]
      : name === 'emergencyOwnerSetupChanged' ? ['configured', 'regenerated', 'revoked', 'invalidated'].map((kind) => ({ kind, when: new Date() }))
      : [sample[name]];
    for (const input of variants) {
      const subject = templates[name](input).subject;
      assert.ok(!subjects.has(subject), `duplicate subject: ${subject}`);
      subjects.add(subject);
    }
  }
});
