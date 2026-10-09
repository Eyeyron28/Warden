import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';

import { IMPORT_LIMITS, inspectZip, looksLikeZipBomb, runImport, safeZipPath } from './zipImport.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const enc = (text) => new TextEncoder().encode(text);

async function makeZip(entries, options = {}) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) {
    if (name.endsWith('/')) zip.file(name, '', { dir: true });
    else zip.file(name, value, { createFolders: false });
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', ...options }));
}

test('paths: ".." segments, absolute paths, drive letters, NUL and backslash tricks are unsafe; junk is dropped', () => {
  for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', '\\windows\\system32', 'C:\\x.txt', 'c:/x.txt', 'a\\..\\..\\b.txt', 'a/b\0c.txt', '..\\..\\x', '']) {
    assert.deepEqual(safeZipPath(bad), { unsafe: true }, JSON.stringify(bad));
  }
  assert.deepEqual(safeZipPath('__MACOSX/a/._b.txt'), { junk: true });
  assert.deepEqual(safeZipPath('docs/.DS_Store'), { junk: true });
  assert.deepEqual(safeZipPath('./'), { junk: true });
  assert.deepEqual(safeZipPath('a/./b/c.txt'), { segments: ['a', 'b', 'c.txt'], isDir: false });
  assert.deepEqual(safeZipPath('folder/'), { segments: ['folder'], isDir: true });
  assert.deepEqual(safeZipPath('Résumé/履歴.txt'), { segments: ['Résumé', '履歴.txt'], isDir: false });
});

test('a normal zip is understood: files, folders (also empty ones), duplicate names renamed', async () => {
  const bytes = await makeZip({ 'a.txt': 'one', 'Docs/': null, 'Docs/b.pdf': 'two', 'Docs/B.PDF': 'three', 'Empty/': null, 'Empty/Inner/': null, 'x/y/z.txt': 'deep', '__MACOSX/junk': 'x' });
  const plan = inspectZip(bytes);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((f) => `${f.dir}|${f.name}`).sort(), ['Docs|B (2).PDF', 'Docs|b.pdf', 'x/y|z.txt', '|a.txt'].sort());
  assert.deepEqual(plan.folders, ['Docs', 'Empty', 'x', 'Empty/Inner', 'x/y'].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)));
  assert.deepEqual(plan.ignored, []);
});

test('path traversal and absolute paths are ignored and listed, never planned', async () => {
  const bytes = await makeZip({ 'ok.txt': 'fine', '../escape.txt': 'bad', 'a/../../escape2.txt': 'bad', '/abs.txt': 'bad', 'C:\\win.txt': 'bad', 'good/../../nested.txt': 'bad' });
  const plan = inspectZip(bytes);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((f) => f.name), ['ok.txt']);
  assert.equal(plan.ignored.length, 5);
  assert.ok(plan.ignored.every((entry) => /Unsafe path/.test(entry.reason)));
  assert.ok(!plan.folders.some((p) => p.includes('..')));
});

test('too many entries is refused before anything is read', async () => {
  const entries = {};
  for (let i = 0; i <= IMPORT_LIMITS.maxEntries; i += 1) entries[`f${i}.txt`] = '';
  const plan = inspectZip(await makeZip(entries));
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'too-many-entries');
});

test('a decompression bomb (tiny file, enormous expansion) is refused from the directory alone', async () => {
  const bomb = await makeZip({ 'zeros.bin': new Uint8Array(8 * 1024 * 1024) }, { compressionOptions: { level: 9 } });
  assert.ok(bomb.length < 100 * 1024, `the zip itself is small (${bomb.length} bytes)`);
  const plan = inspectZip(bomb);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'suspicious-compression');
});

test('too much declared data in total is refused (limits can be tightened for the check)', async () => {
  const bytes = await makeZip({ 'a.bin': crypto.randomBytes(50_000), 'b.bin': crypto.randomBytes(50_000) });
  const plan = inspectZip(bytes, { ...IMPORT_LIMITS, maxTotalBytes: 60_000 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'too-big-uncompressed');
});

test('not a zip, truncated, empty and oversized inputs are refused, not crashed on', async () => {
  for (const junk of [new Uint8Array(0), enc('hello'), crypto.randomBytes(5000), (await makeZip({ 'a.txt': 'x' })).subarray(0, 30)]) {
    const plan = inspectZip(junk);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'not-a-zip');
  }
  assert.equal(inspectZip('nope').ok, false);
  assert.equal(inspectZip(new Uint8Array(10), { ...IMPORT_LIMITS, maxArchiveBytes: 5 }).reason, 'too-big');
});

test('very deep nesting is ignored; files over 4 MB are skipped with a reason', async () => {
  const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
  const bytes = await makeZip({ [`${deep}/x.txt`]: 'x', 'ok.txt': 'y', 'big.bin': crypto.randomBytes(5 * 1024 * 1024) });
  const plan = inspectZip(bytes);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((f) => f.name), ['ok.txt']);
  assert.equal(plan.ignored.length, 1);
  assert.match(plan.skipped[0].reason, /4 MB/);
});

test('an import uploads through the normal path with the right folders and the exact bytes', async () => {
  const contents = { 'a.txt': enc('alpha'), 'Docs/b.pdf': crypto.randomBytes(3000), 'Résumé/履歴.txt': enc('名前'), 'x/y/z.bin': crypto.randomBytes(40_000) };
  const bytes = await makeZip({ ...contents, 'Empty/': null, 'Empty/Inner/': null });
  const plan = inspectZip(bytes);
  const uploaded = [];
  const created = [];
  const result = await runImport({
    bytes,
    plan,
    JSZip,
    uploadFile: async (file, folder) => uploaded.push({ name: file.name, folder, bytes: new Uint8Array(await file.arrayBuffer()) }),
    createFolder: async (path) => created.push(path),
  });
  assert.equal(result.uploaded, 4);
  assert.deepEqual(result.failures, []);
  for (const [name, data] of Object.entries(contents)) {
    const parts = name.split('/');
    const file = uploaded.find((u) => u.name === parts.at(-1) && u.folder === parts.slice(0, -1).join('/'));
    assert.ok(file, name);
    assert.equal(sha(file.bytes), sha(data), name);
  }
  assert.deepEqual(created.sort(), ['Empty', 'Empty/Inner'], 'only the empty folders are created; the others come with their files');
});

test('the storage limit stops the import and says so; other failures are listed, never silent', async () => {
  const bytes = await makeZip({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' });
  const plan = inspectZip(bytes);
  let calls = 0;
  const result = await runImport({
    bytes,
    plan,
    JSZip,
    concurrency: 1,
    uploadFile: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('full'), { response: { status: 413, data: { error: { code: 'STORAGE_QUOTA' } } } });
    },
    createFolder: async () => {},
  });
  assert.equal(result.uploaded, 1);
  assert.equal(result.quotaHit, true);
  assert.equal(calls, 2, 'nothing is tried after the quota is hit');
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every((f) => /storage is full/i.test(f.reason)));

  // an ordinary rejection (type or size) is one listed failure; the rest carry on
  const other = await runImport({
    bytes,
    plan,
    JSZip,
    uploadFile: async (file) => {
      if (file.name === 'b.txt') throw Object.assign(new Error('bad'), { response: { status: 400, data: { error: { message: 'Not allowed.' } } } });
    },
    createFolder: async () => {},
  });
  assert.equal(other.uploaded, 3);
  assert.deepEqual(other.failures, [{ path: 'b.txt', reason: 'Not allowed.' }]);
});

test('cancel stops uploading', async () => {
  const entries = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `file ${i}`]));
  const bytes = await makeZip(entries);
  const controller = new AbortController();
  let calls = 0;
  const result = await runImport({
    bytes,
    plan: inspectZip(bytes),
    JSZip,
    signal: controller.signal,
    uploadFile: async () => {
      calls += 1;
      const mine = calls;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (mine === 3) controller.abort();
    },
    createFolder: async () => {},
  });
  assert.equal(result.cancelled, true);
  assert.ok(calls < 12);
});

test('a zip inside the zip is never opened; one that looks like a bomb is skipped, an ordinary one is just a file', async () => {
  const bombInner = await makeZip({ 'zeros.bin': new Uint8Array(8 * 1024 * 1024) }, { compressionOptions: { level: 9 } });
  const harmlessInner = await makeZip({ 'readme.txt': 'hello' });
  assert.equal(looksLikeZipBomb(bombInner), true);
  assert.equal(looksLikeZipBomb(harmlessInner), false);
  assert.equal(looksLikeZipBomb(enc('not a zip')), false);

  const outer = await makeZip({ 'bomb.zip': bombInner, 'fine.zip': harmlessInner, 'note.txt': 'x' }, { compression: 'STORE' });
  const plan = inspectZip(outer);
  assert.equal(plan.ok, true, 'the outer zip is fine: its entries are small and stored plainly');
  const uploaded = [];
  const result = await runImport({ bytes: outer, plan, JSZip, uploadFile: async (file) => uploaded.push(file.name), createFolder: async () => {} });
  assert.deepEqual(uploaded.sort(), ['fine.zip', 'note.txt']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].path, 'bomb.zip');
  assert.match(result.failures[0].reason, /bomb/);
});
