import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { suggestEmailFix, TYPO_DOMAINS } from './emailTypos.js';
import { COPY_FEEDBACK_MS, keyColumns, keyDownloadText, keyForCopy, keyGroups, keySheet, keySpoken } from './recoveryKey.js';
import { clearSignupEmail, initialSignupState, nextStep, readSignupEmail, saveSignupEmail } from './signupDraft.js';
import { describeSignupFailure } from './inviteCode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');
const code = (relative) => read(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const KEY = 'X5N7-8DYX-9ERG-XMR3';

test('common typos in well-known domains get a suggestion that keeps the part before the @', () => {
  assert.equal(suggestEmailFix('name@gmial.com'), 'name@gmail.com');
  assert.equal(suggestEmailFix('name@gmai.com'), 'name@gmail.com');
  assert.equal(suggestEmailFix('name@gmail.con'), 'name@gmail.com');
  assert.equal(suggestEmailFix('name@yahooo.com'), 'name@yahoo.com');
  assert.equal(suggestEmailFix('name@hotmial.com'), 'name@hotmail.com');
  assert.equal(suggestEmailFix('name@outlok.com'), 'name@outlook.com');
  assert.equal(suggestEmailFix('  First.Last+tag@GMIAL.COM  '), 'First.Last+tag@gmail.com', 'trimmed; the local part is kept as typed');
});

test('nothing is suggested for a correct, unknown or unfinished address, and a suggestion is never a block', () => {
  for (const value of ['name@gmail.com', 'name@example.com', 'name@school.edu.ph', 'name@', '@gmial.com', 'name', '', undefined, null, 'name@gmial.com.ph']) {
    assert.equal(suggestEmailFix(value), null, String(value));
  }
  for (const domain of TYPO_DOMAINS) assert.notEqual(suggestEmailFix(`a@${domain}`), `a@${domain}`);
  const page = code('pages/auth/SignupPage.jsx');
  assert.match(page, /emailSuggestion && touched\.email/);
  assert.doesNotMatch(page.match(/const canSubmit = [^;]+;/)[0], /emailSuggestion/);
});

test('the chips are the four groups with no dash in any of them, so there is no trailing hyphen', () => {
  assert.deepEqual(keyGroups(KEY), ['X5N7', '8DYX', '9ERG', 'XMR3']);
  for (const group of keyGroups(KEY)) assert.ok(!group.includes('-'));
  assert.deepEqual(keyGroups('X5N7-'), ['X5N7']);
  assert.deepEqual(keyGroups(null), []);
});

test('the copy string is the normal dashed form on one line, and nothing else', () => {
  assert.equal(keyForCopy(KEY), 'X5N7-8DYX-9ERG-XMR3');
  assert.equal(keyForCopy(KEY).includes('\n'), false);
  assert.equal(keyForCopy(keyGroups(KEY).join('-')), KEY);
  assert.equal(COPY_FEEDBACK_MS, 2000);
});

test('a screen reader gets one labelled string', () => {
  assert.equal(keySpoken(KEY), 'Recovery key: X 5 N 7, 8 D Y X, 9 E R G, X M R 3');
});

test('the download holds the key, the email, the date and the keep-private line', () => {
  const text = keyDownloadText({ key: KEY, email: 'sam@example.com', date: new Date('2026-10-14T05:00:00Z') });
  const lines = text.split('\n');
  assert.ok(lines.includes('X5N7-8DYX-9ERG-XMR3'));
  assert.ok(lines.includes('Email: sam@example.com'));
  assert.ok(lines.includes('Date: 2026-10-14'));
  assert.equal(lines.at(-1), 'Keep this private. Warden cannot show it again.');
  assert.ok(!keyDownloadText({ key: KEY, date: new Date() }).includes('Email:'), 'no empty email line');
});

test('the printed sheet carries only the key sheet', () => {
  assert.deepEqual(keySheet({ key: KEY, email: 'sam@example.com', date: new Date('2026-10-14T05:00:00Z') }), {
    title: 'Warden recovery key',
    key: 'X5N7-8DYX-9ERG-XMR3',
    email: 'sam@example.com',
    date: '2026-10-14',
    note: 'Keep this private. Warden cannot show it again.',
  });
});

test('four columns on a desktop or tablet, a 2x2 block on a phone', () => {
  assert.equal(keyColumns(1366), 4);
  assert.equal(keyColumns(768), 4);
  assert.equal(keyColumns(561), 4);
  assert.equal(keyColumns(560), 2);
  assert.equal(keyColumns(360), 2);
  const css = read('pages/auth/auth.module.css');
  assert.match(css, /\.keyChips \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 560px\) \{[^@]*\.keyChips \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('separators are drawn between groups only, as paint, never as text', () => {
  const css = read('pages/auth/auth.module.css');
  assert.match(css, /\.keyChip \+ \.keyChip::before \{[^}]*content: '-'/, 'between two chips, never before the first or after the last');
  assert.match(css, /\.keyChip:nth-child\(odd\)::before \{\s*display: none/, 'on a phone none at the start of a row');
  const component = code('pages/auth/RecoveryKeyStep.jsx');
  assert.match(component, /groups\.map\(\(group, index\) => \(\s*<span key=\{index\} className=\{styles\.keyChip\} aria-hidden="true">\s*\{group\}\s*<\/span>/);
  assert.doesNotMatch(component, /\{index < groups\.length - 1 \? '-' : ''\}/, 'the old trailing hyphen is gone');
});

test('the copy button and a hand copy both give the dashed key; the feedback lasts two seconds', () => {
  const component = code('pages/auth/RecoveryKeyStep.jsx');
  assert.match(component, /navigator\.clipboard\.writeText\(keyForCopy\(recoveryKey\)\)/);
  assert.match(component, /onCopy=\{handleSelectionCopy\}/);
  assert.match(component, /event\.clipboardData\.setData\('text\/plain', keyForCopy\(recoveryKey\)\)/);
  assert.match(component, /setTimeout\(\(\) => setCopied\(false\), COPY_FEEDBACK_MS\)/);
  assert.match(component, /copied \? 'Copied' : 'Copy'/);
  assert.match(component, /window\.print\(\)/);
});

test('Continue stays disabled until the box is ticked; the warning is the short one', () => {
  const component = code('pages/auth/RecoveryKeyStep.jsx');
  assert.match(component, /disabled=\{!saved\}/);
  assert.match(component, /I have saved my recovery key\./);
  const text = component.replace(/\s+/g, ' ');
  assert.match(text, /<strong>This is shown only once\.<\/strong> If you forget your password, this key is the only way back in without losing your documents\./);
  assert.doesNotMatch(text, /Warden can&apos;t show it again or recover it for you/);
});

test('the print stylesheet shows only the key sheet', () => {
  const css = read('pages/auth/auth.module.css');
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /:global\(body \*\) \{\s*visibility: hidden !important/);
  assert.match(print, /\.printSheet,\s*\.printSheet \* \{\s*visibility: visible !important/);
  assert.match(css, /\.printSheet \{\s*display: none;/, 'invisible on screen');
});

test('the key lives only in memory: no browser storage, cookie, URL or log anywhere near it', () => {
  for (const file of ['pages/auth/RecoveryKeyStep.jsx', 'utils/recoveryKey.js', 'pages/auth/SignupPage.jsx', 'pages/auth/SignupCodeStep.jsx']) {
    const source = code(file);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|console\./, file);
  }
  const component = code('pages/auth/RecoveryKeyStep.jsx');
  assert.doesNotMatch(component, /<input[^>]*value=\{recoveryKey|<textarea|type="password"/, 'not in a form field');
  assert.match(component, /role="img"/);
  assert.match(component, /aria-label=\{keySpoken\(recoveryKey\)\}/);
  assert.match(component, /data-1p-ignore="true"/);
  assert.match(component, /data-lpignore="true"/);
  const page = code('pages/auth/SignupPage.jsx');
  assert.match(page, /setRecoveryKey\(null\)/, 'dropped on leaving the screen');
  assert.doesNotMatch(page, /navigate\([^)]*recoveryKey|state:\s*\{[^}]*recoveryKey/, 'not carried in the URL or router state');
});

function fakeStorage() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key), data };
}

test('a reload mid-flow returns to the form with the email filled in, and never the password', () => {
  const storage = fakeStorage();
  assert.deepEqual(initialSignupState(storage), { step: 'form', values: { email: '', password: '', confirm: '', invite: '' } });
  saveSignupEmail('sam@example.com', storage);
  const after = initialSignupState(storage);
  assert.equal(after.step, 'form');
  assert.equal(after.values.email, 'sam@example.com');
  assert.equal(after.values.password, '');
  assert.equal(after.values.confirm, '');
  assert.equal(after.values.invite, '');
  assert.deepEqual([...storage.data.values()], ['sam@example.com']);
  clearSignupEmail(storage);
  assert.equal(readSignupEmail(storage), '');
});

test('a blocked or hostile storage never breaks the page, and a junk value is ignored', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readSignupEmail(blocked), '');
  assert.doesNotThrow(() => saveSignupEmail('sam@example.com', blocked));
  assert.doesNotThrow(() => clearSignupEmail(blocked));
  const storage = fakeStorage();
  storage.setItem('warden.signup.email', '<script>alert(1)</script>');
  assert.equal(readSignupEmail(storage), '');
  saveSignupEmail('not an email', storage);
  assert.equal(storage.getItem('warden.signup.email'), '<script>alert(1)</script>', 'junk is not saved over it either');
});

test('the steps: form -> code -> key -> app; Back and an expired code return to the form', () => {
  assert.equal(nextStep('form', 'codeSent'), 'code');
  assert.equal(nextStep('code', 'verified'), 'key');
  assert.equal(nextStep('key', 'continue'), 'done');
  assert.equal(nextStep('code', 'back'), 'form');
  assert.equal(nextStep('code', 'expired'), 'form');
  assert.equal(nextStep('form', 'verified'), 'form', 'no skipping ahead');
  assert.equal(nextStep('form', 'continue'), 'form');
});

test('the page wires the three calls, shows the key before the app, and only stores the email', () => {
  const page = code('pages/auth/SignupPage.jsx');
  assert.match(page, /signupStart\(\{/);
  assert.match(page, /signupVerify\(\{ email: values\.email\.trim\(\), password: values\.password, code \}\)/);
  assert.match(page, /signupResend\(values\.email\.trim\(\)\)/);
  assert.match(page, /if \(token && step !== 'key'\) return <Navigate/, 'the session exists before the key is read, yet the key screen is not skipped');
  assert.match(page, /saveSignupEmail\(values\.email\.trim\(\)\)/);
  assert.match(page, /setPendingToken\(result\.sessionToken\)/);
  assert.doesNotMatch(page.slice(page.indexOf('onSubmitCode')), /setToken\(result/, 'the token is not set in the same tick as the step change (that skipped the key screen)');
  assert.match(page, /if \(step === 'key' && pendingToken\) \{\s*setToken\(pendingToken\)/);
  assert.doesNotMatch(page, /saveSignupEmail\([^)]*password/);
  assert.match(page, /navigate\('\/files'/);
  const service = code('services/authService.js');
  assert.match(service, /'\/auth\/signup\/start'/);
  assert.match(service, /'\/auth\/signup\/verify'/);
  assert.match(service, /'\/auth\/signup\/resend'/);
  assert.doesNotMatch(service, /api\.post\('\/auth\/signup',/, 'the old one-step route is not called');
});

test('step 2 is one numeric field with one-time-code autofill, a countdown, resend, Back and the neutral message', () => {
  const step = code('pages/auth/SignupCodeStep.jsx');
  assert.match(step, /inputMode="numeric"/);
  assert.match(step, /autoComplete="one-time-code"/);
  assert.match(step, /maxLength=\{CODE_LENGTH\}/);
  assert.match(step, /digitsOnly\(event\.target\.value\)\.slice\(0, CODE_LENGTH\)/, 'paste-friendly: anything pasted is cleaned to six digits');
  assert.match(step, /Wrong email\? Go back/);
  assert.match(step, /Resend code in/);
  assert.match(step, /Check your spam folder/);
  assert.match(step, /That code didn’t work\. Check it or ask for a new one\./);
  assert.equal((step.match(/<input\b/g) || []).length, 1, 'one field, not six boxes');
});

test('a domain that cannot receive mail shows under the email field', () => {
  const failure = describeSignupFailure({ response: { status: 400, data: { error: { code: 'EMAIL_DOMAIN_NO_MAIL', message: 'That email domain can’t receive mail. Check for a typo.' } } } });
  assert.deepEqual(failure, { kind: 'email', message: 'That email domain can’t receive mail. Check for a typo.' });
});
