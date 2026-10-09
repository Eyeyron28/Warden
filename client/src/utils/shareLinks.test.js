import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';

import {
  ALLOWED_SCHEMES,
  QR_OPTIONS,
  SHARE_INTRO,
  SHARE_SUBJECT,
  buildShareTargets,
  copyText,
  isAllowedShareHref,
  isMobileDevice,
  isShareLink,
  nativeSharePayload,
  qrPayload,
  shareMessage,
} from './shareLinks.js';
import { readKeyFromHash } from './shareCrypto.js';

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'; // 43 chars of base64url
const LINK = `https://warden.example.com/shared/0123456789abcdef0123456789abcdef#k=${KEY}`;
const PASSWORD_LINK = 'https://warden.example.com/shared/0123456789abcdef0123456789abcdef';
const byId = (targets) => Object.fromEntries(targets.map((t) => [t.id, t]));

/** What the receiving app gets back out of a URL, for each place the link can sit. */
const params = (href) => new URL(href).searchParams;

test('the share link is recognised, and anything else is not', () => {
  assert.equal(isShareLink(LINK), true);
  assert.equal(isShareLink(PASSWORD_LINK), true);
  assert.equal(isShareLink('http://localhost:5173/shared/abcdef0123456789#k=' + KEY), true, 'dev');
  for (const bad of [
    'http://warden.example.com/shared/abcdef0123456789', // plain http, not localhost
    'https://warden.example.com/files', // wrong path
    'https://warden.example.com/shared/abcdef0123456789?next=//evil.example', // query string
    'https://warden.example.com/shared/abcdef0123456789#other=1', // unknown fragment
    'https://user:pw@warden.example.com/shared/abcdef0123456789',
    'javascript:alert(1)', 'data:text/html,hi', '', null, undefined, 42,
  ]) assert.equal(isShareLink(bad), false, String(bad));
  assert.throws(() => buildShareTargets({ link: 'https://evil.example/' }), /Not a Warden share link/);
  assert.throws(() => shareMessage('javascript:alert(1)'));
});

test('the message is generic: no file name, purpose or owner, just the link', () => {
  assert.equal(shareMessage(LINK), `I shared a document with you on Warden: ${LINK}`);
  assert.equal(SHARE_INTRO, 'I shared a document with you on Warden:');
});

test('every target is encoded once and the #k= fragment survives intact in each', () => {
  const targets = byId(buildShareTargets({ link: LINK }));
  const message = `I shared a document with you on Warden: ${LINK}`;

  const wa = targets.whatsapp.href;
  assert.ok(wa.startsWith('https://wa.me/?text='));
  assert.equal(params(wa).get('text'), message);
  assert.ok(!/[ #]/.test(wa.slice('https://wa.me/?text='.length)), 'the raw # and spaces are encoded');

  const tg = targets.telegram.href;
  assert.ok(tg.startsWith('https://t.me/share/url?'));
  assert.equal(params(tg).get('url'), LINK);
  assert.equal(params(tg).get('text'), SHARE_INTRO);

  const viber = targets.viber.href;
  assert.ok(viber.startsWith('viber://forward?text='));
  assert.equal(decodeURIComponent(viber.split('text=')[1]), message);

  const gmail = targets.gmail.href;
  assert.ok(gmail.startsWith('https://mail.google.com/mail/?view=cm&fs=1&'));
  assert.equal(params(gmail).get('su'), SHARE_SUBJECT);
  assert.equal(params(gmail).get('body'), message);
  assert.equal(params(gmail).get('to'), null, 'no recipient, no &to=');

  // and the key read back out of each decoded link is the original key
  for (const decoded of [params(wa).get('text').split(': ')[1], params(tg).get('url'), params(gmail).get('body').split(': ')[1], decodeURIComponent(viber.split('text=')[1]).split(': ')[1]]) {
    assert.equal(readKeyFromHash(new URL(decoded).hash), KEY);
  }
});

test('Messenger: the app link on a phone, copy-and-open on a computer, and no Facebook App ID anywhere', () => {
  const phone = byId(buildShareTargets({ link: LINK, mobile: true })).messenger;
  assert.equal(phone.mode, 'app');
  assert.ok(phone.href.startsWith('fb-messenger://share/?link='));
  assert.equal(decodeURIComponent(phone.href.split('link=')[1]), LINK);
  const desktop = byId(buildShareTargets({ link: LINK, mobile: false })).messenger;
  assert.equal(desktop.mode, 'copy-open');
  assert.equal(desktop.href, 'https://www.messenger.com/');
  assert.equal(desktop.note, 'Link copied — paste it in a chat');
  assert.ok(!JSON.stringify(buildShareTargets({ link: LINK })).match(/app_id|facebook\.com\/dialog/i));
  assert.equal(byId(buildShareTargets({ link: LINK })).viber.note, 'Viber app not detected — link copied instead');
});

test('a recipient email is encoded into Gmail\'s &to=, special characters included, and a bad one is dropped', () => {
  const gmail = (recipientEmail) => byId(buildShareTargets({ link: LINK, recipientEmail })).gmail.href;
  const tricky = gmail("o'brien+docs&x=1@exam-ple.co.uk");
  assert.equal(params(tricky).get('to'), "o'brien+docs&x=1@exam-ple.co.uk");
  assert.ok(tricky.includes('&to=o\'brien%2Bdocs%26x%3D1%40exam-ple.co.uk') || tricky.includes('&to=o%27brien%2Bdocs%26x%3D1%40exam-ple.co.uk'));
  assert.equal(params(tricky).getAll('su').length, 1, 'the & inside the address did not start a new parameter');
  assert.equal(params(gmail('  sam@example.com ')).get('to'), 'sam@example.com');
  for (const bad of ['not an email', 'a@b', 'a@b.co,c@d.co', 'x@y.z>&bcc=evil@e.co', '', undefined]) {
    assert.equal(params(gmail(bad)).get('to'), null, String(bad));
  }
});

test('a password link (no key in it) goes through unchanged and nothing is added', () => {
  const targets = byId(buildShareTargets({ link: PASSWORD_LINK }));
  assert.equal(params(targets.telegram.href).get('url'), PASSWORD_LINK);
  assert.ok(!decodeURIComponent(targets.whatsapp.href).includes('#k='));
});

test('only https, viber and fb-messenger targets are ever produced; anything else is rejected', () => {
  assert.deepEqual([...ALLOWED_SCHEMES], ['https:', 'viber:', 'fb-messenger:']);
  for (const mobile of [true, false]) {
    for (const t of buildShareTargets({ link: LINK, recipientEmail: 'a@b.co', mobile })) assert.equal(isAllowedShareHref(t.href), true, t.id);
  }
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://wa.me/?text=x', 'file:///etc/passwd', 'intent://x#Intent;end', 'tel:123', 'sms:123', 'mailto:a@b.co', 'viber://forward?text=a b', 'https://wa.me/\nx', '//evil.example', 'not a url', '', null]) {
    assert.equal(isAllowedShareHref(bad), false, String(bad));
  }
});

test('the native share sheet gets title, text and the link in url (not twice)', () => {
  assert.deepEqual(nativeSharePayload(LINK), { title: 'Warden', text: SHARE_INTRO, url: LINK });
  assert.ok(!nativeSharePayload(LINK).text.includes('http'));
});

test('the QR encodes exactly the link that Copy copies, with error correction M and a quiet zone', async () => {
  assert.equal(qrPayload(LINK), LINK);
  assert.equal(QR_OPTIONS.errorCorrectionLevel, 'M');
  assert.ok(QR_OPTIONS.margin >= 4, 'at least the standard 4-module quiet zone');
  const qr = QRCode.create(qrPayload(LINK), { errorCorrectionLevel: QR_OPTIONS.errorCorrectionLevel });
  assert.equal(qr.errorCorrectionLevel.bit !== undefined, true);
  assert.equal(Buffer.from(qr.segments.map((s) => Buffer.from(s.data).toString('latin1')).join(''), 'latin1').toString(), LINK, 'the matrix carries the full link, #k= included');
  const png = await QRCode.toDataURL(qrPayload(LINK), { ...QR_OPTIONS });
  assert.match(png, /^data:image\/png;base64,/);
  assert.throws(() => qrPayload('https://other.example/'), /Not a Warden share link/);
});

test('copy uses the clipboard API, falls back to a textarea, and reports failure honestly', async () => {
  const calls = [];
  assert.equal(await copyText(LINK, { navigator: { clipboard: { writeText: async (t) => calls.push(t) } } }), true);
  assert.deepEqual(calls, [LINK]);

  // clipboard API refuses (permissions / insecure context): the textarea route copies the same text
  const created = [];
  const doc = {
    createElement: () => { const el = { style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, value: '' }; created.push(el); return el; },
    body: { appendChild() {}, removeChild() {} },
    execCommand: (cmd) => cmd === 'copy',
  };
  assert.equal(await copyText(LINK, { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, document: doc }), true);
  assert.equal(created[0].value, LINK, 'the fallback copied the full link including #k=');
  assert.equal(await copyText(LINK, { navigator: {}, document: { ...doc, execCommand: () => false } }), false);
  assert.equal(await copyText(LINK, {}), false);
});

test('phones and tablets are told apart from computers', () => {
  assert.equal(isMobileDevice('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/126 Mobile Safari/537.36', 5), true);
  assert.equal(isMobileDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 5), true);
  assert.equal(isMobileDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), true, 'iPadOS');
  assert.equal(isMobileDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0), false);
  assert.equal(isMobileDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 0), false);
});
