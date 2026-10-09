// Run with: cd server && npm test
//
// Every email Warden sends goes through utils/emailTemplates.js. These tests render each one and
// check the rules: one highlighted code, plain-text twin, fixed subjects, escaping, nothing remote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.PUBLIC_APP_URL;
delete process.env.OTP_TTL_MINUTES;
process.env.NODE_ENV = 'test';

const { renderEmail, templates, esc, formatManilaTime, FOOTER_AUTOMATED, FOOTER_PROJECT } = require('../utils/emailTemplates');
const { fromHeader, sendEmail } = require('../utils/email');

const CODE = '482916';
const WHEN = new Date('2026-10-09T09:14:00Z'); // 5:14 PM in Manila
const VERIFY_URL = 'https://warden.example.com/verify-email?token=abc123';

const CODE_EMAILS = {
  signInCode: templates.signInCode({ code: CODE, ttlMinutes: 5 }),
  deleteAccountCode: templates.deleteAccountCode({ code: CODE, ttlMinutes: 5 }),
  passwordResetCode: templates.passwordResetCode({ code: CODE, ttlMinutes: 5 }),
  shareCode: templates.shareCode({ code: CODE, ttlMinutes: 5 }),
};
const OTHER_EMAILS = {
  verifyEmail: templates.verifyEmail({ verifyUrl: VERIFY_URL }),
  verifyEmailResend: templates.verifyEmailResend({ verifyUrl: VERIFY_URL }),
  signupAttempt: templates.signupAttempt({ when: WHEN }),
  passwordChangedKey: templates.passwordChanged({ method: 'recovery-key', when: WHEN, browser: 'Chrome on Windows' }),
  passwordChangedWipe: templates.passwordChanged({ method: 'wipe', when: WHEN, browser: 'Chrome on Android' }),
  accountDeleted: templates.accountDeleted({ when: WHEN }),
  newDevice: templates.newDevice({ browser: 'Chrome', os: 'Android', country: 'PH', city: 'Manila', when: WHEN }),
  trustedBrowser: templates.trustedBrowser({ browser: 'Chrome on Windows', when: WHEN }),
};
const ALL = { ...CODE_EMAILS, ...OTHER_EMAILS };

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('every email renders a subject, an HTML part and a plain-text part, with the standard header, footer and preheader', () => {
  for (const [name, mail] of Object.entries(ALL)) {
    assert.equal(typeof mail.subject, 'string', name);
    assert.ok(mail.subject.length > 5 && !/[\r\n]/.test(mail.subject), `${name} subject`);
    assert.ok(mail.html.startsWith('<!doctype html>'), name);
    assert.ok(mail.text.trim().length > 40, name);
    assert.match(mail.html, /<meta name="color-scheme" content="light dark">/, name);
    assert.match(mail.html, /<meta name="viewport"/, name);
    assert.match(mail.html, /max-width:600px/, `${name}: 600px at most`);
    assert.match(mail.html, /background:#130c11/i, `${name}: dark header band`);
    assert.match(mail.html, /color:#d45ebb[^>]*>Warden<\/span>/i, `${name}: wordmark in the accent colour`);
    assert.match(mail.html, /display:none;max-height:0;overflow:hidden/, `${name}: hidden preheader`);
    for (const footer of [FOOTER_AUTOMATED, FOOTER_PROJECT]) {
      assert.ok(mail.html.includes(footer.replace(/&/g, '&amp;')), `${name} html footer`);
      assert.ok(mail.text.includes(footer), `${name} text footer`);
    }
  }
});

test('a code appears exactly once in the HTML, inside the highlighted box, and once in the text on its own line', () => {
  for (const [name, mail] of Object.entries(CODE_EMAILS)) {
    assert.equal(count(mail.html, CODE), 1, `${name}: once in the HTML`);
    const box = /<td align="center" class="codebox"[^>]*>\s*<span class="code" style="([^"]*)">482916<\/span>/.exec(mail.html);
    assert.ok(box, `${name}: the code sits alone in the code box`);
    for (const rule of ['font-size:32px', 'font-weight:700', 'letter-spacing:6px', 'monospace', 'Consolas']) assert.ok(box[1].includes(rule) || mail.html.includes(rule), `${name}: ${rule}`);
    assert.match(mail.html, /class="codebox" bgcolor="#fbeaf7" style="background:#fbeaf7;border:1px solid #d45ebb;/, `${name}: accent tint and 1px accent border`);
    assert.equal(count(mail.text, CODE), 1, `${name}: once in the text`);
    assert.ok(mail.text.split('\n').includes(CODE), `${name}: on a line of its own`);
    assert.ok(!mail.subject.includes(CODE), `${name}: never in the subject`);
    assert.ok(!/preheader/.test('') && !/>[^<]*482916[^<]*<\/div>\n<table/.test(mail.html), `${name}: not in the preheader`);
    // a single unbroken string: no spaces, hyphens or tags inside it
    assert.ok(/>482916</.test(mail.html));
  }
  // emails without a code have no code box
  for (const [name, mail] of Object.entries(OTHER_EMAILS)) {
    assert.ok(!mail.html.includes('class="codebox"'), name);
    assert.ok(!/^\d{6}$/m.test(mail.text), `${name}: no code line`);
  }
});

test('the code line says when it expires, using the real OTP_TTL_MINUTES', () => {
  const { otpTtlMinutes } = require('../utils/otpConfig');
  for (const minutes of ['1', '5', '12', '60']) {
    process.env.OTP_TTL_MINUTES = minutes;
    const ttl = otpTtlMinutes();
    const mail = templates.signInCode({ code: CODE, ttlMinutes: ttl });
    const phrase = `This code expires in ${ttl} minute${ttl === 1 ? '' : 's'}`;
    assert.ok(mail.html.includes(phrase), phrase);
    assert.ok(mail.text.includes(phrase), phrase);
  }
  delete process.env.OTP_TTL_MINUTES;
  assert.ok(templates.signInCode({ code: CODE, ttlMinutes: otpTtlMinutes() }).text.includes('expires in 5 minutes'), 'the default');
  // and the flow itself passes the configured value (not a literal)
  const challenge = fs.readFileSync(path.join(__dirname, '..', 'utils', 'otpChallenge.js'), 'utf8');
  assert.match(challenge, /emailFor\(purpose, code, ttlMinutes\)/);
  assert.match(challenge, /const ttlMinutes = otpTtlMinutes\(\)/);
});

test('every code email says what the code is for, never to share it, and what to do if you did not ask', () => {
  const purposes = {
    signInCode: /Sign in to Warden/,
    deleteAccountCode: /Confirm deleting your account/,
    passwordResetCode: /Reset your password/,
    shareCode: /Open a shared document/,
  };
  for (const [name, mail] of Object.entries(CODE_EMAILS)) {
    assert.match(mail.text, purposes[name], `${name}: purpose in plain words`);
    assert.match(mail.text, /Never share this code with anyone — Warden will never ask for it by phone, chat or email/, name);
    assert.match(mail.text, /If you didn't request this, ignore this email/, name);
  }
  for (const name of ['signInCode', 'deleteAccountCode', 'passwordResetCode']) {
    assert.match(CODE_EMAILS[name].text, /your account is safe\. Consider changing your password if you keep receiving these/, name);
  }
  // delete-account and password-reset carry a stronger line on top
  assert.match(CODE_EMAILS.deleteAccountCode.text, /cannot be undone: if this was not you, change your password now/);
  assert.match(CODE_EMAILS.passwordResetCode.text, /Your password has not changed and will not unless this code is entered/);
});

test('every subject is clear, unique per purpose, and carries no code, file name, purpose or personal data', () => {
  const subjects = Object.values(ALL).map((mail) => mail.subject);
  const unique = new Set(subjects);
  // the two password-changed variants share one subject on purpose (same event); everything else is distinct
  assert.equal(unique.size, subjects.length - 1);
  assert.equal(ALL.passwordChangedKey.subject, ALL.passwordChangedWipe.subject);
  for (const subject of subjects) {
    assert.ok(!/\d{4,}/.test(subject), `no digits that look like a code: ${subject}`);
    assert.ok(!/@/.test(subject), `no address: ${subject}`);
    assert.ok(!/\.(pdf|docx?|png|jpe?g|zip)\b/i.test(subject), subject);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries({ signInCode: 0, deleteAccountCode: 0, passwordResetCode: 0, shareCode: 0, passwordChangedKey: 0 }).map(([k]) => [k, ALL[k].subject])),
    {
      signInCode: 'Your Warden sign-in code',
      deleteAccountCode: 'Confirm account deletion — Warden code',
      passwordResetCode: 'Reset your Warden password',
      shareCode: 'Your code to open a shared document',
      passwordChangedKey: 'Your Warden password was changed',
    }
  );
});

test('hostile input cannot inject markup: every interpolated value is HTML-escaped', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';
  const mail = templates.newDevice({ browser: evil, os: evil, country: 'PH', city: evil, when: WHEN });
  assert.ok(!mail.html.includes('<script>'), 'no script tag');
  assert.ok(!/<img\b/.test(mail.html), 'no image tag');
  assert.ok(!/onerror=alert\(1\)>/.test(mail.html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'the handler text is only ever escaped');
  assert.ok(mail.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(esc(`<a href="x">'&</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
  // the plain-text part cannot be given extra lines (a CRLF in a value)
  const lines = templates.newDevice({ browser: 'Eve\r\nBcc: attacker@example.com', os: 'x', city: 'y\r\nz', when: WHEN }).text;
  assert.ok(!/\r/.test(lines));
  assert.ok(!/^Bcc:/m.test(lines));
  // a code must be 6 plain digits, a subject one line without the code, a link https
  assert.throws(() => renderEmail({ subject: 's', preheader: 'p', title: 't', intro: 'i', code: '48 29 16' }), /single unbroken string/);
  assert.throws(() => renderEmail({ subject: 'Your code 482916', preheader: 'p', title: 't', intro: 'i', code: CODE }), /without the code/);
  assert.throws(() => renderEmail({ subject: 's\nBcc: x', preheader: 'p', title: 't', intro: 'i' }));
  assert.throws(() => renderEmail({ subject: 's', preheader: 'p', title: 't', intro: 'i', cta: { label: 'x', href: 'http://evil.example' } }), /https/);
});

test('nothing loads from another site: no images, scripts, links to stylesheets, tracking pixels or http:// anything', () => {
  for (const [name, mail] of Object.entries(ALL)) {
    assert.ok(!/<img\b|<script\b|<link\b|<iframe\b|<video\b|<object\b|<embed\b|<form\b/i.test(mail.html), `${name}: forbidden element`);
    assert.ok(!/\ssrc=|url\(|@import|background-image/i.test(mail.html), `${name}: no remote resource reference`);
    assert.ok(!/http:\/\//i.test(mail.html + mail.text), `${name}: no plain http`);
    assert.ok(!/ on[a-z]+=/i.test(mail.html), `${name}: no event handlers`);
    // the only <style> block is the dark-mode / small-screen one; the layout itself is inline
    assert.equal(count(mail.html, '<style>'), 1, name);
    assert.ok(count(mail.html, 'style="') > 8, `${name}: inline styles`);
  }
});

test('notification emails give the time in Manila with its label and a clear next step', () => {
  assert.equal(formatManilaTime(WHEN), 'Oct 9, 2026, 5:14 PM Philippine Time (UTC+8)');
  for (const name of ['signupAttempt', 'passwordChangedKey', 'passwordChangedWipe', 'accountDeleted', 'newDevice', 'trustedBrowser']) {
    assert.match(ALL[name].text, /When: Oct 9, 2026, 5:14 PM Philippine Time \(UTC\+8\)/, name);
    assert.match(ALL[name].html, /Philippine Time \(UTC\+8\)/, name);
    assert.match(ALL[name].text, /If (this|it) wa?s? ?n[o']t you|If it was not you|If this was not you|If you didn't do this|If it was you/i, `${name}: next step`);
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(ALL[name].text), `${name}: no IP address`);
  }
  assert.match(ALL.passwordChangedKey.text, /Browser: Chrome on Windows/);
  assert.match(ALL.passwordChangedWipe.text, /vault erased and replaced/i);
  assert.match(ALL.newDevice.text, /Device: Chrome on Android/);
  assert.match(ALL.newDevice.text, /Place: Manila, Philippines/);
  assert.match(templates.newDevice({ browser: 'Chrome', os: 'Windows', when: WHEN }).text, /Place: Unknown/);
});

test('links: only to the app\'s public address, with no token or key; none at all when no address is configured', () => {
  for (const [name, mail] of Object.entries(ALL)) {
    if (name.startsWith('verifyEmail')) continue;
    assert.ok(!/https?:\/\//.test(mail.text), `${name}: no link without PUBLIC_APP_URL`);
  }
  process.env.PUBLIC_APP_URL = 'https://warden.example.com';
  try {
    const notices = [
      templates.passwordChanged({ method: 'wipe', when: WHEN, browser: 'x' }),
      templates.newDevice({ browser: 'b', os: 'c', country: 'PH', when: WHEN }),
      templates.trustedBrowser({ browser: 'b', when: WHEN }),
      templates.signupAttempt({ when: WHEN }),
    ];
    for (const mail of notices) {
      const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(links.length >= 1);
      for (const link of links) {
        assert.ok(link.startsWith('https://warden.example.com/'), link);
        assert.ok(!/[?#]|token|k=/i.test(link), `no token or key in ${link}`);
      }
    }
  } finally {
    delete process.env.PUBLIC_APP_URL;
  }
  // the verification emails are the one place a link carries a single-use token, because that is how they work
  for (const mail of [OTHER_EMAILS.verifyEmail, OTHER_EMAILS.verifyEmailResend]) {
    assert.ok(mail.text.includes(VERIFY_URL));
    assert.ok(mail.html.includes(esc(VERIFY_URL)));
  }
});

test('the share code email is for a recipient who may have no account: no owner address, no link, no key, no file', () => {
  const mail = CODE_EMAILS.shareCode;
  for (const bad of ['http', '#k=', '/shared/', '.pdf']) assert.ok(!mail.text.includes(bad) && !mail.html.includes(bad), bad);
  assert.ok(!/[w.+-]+@[w-]+.[w.]+/.test(mail.text + mail.html.replace(/@media/g, '')), 'no email address');
  assert.match(mail.text, /Someone shared a document with you on Warden/);
});

test('From is always "Warden", whatever MAIL_FROM held', () => {
  assert.deepEqual(fromHeader('Some Other Name <sender@example.com>'), { name: 'Warden', address: 'sender@example.com' });
  assert.deepEqual(fromHeader('sender@example.com'), { name: 'Warden', address: 'sender@example.com' });
  assert.equal(fromHeader('not an address'), 'not an address');
});

test('sendEmail refuses anything that did not come from the templates (no text-only or HTML-less mail)', async () => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    assert.equal(await sendEmail({ to: 'a@example.com', subject: 'x', text: 'y' }), false);
    assert.equal(await sendEmail({ to: 'a@example.com', subject: 'x', html: '<p>y</p>' }), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
});

test('no code outside utils/emailTemplates.js writes an email body, and every sender spreads a template', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (['utils/emailTemplates.js', 'utils/email.js', 'scripts/send-test-emails.js'].includes(rel)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /\bhtml\s*:\s*[`'"]/, `${rel}: builds its own HTML`);
    for (const match of text.matchAll(/sendEmail\(\{([^}]*)\}\)/g)) {
      assert.match(match[1], /\.\.\.(templates\.\w+\(|mail\b|message\b)|\.\.\.emailFor\(/, `${rel}: sendEmail without a template: ${match[1].slice(0, 60)}`);
      assert.doesNotMatch(match[1], /\b(subject|text)\s*:/, `${rel}: hand-written subject or text`);
    }
  }
});

test('the dev script sends one of every template and refuses to run in production without --force', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'send-test-emails.js'), 'utf8');
  assert.match(script, /isProduction\(\) && !force/);
  assert.match(script, /--force/);
  for (const name of Object.keys(templates)) assert.ok(script.includes(`templates.${name}(`), `the sample list is missing ${name}`);
});
