import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { PRIVACY_POLICY } from '../config.js';
import { RETENTION } from '../components/site/retention.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const words = (file) => strip(read(file)).replace(/&apos;|&#39;|’/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ---------- the policy version ----------

test('the policy version on the page is the one the server records with a new account', () => {
  const server = require('../../../server/utils/policyVersion.js');
  assert.equal(PRIVACY_POLICY.version, server.PRIVACY_POLICY_VERSION);
  assert.match(PRIVACY_POLICY.version, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/, 'a date, plus .2, .3 ... for a second text on the same day');
  // the date shown is the same day as the version
  const [year, month, day] = PRIVACY_POLICY.version.split('.')[0].split('-').map(Number);
  assert.equal(PRIVACY_POLICY.date, `${day} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month - 1]} ${year}`);
  assert.match(strip(read('pages/public/PrivacyPage.jsx')), /\$\{PRIVACY_POLICY\.date\} \(policy version \$\{PRIVACY_POLICY\.version\}\)/);
});

// If this fails you changed what the privacy page says. Bump PRIVACY_POLICY_VERSION in server/utils/policyVersion.js and
// PRIVACY_POLICY in client/src/config.js (version and date), then put the new fingerprint here (it is printed by the failure).
const POLICY_TEXT_FINGERPRINT = '71fb1d9759186367597512d74021eaa8e2216171560652eecca6180b3e627852';

function policyFingerprint() {
  const files = ['pages/public/PrivacyPage.jsx', 'pages/public/limits.js', 'components/site/retention.js'];
  // The contact address is shown on the page too, so it is part of what the version stands for.
  const contact = /CONTACT_EMAIL = '([^']+)'/.exec(read('config.js'))[1];
  const text = [...files.map((file) => strip(read(file)).replace(/\s+/g, '')), contact].join('|');
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('the privacy text and its version change together (bump the version when the page text changes)', () => {
  assert.equal(policyFingerprint(), POLICY_TEXT_FINGERPRINT, 'the privacy page text changed: bump the policy version and the date, then update this fingerprint');
});

// ---------- what the page says ----------

test('the page lists each right and how it works here, and the complaint route, without a link or a named person it cannot back', () => {
  const text = words('pages/public/PrivacyPage.jsx');
  for (const right of ['Access\\.', 'Correction\\.', 'Erasure\\.', 'Objection and withdrawing consent\\.', 'Data portability\\.', 'Complaints\\.']) assert.match(text, new RegExp(right), right);
  assert.match(text, /Deleting your account withdraws your consent/);
  assert.match(text, /Export gives you a zip/);
  assert.match(text, /National Privacy Commission of the Philippines \(privacy\.gov\.ph\)/);
  assert.doesNotMatch(strip(read('pages/public/PrivacyPage.jsx')), /href=["'{`]?https?:\/\/(www\.)?privacy\.gov\.ph/, 'named, not linked');
  // The contact is the mailbox the site already shows; nobody is named.
  assert.match(text, /that mailbox is the project's contact; it is not a named person/i);
  assert.match(strip(read('config.js')), /CONTACT_EMAIL = 'wardenvaultapp@gmail\.com'/);
});

test('the page says new accounts record the agreement and older accounts have none', () => {
  const text = words('pages/public/PrivacyPage.jsx');
  assert.match(text, /we keep the time you agreed to the Terms and this policy, and the version of this policy you agreed to/);
  assert.match(text, /Accounts created before this record existed have none, and we do not pretend otherwise/);
});

test('the retention table matches the code', () => {
  const rows = Object.fromEntries(RETENTION.map((row) => [row.what, row.how]));
  const need = (what, pattern) => assert.match(rows[what] || '', pattern, what);
  need('Trash', /30 days/);
  need('Activity log', /30 days by default/);
  need('Sign-in sessions', /30 minutes without activity, and after 12 hours at most/);
  need('Sign-up code (before an account exists)', /few minutes/);
  need('Emailed login, reset and deletion codes', /few minutes/);
  need('Trusted browsers', /30 days/);
  need('Share links and their encrypted copies', /At most 30 days/);
  need('Accounts from the old sign-up that were never verified', /24 hours/);
  need('Your agreement (new accounts)', /deleted with it/);
  need('Everything, when you delete your account', /immediately/);

  // and each number against the server's own constants
  const audit = require('../../../server/utils/auditConfig.js');
  assert.equal(audit.DEFAULT_RETENTION_DAYS, 30);
  const legacy = require('../../../server/utils/legacyCleanup.js');
  assert.equal(legacy.MIN_AGE_MS, 24 * 60 * 60 * 1000);
  const shares = require('../../../server/utils/shareLimits.js');
  assert.equal(shares.MAX_DURATION_HOURS, 24 * 30);
  const trash = fs.readFileSync(path.join(src, '..', '..', 'server', 'utils', 'trash.js'), 'utf8');
  assert.match(trash, /const RETENTION_DAYS = 30;/);
  const trusted = fs.readFileSync(path.join(src, '..', '..', 'server', 'utils', 'trustedDevice.js'), 'utf8');
  assert.match(trusted, /TRUST_DAYS = 30/);
  const sessions = fs.readFileSync(path.join(src, '..', '..', 'server', 'utils', 'sessionStore.js'), 'utf8');
  assert.match(sessions, /SESSION_TTL_MS = 30 \* 60 \* 1000/);
  assert.match(sessions, /DEFAULT_ABSOLUTE_HOURS = 12/);
});

test('the page shows the retention table, and the table is the one in the sign-up dialog too', () => {
  assert.match(strip(read('pages/public/PrivacyPage.jsx')), /<RetentionTable \/>/);
  const modal = strip(read('components/site/LegalModal.jsx'));
  assert.match(modal, /SECTIONS/, 'the dialog renders the same sections');
});

test('sign-up cannot be submitted without ticking the agreement, and the server asks for it too', () => {
  assert.match(strip(read('pages/auth/SignupPage.jsx')), /const canSubmit = isValid && agreed && legalAllRead;/);
  assert.match(strip(read('services/authService.js')), /termsAccepted: true/);
  const server = fs.readFileSync(path.join(src, '..', '..', 'server', 'controllers', 'signup.controller.js'), 'utf8');
  assert.match(server, /if \(termsAccepted !== true\) throw badRequest\(/);
});
