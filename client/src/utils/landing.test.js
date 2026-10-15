import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_DEMO_CHARS, createDemoKey, decryptDemo, demoSizes, demoSupported, encryptDemo, fromHex, toHex } from './encryptionDemo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- the in-browser encryption demo ----------

test('the demo encrypts in this tab and decrypts back to the same text (WebCrypto AES-256-GCM)', async () => {
  assert.equal(demoSupported(), true);
  const key = await createDemoKey();
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  for (const text of ['Land title, scan 2 of 3', '', 'ñandú 日本語 😀', 'x'.repeat(MAX_DEMO_CHARS)]) {
    const sealed = await encryptDemo(key, text);
    assert.equal(sealed.cipherHex.length / 2, new TextEncoder().encode(text).length + demoSizes.TAG_BYTES, 'ciphertext = text + 16-byte tag');
    assert.equal(sealed.ivHex.length / 2, demoSizes.IV_BYTES);
    assert.equal(await decryptDemo(key, sealed), text);
    if (text) assert.ok(!sealed.cipherHex.includes(toHex(new TextEncoder().encode(text))), 'the plain bytes are not in the output');
  }
});

test('typing changes the output, the same words never give the same bytes twice, and long input is cut', async () => {
  const key = await createDemoKey();
  const a = await encryptDemo(key, 'passport');
  const b = await encryptDemo(key, 'passports');
  const c = await encryptDemo(key, 'passport');
  assert.notEqual(a.cipherHex, b.cipherHex);
  assert.notEqual(a.cipherHex, c.cipherHex, 'a new random IV each time');
  assert.notEqual(a.ivHex, c.ivHex);
  const long = await encryptDemo(key, 'y'.repeat(MAX_DEMO_CHARS + 50));
  assert.equal((await decryptDemo(key, long)).length, MAX_DEMO_CHARS);
});

test('a wrong key or a single changed byte is refused, and the key cannot be read back out of the page', async () => {
  const key = await createDemoKey();
  const other = await createDemoKey();
  const sealed = await encryptDemo(key, 'secret words');
  await assert.rejects(decryptDemo(other, sealed));
  const bytes = fromHex(sealed.cipherHex);
  bytes[0] ^= 1;
  await assert.rejects(decryptDemo(key, { ...sealed, cipherHex: toHex(bytes) }));
  await assert.rejects(() => globalThis.crypto.subtle.exportKey('raw', key), 'the key is not extractable');
  assert.throws(() => fromHex('zz'));
});

test('the demo makes no network call at all', async () => {
  const blocked = (name) => () => {
    throw new Error(`${name} must not be used by the demo`);
  };
  const saved = {};
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
    saved[name] = globalThis[name];
    globalThis[name] = blocked(name);
  }
  try {
    const key = await createDemoKey();
    const sealed = await encryptDemo(key, 'offline');
    assert.equal(await decryptDemo(key, sealed), 'offline');
  } finally {
    for (const [name, value] of Object.entries(saved)) globalThis[name] = value;
  }
  // And nothing in its source can reach the network or any storage.
  for (const file of ['utils/encryptionDemo.js', 'components/site/EncryptionDemo.jsx']) {
    const text = strip(read(file));
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|axios|services\/api|localStorage|sessionStorage|indexedDB|document\.cookie/, file);
    assert.doesNotMatch(text, /extractable\s*[:=]\s*true|exportKey|createDemoKey\([^)]+\)/, `${file}: the key must stay unreadable`);
  }
  assert.match(read('components/site/EncryptionDemo.jsx'), /Demo: runs only in this tab/);
});

// ---------- the page itself ----------

const LANDING = [
  'pages/public/HomePage.jsx',
  'pages/public/HomeBelow.jsx',
  'pages/public/homeFaq.jsx',
  'pages/public/AboutSection.jsx',
  'pages/public/ContactSection.jsx',
  'components/site/EncryptionDemo.jsx',
  'components/site/HowItWorks.jsx',
  'components/site/ProtectionCompare.jsx',
  'components/site/Faq.jsx',
];
const LANDING_CSS = [
  'pages/public/HomePage.module.css',
  'pages/public/HomeBelow.module.css',
  'pages/public/AboutSection.module.css',
  'pages/public/ContactSection.module.css',
  'components/site/EncryptionDemo.module.css',
  'components/site/HowItWorks.module.css',
  'components/site/ProtectionCompare.module.css',
  'components/site/Faq.module.css',
];

test('the landing page loads nothing from outside: no external URL in its code or styles except the source-code link', () => {
  const config = read('config.js');
  const repo = /REPO_URL = '(https:\/\/github\.com\/[^']+)'/.exec(config)?.[1];
  assert.ok(repo, 'the repository link is one constant in config.js');
  for (const file of [...LANDING, ...LANDING_CSS]) {
    const text = strip(read(file));
    for (const match of text.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) assert.fail(`${file}: external URL ${match[0]}`);
    assert.doesNotMatch(text, /@import|url\(\s*['"]?(https?:)?\/\//, `${file}: no remote styles, fonts or images`);
    assert.doesNotMatch(text, /<(script|iframe|object|embed|link|img)\b[^>]*\b(src|href)=["'{]*(https?:)?\/\//, `${file}: no remote resource`);
  }
  // The only outward link is the repository, and it is a link (not something that loads).
  assert.match(strip(read('pages/public/AboutSection.jsx')), /href=\{REPO_URL\}[^>]*rel="noopener noreferrer"/);
});

test('no inline script, inline handler, eval or raw HTML on the landing page (the CSP forbids them)', () => {
  for (const file of LANDING) {
    const text = strip(read(file));
    assert.doesNotMatch(text, /<script\b|dangerouslySetInnerHTML|\beval\s*\(|new Function\s*\(|javascript:|\bon[a-z]+=["']/i, file);
  }
  // index.html: the one inline script is the existing, hashed theme snippet; the rest is the module entry.
  const html = fs.readFileSync(path.join(src, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
  assert.equal(scripts.length, 2);
  assert.ok(scripts.includes('type="module" src="/src/main.jsx"'));
  assert.ok(scripts.includes(''), 'the single inline script has no attributes (it is the hashed theme snippet)');
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});

test('the copy rules: no em dashes, emoji or marketing words on the page', () => {
  const banned = /\b(revolutioni[sz]e|supercharge|seamless(ly)?|effortless(ly)?|cutting-edge|game-changing|unlock the power|next-generation|trusted by)\b/i;
  for (const file of LANDING.filter((f) => !/ContactSection|Faq\.jsx/.test(f))) {
    const text = strip(read(file));
    assert.doesNotMatch(text, /—/, `${file}: em dash`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${file}: emoji`);
    assert.doesNotMatch(text, banned, `${file}: marketing word`);
  }
});

test('the old overstated sentence is gone from every place a visitor can read it', () => {
  const places = [...LANDING, 'utils/usePageMeta.js'].map((file) => strip(read(file)));
  places.push(fs.readFileSync(path.join(src, '..', 'index.html'), 'utf8'));
  for (const text of places) {
    assert.doesNotMatch(text, /database holds (only )?ciphertext and locked keys/i);
    assert.doesNotMatch(text, /holds only ciphertext/i);
  }
  const hero = strip(read('pages/public/HomePage.jsx')).replace(/\s+/g, ' ');
  assert.match(hero, /stored as ciphertext, and the key is locked by your password and your recovery key/);
  assert.match(hero, /can still see file names and sizes, and it is not end-to-end encrypted/);
});

test('the tabs follow the ARIA pattern: tablist, tabs with roving tabindex, arrow keys, a labelled panel', () => {
  const text = strip(read('components/site/HowItWorks.jsx'));
  for (const piece of ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'aria-selected', 'aria-controls', 'aria-labelledby', 'tabIndex={index === active ? 0 : -1}', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(text.includes(piece), `missing ${piece}`);
  }
  for (const label of ["'Sign up'", "'Upload'", "'Share'", "'Emergency'"]) assert.ok(text.includes(label), label);
});

test('the compare switch uses real radio buttons for the three viewpoints, the FAQ is an accordion with buttons', () => {
  const compare = strip(read('components/site/ProtectionCompare.jsx'));
  assert.match(compare, /type="radio"/);
  for (const label of ['Someone with a copy of the database', 'A person with your share link', 'A stranger on the internet']) assert.ok(compare.includes(label), label);
  const faq = strip(read('components/site/Faq.jsx'));
  assert.match(faq, /aria-expanded/);
  assert.match(faq, /<button/);
  const items = strip(read('pages/public/homeFaq.jsx'));
  for (const topic of ['recovery key', 'emailed code', 'Trust this browser', 'forget my password', 'read my files', 'Emergency Access', "isn't it end-to-end"]) {
    assert.ok(new RegExp(topic, 'i').test(items), `FAQ topic: ${topic}`);
  }
});

test('the landing page keeps the identity: Free, student-built, the nav, the theme toggle, the magenta accent', () => {
  assert.match(read('pages/public/HomePage.jsx'), /Free, student-built/);
  const header = read('components/site/SiteHeader.jsx');
  for (const label of ['About', 'Contact', 'Log in', 'Sign up', 'Switch to']) assert.ok(header.includes(label), label);
  assert.match(fs.readFileSync(path.join(src, 'styles', 'tokens.css'), 'utf8'), /--color-accent: #d45ebb;/);
});

test('the update banner leaves room at the bottom of the page and stays reachable by keyboard', () => {
  assert.match(read('components/UpdatePrompt.jsx'), /update-bar-open/);
  assert.match(read('components/UpdatePrompt.jsx'), /<button type="button"/);
  assert.match(fs.readFileSync(path.join(src, 'styles', 'global.css'), 'utf8'), /html\.update-bar-open body\s*\{\s*padding-bottom/);
});

test('motion is optional: the scroll reveal and smooth scrolling are off under reduced motion', () => {
  assert.match(read('components/site/Reveal.module.css'), /prefers-reduced-motion: no-preference/);
  assert.match(fs.readFileSync(path.join(src, 'styles', 'global.css'), 'utf8'), /prefers-reduced-motion: no-preference[\s\S]*scroll-behavior: smooth/);
});

test('there is one navigation bar on the landing page: the header (no second section bar, no leftovers)', () => {
  assert.ok(!fs.existsSync(path.join(src, 'components', 'site', 'PageIndex.jsx')));
  assert.ok(!fs.existsSync(path.join(src, 'components', 'site', 'PageIndex.module.css')));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(src).filter((f) => /\.(jsx?|css)$/.test(f) && !f.endsWith('landing.test.js'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PageIndex|useActiveSection/, file);
  }
  // The legal pages keep their own "On this page" list; the landing page does not have one.
  assert.doesNotMatch(strip(read('pages/public/HomePage.jsx')) + strip(read('pages/public/HomeBelow.jsx')), /On this page/);
  // The offset for a section title under the sticky header is ONE rule (global.css [id]), not two added together.
  const css = fs.readFileSync(path.join(src, 'styles', 'global.css'), 'utf8');
  assert.equal((css.match(/scroll-margin-top/g) || []).length, 1);
  assert.doesNotMatch(css, /scroll-padding-top/);
  for (const file of ['pages/public/HomeBelow.module.css', 'pages/public/AboutSection.module.css', 'pages/public/ContactSection.module.css']) assert.doesNotMatch(read(file), /scroll-margin-top|scroll-padding-top/, file);
});

test('the header About and Contact links scroll smoothly, also when the address is already theirs, and close the menu', () => {
  const header = strip(read('components/site/SiteHeader.jsx'));
  assert.match(header, /const onSectionClick = \(link\) => \(event\) =>/);
  assert.match(header, /behavior: reduceMotion \? 'auto' : 'smooth'/);
  assert.equal((header.match(/onClick=\{onSectionClick\(link\)\}/g) || []).length, 2, 'the bar and the menu');
  assert.match(strip(read('components/site/PublicLayout.jsx')), /behavior: reduceMotion \? 'auto' : 'smooth'/);
});
