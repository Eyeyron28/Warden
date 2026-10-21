import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const HOME_FILES = [
  'pages/public/HomePage.jsx',
  'pages/public/HomeBelow.jsx',
  'pages/public/homeFaq.jsx',
  'components/site/EncryptionDemo.jsx',
  'components/site/HowItWorks.jsx',
  'components/site/ProtectionCompare.jsx',
];

const PAGES = [
  ...HOME_FILES,
  'pages/public/PrivacyPage.jsx',
  'components/site/retention.js',
  'pages/public/TermsPage.jsx',
  'pages/public/limits.js',
  'components/ShareEditModal.jsx',
  'components/ShareModal.jsx',
  'pages/DevicesPage.jsx',
  'pages/EmergencyAccessPage.jsx',
  'pages/EmergencyContactPage.jsx',
  'components/emergency/EmergencyWizard.jsx',
  'utils/kitSheet.js',
  'utils/usePageMeta.js',
];

function words(file) {
  if (file === 'pages/public/HomePage.jsx') return HOME_FILES.map(wordsOf).join(' ');
  return wordsOf(file);
}
function wordsOf(file) {
  return read(file)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join(' ')
    .replace(/&apos;|&#39;|’/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
const all = PAGES.map((file) => [file, words(file)]);

test('nothing says the server never sees a share key, or that the log is tamper-evident', () => {
  for (const [file, text] of all) {
    assert.doesNotMatch(text, /so we never see\s+it/i, `${file}: "we never see it"`);
    assert.doesNotMatch(text, /We never receive the password or the plain key/i, file);
    assert.doesNotMatch(text, /never stores? the link's key/i, `${file}: the server makes the key, so it does see it`);
    assert.doesNotMatch(text, /tamper-evident|tamper evident/i, file);
    assert.doesNotMatch(text, /Intact\./, `${file}: the verdict must not read as a guarantee`);
  }
});

test('a share is not described as surviving the deletion of its original', () => {
  assert.doesNotMatch(words('components/ShareModal.jsx'), /deleting or editing the original file does not change or remove existing shared copies/i);
  assert.match(words('components/ShareModal.jsx'), /moving the original to Trash stops every share that includes it/i);
});

test('the share key wording says where the key comes from and what the server does with it', () => {
  for (const file of ['pages/public/HomePage.jsx', 'pages/public/PrivacyPage.jsx', 'pages/public/limits.js']) {
    const text = words(file);
    assert.match(text, /generated when you create the link/i, file);
    assert.match(text, /isn't sent to our server when someone opens the link/i, file);
    assert.match(text, /server does handle (the|it)/i, file);
  }
});

test('the activity log help says what the check can and cannot see', () => {
  for (const file of ['pages/public/HomePage.jsx', 'pages/public/PrivacyPage.jsx', 'pages/DevicesPage.jsx']) {
    const text = words(file);
    assert.match(text, /detects edits and gaps/i, file);
    assert.match(text, /cannot detect the removal of the newest entries by someone who can write to the database/i, file);
  }
});

test('nobody is promised an owner notification that the code does not guarantee', () => {
  for (const [file, text] of all) {
    assert.doesNotMatch(text, /email you (straight away|at once)|emailed straight away|told (right away|at once)|told about every request/i, file);
  }
  for (const file of ['pages/public/HomePage.jsx', 'pages/public/PrivacyPage.jsx', 'pages/EmergencyContactPage.jsx', 'components/emergency/EmergencyWizard.jsx', 'utils/kitSheet.js']) {
    assert.match(words(file), /refused if that email (can ?not|can't) be sent|if that email (can ?not|can't) be sent, the request is refused/i, file);
  }
});

test('sessions: 30 minutes idle and 12 hours at most, wherever sessions are described', () => {
  for (const [file, text] of all) {
    if (!/\b30 minutes\b/.test(text) || !/session/i.test(text)) continue;
    assert.match(text, /12 hours/, `${file} mentions the 30-minute session limit but not the 12-hour one`);
  }
  assert.doesNotMatch(words('pages/public/PrivacyPage.jsx'), /expire after 30 minutes of inactivity/);
  assert.match(words('pages/public/HomePage.jsx'), /Signed in sessions end after 30 minutes without activity, and after 12 hours at most/);
});

test('removed features are not described as available', () => {
  for (const [file, text] of all) assert.doesNotMatch(text, /paired phone|recovering with a phone|phone can still approve/i, file);
});

test('every mention of end-to-end encryption is a denial', () => {
  for (const [file, text] of all) {
    for (const match of text.matchAll(/end-to-end/gi)) {
      const before = text.slice(Math.max(0, match.index - 90), match.index);
      assert.match(before, /\bnot\b|n't|none of this makes|no\b/i, `${file}: "…${before.slice(-60)}end-to-end" must be a denial`);
    }
  }
});

test('the key is described as locked by the password and recovery key, not as unlockable by them alone', () => {
  assert.doesNotMatch(words('utils/usePageMeta.js'), /only your password or recovery key can unlock/i);
});
