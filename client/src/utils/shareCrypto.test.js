// Run with: cd client && npm test   (Node's built-in test runner, no deps)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decryptBlob,
  decryptManifest,
  decryptManifestInfo,
  importShareKey,
  previewKind,
  readKeyFromHash,
  safeDownloadName,
} from './shareCrypto.js';

// The server's side of the format, so these tests prove the browser code and
// the server code agree byte for byte (Node's Web Crypto is the browser API).
const require = createRequire(import.meta.url);
const server = require('../../../server/utils/shareCrypto.js');

const KEY = server.generateShareKey();
const KEY_TEXT = server.toBase64Url(KEY);

test('readKeyFromHash accepts only a well-formed #k= fragment', () => {
  assert.equal(readKeyFromHash(`#k=${KEY_TEXT}`), KEY_TEXT);
  for (const bad of [
    '',
    '#',
    '#k=',
    `#k=${KEY_TEXT}x`,
    `#k=${KEY_TEXT.slice(1)}`,
    `#K=${KEY_TEXT}`,
    `#key=${KEY_TEXT}`,
    `#k=${KEY_TEXT}&x=1`,
    `k=${KEY_TEXT}`,
    `#k=${KEY_TEXT}%0a`,
    '#k=<script>alert(1)</script>',
    null,
    undefined,
    42,
  ]) {
    assert.equal(readKeyFromHash(bad), null, String(bad));
  }
});

test('the browser decrypts what the server encrypts, and only with the right key, share and slot', async () => {
  const plain = crypto.randomBytes(5000);
  const blob = server.pack(server.encryptForShare(plain, KEY, 'share-1', 'file-1'));
  const key = await importShareKey(KEY_TEXT);

  const out = await decryptBlob(key, 'share-1', 'file-1', new Uint8Array(blob));
  assert.ok(Buffer.from(out).equals(plain));

  await assert.rejects(decryptBlob(await importShareKey(server.toBase64Url(server.generateShareKey())), 'share-1', 'file-1', blob), 'wrong key');
  await assert.rejects(decryptBlob(key, 'share-2', 'file-1', blob), 'wrong share id');
  await assert.rejects(decryptBlob(key, 'share-1', 'file-2', blob), 'wrong slot');
  const tampered = new Uint8Array(blob);
  tampered[30] ^= 1;
  await assert.rejects(decryptBlob(key, 'share-1', 'file-1', tampered), 'tampered');
  await assert.rejects(decryptBlob(key, 'share-1', 'file-1', new Uint8Array(5)), 'too short');
});

test('the manifest is reduced to plain strings and numbers', async () => {
  const manifest = {
    v: 1,
    files: [{ id: 'a1', name: '<img src=x onerror=alert(1)>.html', mime: 'text/html', folder: 'Taxes/2024', size: 12, extra: { __proto__: 'x' } }],
  };
  const blob = server.pack(server.encryptForShare(Buffer.from(JSON.stringify(manifest)), KEY, 'sid', 'manifest'));
  const files = await decryptManifest(await importShareKey(KEY_TEXT), 'sid', blob.toString('base64'));
  assert.deepEqual(files, [{ id: 'a1', name: '<img src=x onerror=alert(1)>.html', mime: 'text/html', folder: 'Taxes/2024', size: 12 }]);

  const wrong = server.pack(server.encryptForShare(Buffer.from('{"v":3,"files":[]}'), KEY, 'sid', 'manifest'));
  await assert.rejects(decryptManifest(await importShareKey(KEY_TEXT), 'sid', wrong.toString('base64')));
});

test('only real png, jpeg, gif, webp and pdf bytes are previewable; html and svg never are', () => {
  const bytes = (...list) => new Uint8Array([...list, ...new Array(16).fill(0)]);
  assert.equal(previewKind('image/png', bytes(0x89, 0x50, 0x4e, 0x47)), 'image');
  assert.equal(previewKind('image/jpeg', bytes(0xff, 0xd8, 0xff)), 'image');
  assert.equal(previewKind('image/gif', bytes(0x47, 0x49, 0x46, 0x38)), 'image');
  assert.equal(previewKind('application/pdf', bytes(0x25, 0x50, 0x44, 0x46)), 'pdf');
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
  assert.equal(previewKind('image/webp', webp), 'image');
  assert.equal(previewKind('image/webp', bytes(0x52, 0x49, 0x46, 0x46)), null, 'RIFF but not WEBP');

  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  assert.equal(previewKind('image/png', html), null, 'labelled png, actually html');
  assert.equal(previewKind('text/html', html), null);
  assert.equal(previewKind('image/svg+xml', new TextEncoder().encode('<svg onload="alert(1)"/>')), null);
  assert.equal(previewKind('application/javascript', html), null);
  assert.equal(previewKind(undefined, html), null);
});

test('download names cannot carry paths or control characters', () => {
  assert.equal(safeDownloadName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeDownloadName('a/b\\c:d.txt'), 'a_b_c_d.txt');
  assert.equal(safeDownloadName('line\r\nbreak.txt'), 'line__break.txt');
  assert.equal(safeDownloadName('   '), 'file');
  assert.equal(safeDownloadName('.env'), '.env', 'a dotfile keeps its leading dot');
  assert.equal(safeDownloadName('..'), 'file');
  assert.equal(safeDownloadName('x'.repeat(500)).length, 120);
});

test('the CSP script hash in vercel.json matches the inline script in index.html', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const html = readFileSync(`${root}client/index.html`, 'utf8').replace(/\r\n/g, '\n');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = `sha256-${crypto.createHash('sha256').update(inline).digest('base64')}`;
  const config = JSON.parse(readFileSync(`${root}vercel.json`, 'utf8'));
  const rule = config.headers.find((entry) => entry.source === '/shared/(.*)');
  const csp = rule.headers.find((header) => header.key === 'Content-Security-Policy').value;
  assert.ok(csp.includes(`'${hash}'`), 'update the hash in vercel.json after editing the inline script in index.html');
  assert.ok(rule.headers.some((h) => h.key === 'Referrer-Policy' && h.value === 'no-referrer'));
  assert.doesNotMatch(csp, /'unsafe-inline'[^;]*;?\s*(?=.*script-src)/, 'no unsafe-inline for scripts');
  assert.match(csp, /script-src 'self' 'sha256-[^']+';/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the viewer never sends the key anywhere and removes it from the address bar', () => {
  const source = readFileSync(fileURLToPath(new URL('../pages/SharedDocumentPage.jsx', import.meta.url)), 'utf8');
  const service = readFileSync(fileURLToPath(new URL('../services/sharedService.js', import.meta.url)), 'utf8');
  assert.match(source, /history\.replaceState/);
  // The key text is only ever handed to importShareKey, never to a request.
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /fetchShared\w+\([^)]*keyText/);
  assert.doesNotMatch(service, /keyText|location\.hash|#k=/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|\.insertAdjacentHTML/);
});

test('a v2 manifest carries the purpose and the day; a v1 one has none; hostile text is cleaned and cut', async () => {
  const seal = (manifest) => server.pack(server.encryptForShare(Buffer.from(JSON.stringify(manifest)), KEY, 'sid', 'manifest')).toString('base64');
  const key = await importShareKey(KEY_TEXT);
  const files = [{ id: 'a1', name: 'p.png', mime: 'image/png', folder: 'root', size: 3 }];

  const v2 = await decryptManifestInfo(key, 'sid', seal({ v: 2, sharedAt: '2026-10-09', purpose: 'For BDO account opening', files }));
  assert.equal(v2.purpose, 'For BDO account opening');
  assert.equal(v2.sharedAt, '2026-10-09');
  assert.equal(v2.files.length, 1);

  const v1 = await decryptManifestInfo(key, 'sid', seal({ v: 1, files }));
  assert.deepEqual({ purpose: v1.purpose, sharedAt: v1.sharedAt }, { purpose: null, sharedAt: '' });
  assert.equal((await decryptManifest(key, 'sid', seal({ v: 2, purpose: 'x', files }))).length, 1, 'the plain reader still works');

  const hostile = await decryptManifestInfo(key, 'sid', seal({ v: 2, sharedAt: 'not a date', purpose: '  a\u202eb\n' + 'c'.repeat(100) + '  ', files }));
  assert.equal([...hostile.purpose].length, 60);
  assert.ok(!/[\u202e\n]/.test(hostile.purpose));
  assert.equal(hostile.sharedAt, '');
  const empty = await decryptManifestInfo(key, 'sid', seal({ v: 2, purpose: '   ', files }));
  assert.equal(empty.purpose, null, 'blank means no watermark');
  const notText = await decryptManifestInfo(key, 'sid', seal({ v: 2, purpose: { a: 1 }, files }));
  assert.equal(notText.purpose, null);
});
