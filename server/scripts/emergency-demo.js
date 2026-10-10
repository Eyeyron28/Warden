/**
 * Drives the whole Emergency Access flow end to end against a THROWAWAY database, with a real HTTP server and real
 * waiting periods (EMERGENCY_DEMO_MODE, a 2-minute wait). DEMO ONLY.
 *
 *   cd server
 *   MONGO_URI="mongodb://127.0.0.1:27017/warden_demo" node scripts/emergency-demo.js            # real 2-minute waits (~5 minutes)
 *   MONGO_URI="..." node scripts/emergency-demo.js --fast                                       # backdates the clock in the database instead
 *
 * Safety: it will NOT read server/.env (dotenv is switched off for this process), it refuses to run without an
 * explicit MONGO_URI, and every email is captured in memory instead of being sent (so no real mailbox is ever
 * contacted and no SMTP setting is needed). It prints the database NAME, never the URI. The account it makes is
 * deleted at the end.
 *
 * What it shows, in order: setup (folder scope) -> contact request -> start-session refused before the wait ->
 * owner denies -> start-session refused, 24-hour cooldown -> request again -> wait -> start-session -> read a file
 * inside the scope -> fail to read one outside it -> fail to delete / upload / open anything else ->
 * the owner's audit timeline and "Verify log".
 */
const Module = require('module');

// 1. No .env, ever: dotenv becomes a no-op for everything loaded after this line.
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'dotenv') return { config: () => ({}) };
  return originalLoad.call(this, request, ...rest);
};

if (!process.env.MONGO_URI) {
  console.error('Set MONGO_URI to a throwaway database first (see the header of this file). Nothing was done.');
  process.exit(1);
}
const fast = process.argv.includes('--fast');

Object.assign(process.env, {
  NODE_ENV: 'development',
  EMERGENCY_DEMO_MODE: 'true',
  SIGNUP_MODE: 'open',
  PUBLIC_APP_URL: 'https://warden.example.com',
  SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', // (mail is captured below anyway)
});
delete process.env.VERCEL;
delete process.env.OTP_ENABLED;

const path = require('path');
const crypto = require('crypto');

// 2. Capture mail instead of sending it.
const outbox = [];
const emailModulePath = require.resolve('../utils/email');
const realEmail = require(emailModulePath);
require.cache[emailModulePath].exports = { ...realEmail, sendEmail: async (message) => { outbox.push({ ...message, at: Date.now() }); return true; } };

const mongoose = require('mongoose');
const app = require('../server');
const { deleteAccountData } = require('../utils/accountDeletion');
const { runMaintenance } = require('../utils/emergency/service');

const PASSWORD = 'Qx7!vTr29#mLpw';
const tag = crypto.randomBytes(3).toString('hex');
const OWNER = `owner-${tag}@example.com`;
const CONTACT = `contact-${tag}@example.com`;
let base;
const say = (line = '') => console.log(line);
const step = (title) => say(`\n=== ${title}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextIp = 1;

async function api(method, route, { token, body, form, ip } = {}) {
  const headers = { 'x-forwarded-for': ip || `198.51.100.${(nextIp = (nextIp % 250) + 1)}`, 'x-vercel-ip-country': 'PH' };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(base + route, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html page */ }
  return { status: response.status, json, text };
}
const message = (r) => r.json?.error?.message || r.json?.message || '';
const show = (label, r, extra = '') => say(`  ${label.padEnd(58)} -> HTTP ${r.status}${message(r) ? ` "${message(r)}"` : ''}${extra}`);
const lastCodeTo = (address) => {
  const mails = outbox.filter((m) => m.to === address);
  const found = mails.length ? /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text) : null;
  return found ? found[1] : '000000'; // no code was sent (for example the setup was turned off)
};
const subjectsTo = (address) => outbox.filter((m) => m.to === address).map((m) => m.subject);

async function ownerLogin() {
  const first = await api('POST', '/api/auth/unlock', { body: { email: OWNER, password: PASSWORD } });
  const second = await api('POST', '/api/auth/verify-otp', { body: { challengeToken: first.json.challengeToken, code: lastCodeTo(OWNER) } });
  if (!second.json?.sessionToken) throw new Error('owner login failed');
  return second.json.sessionToken;
}

async function ownerCode(token, action) {
  const started = await api('POST', '/api/emergency/challenge', { token, body: { action } });
  if (started.status !== 200) throw new Error(`challenge failed: ${message(started)}`);
  return { challengeToken: started.json.challengeToken, code: lastCodeTo(OWNER) };
}

// The real limit is five code emails an hour per owner address; the demo takes longer than a few minutes of mail, so it
// clears that one counter where it says an hour has passed (the lockout counters are left alone).
async function hourPasses(why) {
  const result = await mongoose.connection.db.collection('ratelimits').deleteMany({ bucket: 'emergency-code-owner' });
  say(`  (${why}: the code-email counter is reset in the database, ${result.deletedCount} row)`);
}

async function contactRequestsAccess(kit, label) {
  await api('POST', '/api/emergency/public/request-code', { body: { ownerEmail: OWNER, contactEmail: CONTACT } });
  const r = await api('POST', '/api/emergency/public/request', { body: { ownerEmail: OWNER, contactEmail: CONTACT, code: lastCodeTo(CONTACT), kit } });
  show(label, r, r.json?.releaseAt ? `  (release ${new Date(r.json.releaseAt).toISOString()})` : '');
  return r;
}

async function contactStarts(kit, label) {
  await api('POST', '/api/emergency/public/request-code', { body: { ownerEmail: OWNER, contactEmail: CONTACT } });
  const r = await api('POST', '/api/emergency/public/start-session', { body: { ownerEmail: OWNER, contactEmail: CONTACT, code: lastCodeTo(CONTACT), kit } });
  show(label, r);
  return r;
}

async function main() {
  await mongoose.connection.asPromise?.().catch(() => {});
  await require('../config/db')();
  say(`Database: "${mongoose.connection.name}" (throwaway). Mail is captured, never sent. Demo mode: ${fast ? 'FAST (clock backdated in the DB)' : 'real 2-minute waits'}.`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  let userId;
  try {
    step('0. An owner account with a few files');
    await api('POST', '/api/auth/signup', { body: { email: OWNER, password: PASSWORD } });
    const verify = outbox.filter((m) => m.to === OWNER).at(-1);
    const verifyToken = /token=([0-9a-f]+)/.exec(verify.text)[1];
    await api('POST', '/api/auth/verify-email', { body: { token: verifyToken } });
    const owner = await ownerLogin();
    userId = (await mongoose.connection.db.collection('users').findOne({ email: OWNER }))._id;
    const upload = async (folder, name) => {
      const form = new FormData();
      form.append('file', new Blob([`contents of ${name}`], { type: 'text/plain' }), name);
      form.append('folder', folder);
      const r = await api('POST', '/api/documents', { token: owner, form });
      return r.json.id;
    };
    const taxId = await upload('Taxes', 'tax-return.txt');
    const medId = await upload('Medical', 'medical-record.txt');
    const rootId = await upload('', 'passport.txt');
    say('  uploaded: Taxes/tax-return.txt, Medical/medical-record.txt, passport.txt (top level)');
    const taxesFolder = await mongoose.connection.db.collection('folders').findOne({ userId, name: 'Taxes' });

    step('1. Setup (fresh emailed code; scope = the Taxes folder only; 2-minute wait, demo mode)');
    const noCode = await api('POST', '/api/emergency/setup', { token: owner, body: { contactEmail: CONTACT, waitMinutes: 2, scope: { mode: 'all' } } });
    show('setup WITHOUT a code', noCode);
    const fresh = await ownerCode(owner, 'setup');
    const setup = await api('POST', '/api/emergency/setup', { token: owner, body: { contactEmail: CONTACT, contactLabel: 'Sam', waitMinutes: 2, scope: { mode: 'folders', folderIds: [String(taxesFolder._id)] }, ...fresh } });
    show('setup with the fresh code', setup);
    const kit = setup.json.kit;
    say(`  kit shown once to the owner: ${kit.slice(0, 9)}… (${kit.length} characters; K1 is stored nowhere)`);
    const access = await mongoose.connection.db.collection('emergencyaccesses').findOne({ userId });
    say(`  stored: k2 (${access.k2.buffer.length} bytes), wrappedDek, salted kitHash; contains the kit? ${JSON.stringify(access).includes(kit.replace(/-/g, '')) ? 'YES (BAD)' : 'no'}`);

    step('2. The contact (no account) asks for a code, then requests access');
    const neutralA = await api('POST', '/api/emergency/public/request-code', { body: { ownerEmail: OWNER, contactEmail: CONTACT } });
    const neutralB = await api('POST', '/api/emergency/public/request-code', { body: { ownerEmail: 'nobody@example.com', contactEmail: CONTACT } });
    say(`  matching details : HTTP ${neutralA.status} "${neutralA.json.message}"`);
    say(`  unknown owner    : HTTP ${neutralB.status} "${neutralB.json.message}"   <- identical answer`);
    const bad = await api('POST', '/api/emergency/public/request', { body: { ownerEmail: OWNER, contactEmail: CONTACT, code: lastCodeTo(CONTACT), kit: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-IIII-JJJJ-KKKK-LLLL-M' } });
    show('request with a WRONG kit', bad);
    const first = await contactRequestsAccess(kit, 'request with the right kit and a fresh code');
    say(`  owner was emailed at once: "${subjectsTo(OWNER).at(-1)}"`);
    say(`  contact got a receipt:     "${subjectsTo(CONTACT).at(-1)}"`);
    const denyUrl = /https:\/\/warden\.example\.com(\/api\/emergency\/public\/deny\/[A-Za-z0-9_-]+)/.exec(outbox.filter((m) => m.to === OWNER).at(-1).text)[1];
    say(`  the email carries a single-use deny link (${denyUrl.slice(0, 40)}…)`);

    step('3. Start-session is refused before the waiting period ends (right kit, valid code)');
    await contactStarts(kit, 'start-session now');

    step(`4. ${fast ? 'Time passes (FAST mode: releaseAt moved into the past in the database)' : 'Waiting 2 minutes (real time)'}`);
    if (fast) {
      await mongoose.connection.db.collection('emergencyrequests').updateOne({ userId, active: true }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    } else {
      for (let left = 125; left > 0; left -= 25) { say(`  …${left}s`); await wait(25000); }
    }
    const upkeep = await runMaintenance();
    say(`  daily job (part of /api/cron/reminders): ${JSON.stringify(upkeep)}`);
    say(`  contact told: "${subjectsTo(CONTACT).at(-1)}"; owner told: "${subjectsTo(OWNER).at(-1)}"`);

    step('5. The owner DENIES (the request is still deniable until a session starts). Then the contact tries');
    const status = await api('GET', '/api/emergency/status', { token: owner });
    const deny = await api('POST', `/api/emergency/requests/${status.json.request.id}/deny`, { token: owner });
    show('owner denies (signed in)', deny);
    await contactStarts(kit, 'start-session after the denial');
    const again = await contactRequestsAccess(kit, 'new request right after the denial (24h cooldown)');
    const twice = await api('GET', denyUrl);
    say(`  the old deny link, clicked again: HTTP ${twice.status} (generic page, nothing changes)`);

    step('6. After the cooldown (FAST-FORWARD: the denial is backdated 25h in the database) the contact asks again');
    await hourPasses('a day later');
    await mongoose.connection.db.collection('emergencyrequests').updateMany({ userId, status: 'denied' }, { $set: { deniedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    await contactRequestsAccess(kit, 'request again');
    say(fast ? '  (FAST mode: releaseAt moved into the past)' : '  waiting 2 minutes (real time)…');
    if (fast) await mongoose.connection.db.collection('emergencyrequests').updateOne({ userId, active: true }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    else for (let left = 125; left > 0; left -= 25) { say(`  …${left}s`); await wait(25000); }

    step('7. The wait is over and nobody denied: the contact starts a read-only session');
    await hourPasses('the wait took a while');
    const started = await contactStarts(kit, 'start-session');
    const token = started.json.sessionToken;
    say(`  session ends at ${started.json.endsAt} (4 hours at most, 30 minutes idle); scope: ${started.json.scope.mode} ${JSON.stringify(started.json.scope.folders)}`);

    step('8. What the emergency session can and cannot do');
    const list = await api('GET', '/api/documents', { token });
    say(`  GET  /api/documents            -> HTTP ${list.status}: ${JSON.stringify(list.json.map((d) => `${d.folder}/${d.filename}`))}`);
    const view = await api('GET', `/api/documents/${taxId}/view`, { token });
    show(`read a file INSIDE the scope (Taxes/tax-return.txt)`, view, `  body: "${view.text}"`);
    show('read a file OUTSIDE the scope (Medical/…)', await api('GET', `/api/documents/${medId}/view`, { token }));
    show('read the top-level file (outside the scope)', await api('GET', `/api/documents/${rootId}/view`, { token }));
    show('list the Medical folder', await api('GET', '/api/documents/folders/children?path=Medical', { token }));
    show('DELETE the in-scope file', await api('DELETE', `/api/documents/${taxId}`, { token }));
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'planted.txt');
    show('UPLOAD a file', await api('POST', '/api/documents', { token, form }));
    show('RENAME the in-scope file', await api('PATCH', `/api/documents/${taxId}`, { token, body: { filename: 'renamed.txt' } }));
    show('create a SHARE link', await api('POST', '/api/shares', { token, body: { documentIds: [taxId], durationHours: 1 } }));
    show("open the owner's ACTIVITY log", await api('GET', '/api/security/activity', { token }));
    show("open the owner's ACCOUNT settings", await api('GET', '/api/account/preferences', { token }));
    show('open EMERGENCY settings', await api('GET', '/api/emergency/status', { token }));
    show('log out (allowed)', await api('POST', '/api/auth/logout', { token }));
    show('use the session after logging out', await api('GET', '/api/documents', { token }));

    step("9. The owner's audit timeline (group: emergency) and Verify log");
    const ownerAgain = await ownerLogin();
    const activity = await api('GET', '/api/security/activity?group=emergency', { token: ownerAgain });
    for (const event of [...activity.json.events].reverse()) {
      say(`  #${String(event.seq).padStart(2)}  ${event.type.padEnd(28)} actor=${String(event.actor).padEnd(9)} country=${event.country || '-'} ${event.flags.length ? `FLAGS: ${event.flags.map((f) => f.label).join('; ')}` : ''}`);
    }
    say(`  banner count (flagged in the last 7 days): ${activity.json.flaggedRecent}`);
    const verifyLog = await api('POST', '/api/security/verify-log', { token: ownerAgain });
    say(`  Verify log -> ${verifyLog.json.ok ? 'INTACT' : 'BROKEN'} (${verifyLog.json.checked} events checked${verifyLog.json.reason ? `, ${verifyLog.json.reason}` : ''})`);
    const titles = JSON.stringify(activity.json.events);
    say(`  events contain a file name? ${/tax-return|medical-record|passport/.test(titles) ? 'yes (names are looked up for display only)' : 'no'}; contain the kit? ${titles.includes(kit.replace(/-/g, '')) ? 'YES (BAD)' : 'no'}`);

    step('10. The owner turns it off');
    const revokeCode = await ownerCode(ownerAgain, 'revoke');
    show('revoke (fresh code)', await api('POST', '/api/emergency/revoke', { token: ownerAgain, body: revokeCode }));
    await contactRequestsAccess(kit, 'the contact tries again after revoke');
    say('\nDone.');
    server.close();
  } finally {
    if (userId) {
      await deleteAccountData(userId, { email: OWNER, transaction: false }).catch(() => {});
      say(`(demo account deleted from "${mongoose.connection.name}")`);
    }
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
