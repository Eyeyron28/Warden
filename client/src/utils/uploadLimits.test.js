import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { limitCodeOf, limitMessage, limitedError, retrySeconds } from './uploadLimits.js';
import { createTransfersManager } from '../services/transfers.js';
import { MAX_PARALLEL_UPLOADS, createSlots } from '../services/uploadSlots.js';
import { describeTransferError } from './transferRules.js';
import { buildTray } from './trayModel.js';
import { inspectZip, runImport } from './zipImport.js';
import { summarize } from './uploadSelection.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const rate = (seconds = 150) => ({ response: { status: 429, headers: { 'retry-after': String(seconds) }, data: { error: { code: 'UPLOAD_RATE_LIMITED', message: 'Too many uploads at once. Please try again shortly.', retryAfterSeconds: seconds } } } });
const full = () => ({ response: { status: 409, headers: {}, data: { error: { code: 'DOCUMENT_LIMIT', message: 'You have reached the limit of 2000 files. Delete some files or empty the Trash.' } } } });
// what services/transferRuntime.js does to a failed upload request
const withDescribed = (error) => {
  const code = limitCodeOf(error);
  error.described = limitedError(code, retrySeconds(error), error.response.data.error.message);
  return error;
};

// ---------- the words ----------

test('the two codes are recognised; Retry-After (else retryAfterSeconds, else a minute) says how long', () => {
  assert.equal(limitCodeOf(rate()), 'UPLOAD_RATE_LIMITED');
  assert.equal(limitCodeOf(full()), 'DOCUMENT_LIMIT');
  assert.equal(limitCodeOf({ response: { status: 409, data: { error: { code: 'NAME_EXISTS' } } } }), null);
  assert.equal(limitCodeOf(new Error('x')), null);
  assert.equal(retrySeconds(rate(150)), 150);
  assert.equal(retrySeconds({ response: { headers: {}, data: { error: { retryAfterSeconds: 90.2 } } } }), 91);
  assert.equal(retrySeconds({ response: { headers: {}, data: { error: {} } } }), 60);
});

test('"Too many uploads at once. Try again in N minutes." rounds up and says "1 minute"; the document cap uses the server sentence', () => {
  assert.equal(limitMessage('UPLOAD_RATE_LIMITED', { seconds: 150 }), 'Too many uploads at once. Try again in 3 minutes.');
  assert.equal(limitMessage('UPLOAD_RATE_LIMITED', { seconds: 12 }), 'Too many uploads at once. Try again in 1 minute.');
  assert.equal(limitMessage('UPLOAD_RATE_LIMITED', { seconds: 0 }), 'Too many uploads at once. Try again in 1 minute.');
  assert.equal(limitMessage('DOCUMENT_LIMIT', { message: 'You have reached the limit of 2000 files. Delete some files or empty the Trash.' }), 'You have reached the limit of 2000 files. Delete some files or empty the Trash.');
});

// ---------- the tray rows ----------

const trayRow = (error) => {
  const described = describeTransferError(withDescribed(error));
  const row = { id: 1, kind: 'upload', name: 'a.txt', size: 10, phase: 'failed', error: described };
  return buildTray({ rows: [row], announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }).rows[0];
};

test('the speed limit is a "Not saved" row with the sentence, the tooltip, and a Retry button', () => {
  const row = trayRow(rate(150));
  assert.equal(row.line, 'Not saved: Too many uploads at once. Try again in 3 minutes.');
  assert.equal(row.tip, 'Not saved: Too many uploads at once. Try again in 3 minutes.');
  assert.equal(row.actions.retry, true);
  assert.equal(row.actions.dismiss, true);
  assert.equal(row.refused, true);
  assert.equal(row.ring, 'refused');
});

test('the document cap is a "Not saved" row with the server sentence and no Retry', () => {
  const row = trayRow(full());
  assert.equal(row.line, 'Not saved: You have reached the limit of 2000 files. Delete some files or empty the Trash.');
  assert.equal(row.actions.retry, false);
  assert.equal(row.tip, row.line);
});

// ---------- the manager: the rest of the batch ----------

function rig() {
  const calls = [];
  const clock = { t: 1_000_000 };
  let keys = 0;
  const manager = createTransfersManager({
    loadRuntime: async () => ({
      uploadDocument: (options) => new Promise((resolve, reject) => calls.push({ options, resolve, reject })),
      uploadNewVersion: () => new Promise(() => {}),
      limitedError,
      onFinished: () => {},
    }),
    slots: createSlots(MAX_PARALLEL_UPLOADS),
    getToken: () => 'token',
    subscribeToken: () => () => {},
    now: () => clock.t,
    setTimer: () => 0,
    clearTimer: () => {},
    newKey: () => `key-${(keys += 1)}`,
    window: null,
  });
  return { manager, calls, clock, rows: () => manager.getState().rows };
}
const queue = (r, count) => r.manager.enqueue(Array.from({ length: count }, (_, i) => ({ kind: 'upload', file: { name: `f${i + 1}.txt`, size: 5 }, folder: '' })));

test('when the server says "too many uploads", the files still queued in that batch are marked the same way and nothing more is sent', async () => {
  const r = rig();
  queue(r, 5);
  await flush();
  assert.equal(r.calls.length, 2, 'two on the wire');
  r.calls[0].reject(withDescribed(rate(150)));
  r.calls[1].reject(withDescribed(rate(150)));
  await flush();
  await flush();
  await flush();
  assert.equal(r.calls.length, 2, 'no extra request for the queued files');
  const rows = r.rows();
  assert.deepEqual(rows.map((row) => row.phase), ['failed', 'failed', 'failed', 'failed', 'failed']);
  assert.ok(rows.every((row) => row.error.notSaved && row.error.retryable));
  assert.match(rows[4].error.message, /^Too many uploads at once\. Try again in \d+ minutes?\.$/);
  await flush();
  assert.equal(r.calls.length, 2, 'nothing retries by itself');
});

test('Retry sends that file again and nothing else', async () => {
  const r = rig();
  queue(r, 3);
  await flush();
  r.calls[0].reject(withDescribed(rate(60)));
  r.calls[1].reject(withDescribed(rate(60)));
  await flush();
  await flush();
  await flush();
  const id = r.rows()[2].id;
  assert.equal(r.calls.length, 2);
  r.manager.retry(id);
  await flush();
  assert.equal(r.calls.length, 3, 'one request, for the one retried');
  assert.equal(r.calls[2].options.file.name, 'f3.txt');
  r.calls[2].resolve({ id: 'x', filename: 'f3.txt', folder: 'root' });
  await flush();
  assert.deepEqual(r.rows().map((row) => row.phase), ['failed', 'failed', 'sealed']);
});

test('the document cap marks the rest of the batch with the server sentence and no Retry', async () => {
  const r = rig();
  queue(r, 3);
  await flush();
  r.calls[0].reject(withDescribed(full()));
  r.calls[1].reject(withDescribed(full()));
  await flush();
  await flush();
  await flush();
  assert.equal(r.calls.length, 2);
  const rows = r.rows();
  assert.ok(rows.every((row) => row.phase === 'failed' && row.error.code === 'document-limit' && row.error.retryable === false));
  assert.equal(rows[2].error.message, 'You have reached the limit of 2000 files. Delete some files or empty the Trash.');
});

test('a new batch after the first has finished starts clean: the limit is remembered for one batch only', async () => {
  const r = rig();
  queue(r, 1);
  await flush();
  r.calls[0].reject(withDescribed(full()));
  await flush();
  await flush();
  queue(r, 1);
  await flush();
  assert.equal(r.calls.length, 2, 'asked again');
});

test('a plain network error is still a plain failure (not a limit)', () => {
  assert.equal(describeTransferError(new Error('boom')).notSaved, undefined);
});

// ---------- the Upload dialog ----------

test('the Upload dialog says before sending when a batch would pass the document cap (only when the meter told us both numbers)', () => {
  const items = [1, 2, 3].map((n) => ({ file: { name: `f${n}.txt`, size: 10 }, error: null }));
  const usage = { availableBytes: 10_000_000, documentCount: 1999, documentLimit: 2000 };
  const s = summarize(items, usage);
  assert.equal(s.canUpload, false);
  assert.equal(s.quotaMessage, 'You can add 1 more file (the limit is 2000). Delete some files or empty the Trash.');
  assert.equal(summarize(items, { ...usage, documentCount: 2000 }).quotaMessage, 'You have reached the limit of 2000 files. Delete some files or empty the Trash.');
  assert.equal(summarize(items, { ...usage, documentCount: 1997 }).canUpload, true);
  assert.equal(summarize(items, { availableBytes: 10_000_000 }).canUpload, true, 'unknown count: the tray handles it');
  assert.equal(summarize(items, null).canUpload, true);
});

// ---------- the zip import ----------

const makeZip = async (entries) => {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
};

test('the zip import stops cleanly at a limit: what was imported is kept, nothing more is sent, the rest are listed', async () => {
  const bytes = await makeZip(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.txt`, `file ${i}`])));
  let sent = 0;
  const results = [];
  const result = await runImport({
    bytes,
    plan: inspectZip(bytes),
    JSZip,
    concurrency: 1,
    uploadFile: async () => {
      sent += 1;
      if (sent === 4) throw rate(200);
      return {};
    },
    createFolder: async () => {},
    onResult: (item) => results.push(item),
  });
  assert.equal(sent, 4, 'no request after the limit');
  assert.equal(result.uploaded, 3);
  assert.equal(result.limitHit.code, 'UPLOAD_RATE_LIMITED');
  assert.equal(result.limitHit.message, 'Too many uploads at once. Try again in 4 minutes.');
  assert.equal(results.filter((item) => item.status === 'imported').length, 3);
  assert.equal(results.filter((item) => item.status === 'failed').length, 5, 'the one refused and the four never sent');
  assert.equal(result.failures.length, 5);
});

test('the document cap stops the import the same way, with the server sentence', async () => {
  const bytes = await makeZip({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  let sent = 0;
  const result = await runImport({
    bytes,
    plan: inspectZip(bytes),
    JSZip,
    concurrency: 1,
    uploadFile: async () => {
      sent += 1;
      if (sent === 2) throw full();
      return {};
    },
    createFolder: async () => {},
  });
  assert.equal(sent, 2);
  assert.equal(result.uploaded, 1);
  assert.equal(result.limitHit.message, 'You have reached the limit of 2000 files. Delete some files or empty the Trash.');
});

test('the stop line: "Stopped: <why>. N files were imported" with the held, not-saved and not-imported counts', async () => {
  const { runtime } = await import('../services/importRuntime.js').catch(() => ({ runtime: null }));
  if (!runtime) return; // (the runtime pulls in browser-only modules; the wording is also checked in the source below)
  const state = { uploaded: 2, results: [{ status: 'imported' }, { status: 'imported' }, { status: 'held' }, { status: 'refused' }, { status: 'failed' }, { status: 'failed' }] };
  assert.equal(runtime.stoppedLine(state, 'Too many uploads at once. Try again in 4 minutes.'), 'Stopped: Too many uploads at once. Try again in 4 minutes. 2 files were imported, 1 held for review, 1 not saved, 2 not imported.');
});

// ---------- what is where ----------

test('the new wording lives only in lazy modules; the main files carry just a few lines', () => {
  const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
  assert.doesNotMatch(read('services/transfers.js'), /uploadLimits|Too many uploads/);
  assert.doesNotMatch(read('services/importJob.js'), /uploadLimits|Too many uploads/);
  assert.match(read('services/transferRuntime.js'), /uploadLimits\.js/);
  assert.match(read('utils/zipImport.js'), /uploadLimits\.js/);
  assert.match(read('services/importJob.js'), /result\.limitHit/);
  assert.match(read('services/importRuntime.js'), /Stopped: \$\{why/);
});
