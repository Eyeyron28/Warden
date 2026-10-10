// Shared fixture for the Emergency Access tests: an in-memory world (no database), an owner with folders and files,
// and helpers that drive the REAL controllers, service, sessions and guard the way the routes do.
process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';
process.env.EMERGENCY_DEMO_MODE = 'true';

const crypto = require('node:crypto');

const db = require('./fakeDb');
const { encryptFile } = require('../../utils/crypto');

const world = db.createWorld();
db.installModels(world, {});
db.installMailer(world);
const budgets = db.installRateLimit();

const service = require('../../utils/emergency/service');
const E = require('../../controllers/emergency.controller');
const D = require('../../controllers/documents.controller');
const requireSession = require('../../middleware/requireSession');
const sessionStore = require('../../utils/sessionStore');
const kitLib = require('../../utils/emergency/kit');
const { call } = db;

const DEK = crypto.randomBytes(32);
const ALICE = db.oid();
const BOB = db.oid();
const OWNER_EMAIL = 'alice@example.com';
const CONTACT_EMAIL = 'sam@example.com';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const clearBudgets = () => budgets.clear();

function reset() {
  budgets.clear();
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
  world.tables.users.push({ _id: ALICE, email: OWNER_EMAIL, emailVerified: true, auditHead: { seq: 0, hash: '', at: null } });
  world.tables.users.push({ _id: BOB, email: 'bob@example.com', emailVerified: true, auditHead: { seq: 0, hash: '', at: null } });
}

function addFolder(path, owner = ALICE) {
  const parts = path.split('/');
  const name = parts.pop();
  const folder = { _id: db.oid(), userId: owner, parentPath: parts.join('/'), name, nameKey: name.toLowerCase() };
  world.tables.folders.push(folder);
  return folder;
}

function addDoc({ owner = ALICE, folder = 'root', filename = 'file.txt', content } = {}) {
  const plaintext = content ?? Buffer.from(`secret contents of ${filename}`);
  const sealed = encryptFile(plaintext, DEK);
  const doc = {
    _id: db.oid(), userId: owner, filename, folder, mimeType: 'text/plain',
    encryptedBlob: Buffer.from(sealed.ciphertext, 'base64'), iv: sealed.iv, authTag: sealed.authTag,
    checksum: sha256(plaintext), deletedAt: null, viewCount: 0, downloadCount: 0, lastOpenedAt: null, plaintext,
    createdAt: new Date(), updatedAt: new Date(),
  };
  world.tables.documents.push(doc);
  return doc;
}

/** Folders Taxes, Taxes/2024, Medical, Private, with a file in each and one at the top. */
function seedVault() {
  const folders = { taxes: addFolder('Taxes'), tax24: addFolder('Taxes/2024'), medical: addFolder('Medical'), priv: addFolder('Private') };
  const docs = {
    root: addDoc({ filename: 'root-passport.txt' }),
    taxes: addDoc({ folder: 'Taxes', filename: 'taxes-return.txt' }),
    tax24: addDoc({ folder: 'Taxes/2024', filename: 'taxes-2024.txt' }),
    medical: addDoc({ folder: 'Medical', filename: 'medical-record.txt' }),
    priv: addDoc({ folder: 'Private', filename: 'private-diary.txt' }),
  };
  return { folders, docs };
}

const owner = (extra = {}) => ({ userId: ALICE, dek: DEK, deviceId: null, emergency: null, ...extra });
const mailsTo = (address) => world.mails.filter((m) => m.to === address);
const lastMailTo = (address) => mailsTo(address).at(-1);
const codeFrom = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];

/** The owner's fresh emailed code for one action. */
async function ownerCode(action) {
  const started = await call(E.startCode, owner({ body: { action } }));
  if (started.error) throw started.error;
  return { challengeToken: started.json.challengeToken, code: codeFrom(lastMailTo(OWNER_EMAIL)) };
}

/** Sets emergency access up the way the API does (fresh code included). Returns the response (with the kit). */
async function setupEmergency({ scope = { mode: 'all' }, waitMinutes = 2, contactEmail = CONTACT_EMAIL, contactLabel = 'Sam' } = {}) {
  const fresh = await ownerCode('setup');
  const out = await call(E.setup, owner({ body: { contactEmail, contactLabel, waitMinutes, scope, ...fresh } }));
  if (out.error) throw out.error;
  return out.json;
}

const publicCall = (handler, body, extra = {}) => call(handler, { body, ip: '203.0.113.50', headers: { 'x-vercel-ip-country': 'PH' }, ...extra });

/** Asks for a code to the contact's mailbox and returns it. */
async function contactCode({ ownerEmail = OWNER_EMAIL, contactEmail = CONTACT_EMAIL, ip } = {}) {
  const before = mailsTo(contactEmail).length;
  const out = await publicCall(E.requestCode, { ownerEmail, contactEmail }, ip ? { ip } : {});
  if (out.error) throw out.error;
  const mails = mailsTo(contactEmail);
  return mails.length > before ? codeFrom(mails.at(-1)) : null;
}

/** A full, valid request by the contact. */
async function contactRequests(kit, extra = {}) {
  const code = await contactCode();
  return publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code, kit, ...extra });
}

async function contactStarts(kit, extra = {}) {
  const code = await contactCode();
  return publicCall(E.startSession, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code, kit, ...extra });
}

const accessRow = () => world.tables.emergencyaccesses[0];
const requestRows = () => world.tables.emergencyrequests;
/** Moves the clock for a request by editing the database, the way real time passing would show up. */
function makeReleasable(request = requestRows().at(-1)) {
  request.releaseAt = new Date(Date.now() - 1000);
  request.claimExpiresAt = new Date(Date.now() + 7 * 864e5);
}

/** A request the way requireSession sees it: resolve the bearer token against the (fake) session store. */
async function throughRequireSession(token, { method = 'GET', baseUrl = '/api/documents', path = '/' } = {}) {
  const req = { headers: { authorization: `Bearer ${token}` }, method, baseUrl, path, ip: '203.0.113.9', cookies: {} };
  let error = null;
  let reached = false;
  await requireSession(req, {}, (err) => {
    if (err) error = err;
    else reached = true;
  });
  return { error, reached, req };
}

module.exports = {
  world, db, call, service, E, D, kitLib, sessionStore, requireSession, DEK, ALICE, BOB, OWNER_EMAIL, CONTACT_EMAIL,
  reset, clearBudgets, addFolder, addDoc, seedVault, owner, mailsTo, lastMailTo, codeFrom, ownerCode, setupEmergency, publicCall,
  contactCode, contactRequests, contactStarts, accessRow, requestRows, makeReleasable, throughRequireSession, sha256,
};
