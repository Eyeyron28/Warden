import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';

import { buildExportZip, exportFileName, planExport, planFolders, uniqueName, zipSegment } from './zipExport.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
const bytesOf = (text) => new TextEncoder().encode(text);
const doc = (id, filename, folder = 'root', size = 10) => ({ id, filename, folder, size, updatedAt: '2026-10-01T00:00:00Z' });

/** A fake vault: bytes by document id, with optional failures. */
function vault(contents, { fail = {}, delay = 0 } = {}) {
  let active = 0;
  const stats = { maxActive: 0, calls: [] };
  return {
    stats,
    fetchBytes: async (id, { signal } = {}) => {
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      stats.calls.push(id);
      try {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (signal?.aborted) throw new Error('aborted');
        if (fail[id]) throw Object.assign(new Error('boom'), { response: { status: fail[id] } });
        return { bytes: contents[id], filename: 'ignored' };
      } finally {
        active -= 1;
      }
    },
  };
}

async function unzip(blob) {
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) files[name] = entry.dir ? null : await entry.async('uint8array');
  return files;
}

test('names: safe segments, unique siblings (case-insensitive) that keep the extension', () => {
  assert.equal(zipSegment('a/b:c*?.pdf'), 'a_b_c__.pdf');
  assert.equal(zipSegment('..'), 'file');
  assert.equal(zipSegment('.'), 'file');
  assert.equal(zipSegment('   '), 'file');
  const used = new Set();
  assert.deepEqual(['a.pdf', 'A.PDF', 'a.pdf', 'notes', 'notes', 'b.tar.gz', 'b.tar.gz'].map((n) => uniqueName(n, used)), ['a.pdf', 'A (2).PDF', 'a (3).pdf', 'notes', 'notes (2)', 'b.tar.gz', 'b.tar (2).gz']);
  assert.equal(exportFileName(new Date(2026, 9, 9)), 'warden-export-2026-10-09.zip');
  assert.match(exportFileName(), /^warden-export-\d{4}-\d{2}-\d{2}\.zip$/);
});

test('folders: parents first, hostile names sanitised, siblings kept distinct, "root" is the top', () => {
  const map = planFolders(['root', 'Taxes/2024', 'Taxes', 'a:b', 'a_b', 'Empty/Deeper', 'x/../y']);
  assert.equal(map.get(''), '');
  assert.equal(map.get('Taxes'), 'Taxes');
  assert.equal(map.get('Taxes/2024'), 'Taxes/2024');
  assert.equal(map.get('Empty/Deeper'), 'Empty/Deeper');
  assert.notEqual(map.get('a:b'), map.get('a_b'), 'different folders never merge');
  for (const zipPath of map.values()) assert.ok(!zipPath.split('/').includes('..'), zipPath);
});

test('the export has the vault structure, original names, empty folders, and the exact bytes', async () => {
  const contents = {
    1: bytesOf('top level'),
    2: bytesOf('tax return'),
    3: PDF, // stored without an extension: recovered from its bytes, like a download
    4: bytesOf('Résumé'),
    5: bytesOf('first'),
    6: bytesOf('second'),
    7: bytesOf('third'),
  };
  const documents = [
    doc(1, 'readme.txt'),
    doc(2, 'return.pdf', 'Taxes/2024'),
    doc(3, 'mod12', 'School'),
    doc(4, 'Résumé 履歴.txt', 'Taxes'),
    doc(5, 'same.txt', 'Dupes'),
    doc(6, 'same.txt', 'Dupes'),
    doc(7, 'SAME.TXT', 'Dupes'),
  ];
  const { fetchBytes } = vault(contents);
  const result = await buildExportZip({ documents, folderPaths: ['root', 'Taxes', 'Taxes/2024', 'School', 'Dupes', 'Empty folder', 'Empty folder/Inner'], fetchBytes, JSZip });
  assert.equal(result.cancelled, false);
  assert.equal(result.added, 7);
  assert.deepEqual(result.failures, []);

  const files = await unzip(result.blob);
  const names = Object.keys(files).sort();
  assert.deepEqual(names, [
    'Dupes/', 'Dupes/SAME (3).TXT', 'Dupes/same (2).txt', 'Dupes/same.txt',
    'Empty folder/', 'Empty folder/Inner/',
    'School/', 'School/mod12.pdf',
    'Taxes/', 'Taxes/2024/', 'Taxes/2024/return.pdf', 'Taxes/Résumé 履歴.txt',
    'readme.txt',
  ].sort());
  assert.equal(sha(files['readme.txt']), sha(contents[1]));
  assert.equal(sha(files['Taxes/2024/return.pdf']), sha(contents[2]));
  assert.equal(sha(files['School/mod12.pdf']), sha(PDF));
  assert.equal(sha(files['Taxes/Résumé 履歴.txt']), sha(contents[4]));
  assert.deepEqual([files['Dupes/same.txt'], files['Dupes/same (2).txt'], files['Dupes/SAME (3).TXT']].map((b) => new TextDecoder().decode(b)), ['first', 'second', 'third']);
  assert.ok(!names.includes('warden-export-report.txt'), 'no report when nothing failed');
});

test('at most two files are fetched at a time, each only once', async () => {
  const contents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, bytesOf(`file ${i}`)]));
  const documents = Array.from({ length: 9 }, (_, i) => doc(i + 1, `f${i}.txt`));
  const v = vault(contents, { delay: 15 });
  const result = await buildExportZip({ documents, folderPaths: [], fetchBytes: v.fetchBytes, JSZip });
  assert.equal(result.added, 9);
  assert.equal(v.stats.maxActive, 2);
  assert.deepEqual(v.stats.calls.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a file that fails is skipped and LISTED - in the result and in a report inside the zip', async () => {
  const contents = { 1: bytesOf('ok'), 2: bytesOf('nope'), 3: bytesOf('also ok') };
  const v = vault(contents, { fail: { 2: 500 } });
  const documents = [doc(1, 'a.txt'), doc(2, 'broken.txt', 'Docs'), doc(3, 'c.txt', 'Docs')];
  const result = await buildExportZip({ documents, folderPaths: ['Docs'], fetchBytes: v.fetchBytes, JSZip });
  assert.equal(result.added, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].path, 'Docs/broken.txt');
  assert.match(result.failures[0].reason, /500/);
  const files = await unzip(result.blob);
  assert.ok(files['a.txt'] && files['Docs/c.txt']);
  assert.ok(!files['Docs/broken.txt']);
  assert.match(new TextDecoder().decode(files['warden-export-report.txt']), /Docs\/broken\.txt/);
});

test('a file over 4 MB is not fetched and is listed; progress reports every file and the bytes', async () => {
  const contents = { 1: bytesOf('small') };
  const v = vault(contents);
  const events = [];
  const result = await buildExportZip({
    documents: [doc(1, 'small.txt'), doc(2, 'huge.bin', 'root', 5 * 1024 * 1024)],
    folderPaths: [],
    fetchBytes: v.fetchBytes,
    JSZip,
    onProgress: (p) => events.push(p),
  });
  assert.deepEqual(v.stats.calls, [1]);
  assert.equal(result.failures[0].path, 'huge.bin');
  assert.match(result.failures[0].reason, /4 MB/);
  const last = events.filter((e) => e.phase === 'downloading').at(-1);
  assert.deepEqual([last.done, last.total, last.bytes], [2, 2, 5]);
  assert.ok(events.some((e) => e.phase === 'zipping'));
});

test('cancel stops the work and produces no zip', async () => {
  const contents = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, bytesOf(`file ${i}`)]));
  const documents = Array.from({ length: 20 }, (_, i) => doc(i + 1, `f${i}.txt`));
  const v = vault(contents, { delay: 10 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 35);
  const result = await buildExportZip({ documents, folderPaths: [], fetchBytes: v.fetchBytes, JSZip, signal: controller.signal });
  assert.deepEqual(result, { cancelled: true });
  assert.ok(v.stats.calls.length < 20, `stopped early (${v.stats.calls.length} of 20 fetched)`);
});

test('the plan excludes nothing silently: oversized files are reported, everything else is placed', () => {
  const plan = planExport([doc(1, 'a.txt', 'A/B'), doc(2, 'big', 'root', 9e6)], ['A']);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].dir, 'A/B');
  assert.deepEqual(plan.tooLarge.map((d) => d.id), [2]);
});
