import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTransfersManager, STOP_SEALING_PROMPT } from './transfers.js';
import { MAX_PARALLEL_UPLOADS, createSlots } from './uploadSlots.js';
import { describeTransferError, validateUpload } from '../utils/transferRules.js';
import { buildTray, RING } from '../utils/trayModel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

const file = (name, size = 1000) => ({ name, size });

function rig({ token = 'token-A', importStatus = 'idle' } = {}) {
  const calls = [];
  const timers = [];
  const clock = { t: 1_000_000 };
  const tokenListeners = new Set();
  const finished = [];
  const events = { added: [], removed: [] };
  const session = { token };
  const imp = { status: importStatus, cleared: 0 };
  let keys = 0;
  const manager = createTransfersManager({
    loadRuntime: async () => ({
      uploadDocument: (options, onProgress) => new Promise((resolve, reject) => calls.push({ kind: 'upload', options, onProgress, resolve, reject, signal: options.signal })),
      uploadNewVersion: (id, f, onProgress, { signal }) => new Promise((resolve, reject) => calls.push({ kind: 'newVersion', id, f, onProgress, resolve, reject, signal })),
      onFinished: (info) => finished.push(info),
    }),
    slots: createSlots(MAX_PARALLEL_UPLOADS),
    getToken: () => session.token,
    subscribeToken: (listener) => { tokenListeners.add(listener); return () => tokenListeners.delete(listener); },
    importState: () => ({ status: imp.status }),
    clearImport: () => { imp.cleared += 1; imp.status = 'idle'; },
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    newKey: () => `key-${(keys += 1)}`,
    window: { addEventListener: (type, fn) => events.added.push({ type, fn }), removeEventListener: (type, fn) => events.removed.push({ type, fn }) },
  });
  const changes = [];
  manager.subscribe(() => changes.push(manager.getState()));
  const signIn = (next) => { session.token = next; tokenListeners.forEach((listener) => listener(next)); };
  const fire = () => timers.splice(0).filter((timer) => !timer.cancelled).forEach((timer) => timer.fn());
  const rows = () => manager.getState().rows;
  const phases = () => rows().map((row) => row.phase);
  const saved = (name, extra = {}) => ({ id: `id-${name}`, filename: name, folder: 'root', nameChanged: false, ...extra });
  return { manager, calls, timers, clock, finished, events, session, imp, changes, signIn, fire, rows, phases, saved };
}

// ---------- the queue ----------

test('at most 2 files travel at once; the rest wait in order and start as places free up', async () => {
  const r = rig();
  r.manager.enqueue([1, 2, 3, 4].map((n) => ({ kind: 'upload', file: file(`f${n}.txt`), folder: '' })));
  await flush();
  assert.deepEqual(r.phases(), ['sending', 'sending', 'waiting', 'waiting']);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map((c) => c.options.file.name), ['f1.txt', 'f2.txt'], 'first come, first served');
  r.calls[1].resolve(r.saved('f2.txt'));
  await flush();
  assert.deepEqual(r.phases(), ['sending', 'sealed', 'sending', 'waiting']);
  assert.equal(r.calls[2].options.file.name, 'f3.txt');
  r.calls[0].resolve(r.saved('f1.txt'));
  await flush();
  assert.equal(r.calls[3].options.file.name, 'f4.txt');
  assert.equal(r.calls.length, 4);
});

test('the zip import shares the same two places: with two files of the import on the wire, a new upload waits', async () => {
  const slots = createSlots(2);
  await slots.acquire();
  await slots.acquire();
  assert.deepEqual(slots.stats(), { free: 0, waiting: 0, max: 2 });
  let got = false;
  const third = slots.acquire().then(() => { got = true; });
  await flush();
  assert.equal(got, false);
  slots.release();
  await third;
  assert.equal(got, true);
  // an aborted waiter leaves the line and never takes a place
  const ctl = new AbortController();
  const waiting = slots.acquire(ctl.signal);
  ctl.abort();
  await assert.rejects(waiting, /Canceled/);
  assert.equal(slots.stats().waiting, 0);
  assert.match(strip(read('services/importRuntime.js')), /await uploadSlots\.acquire\(\);[\s\S]*uploadSlots\.release\(\)/);
});

// ---------- the phases ----------

test('waiting, sending (bytes), sealing (all bytes sent), sealed - with the destination and a changed name', async () => {
  const r = rig();
  const [id] = r.manager.enqueue([{ kind: 'upload', file: file('report.pdf', 2000), folder: 'Taxes' }]);
  assert.equal(r.rows()[0].phase, 'waiting', 'before a place is free');
  await flush();
  assert.equal(r.rows()[0].phase, 'sending');
  r.clock.t += 300;
  r.calls[0].onProgress(50);
  assert.equal(r.rows()[0].bytesDone, 1000);
  assert.equal(r.rows()[0].phase, 'sending');
  r.calls[0].onProgress(100);
  assert.equal(r.rows()[0].phase, 'sealing', 'all bytes are sent: the server is encrypting and saving');
  assert.equal(r.rows()[0].bytesDone, 2000);
  r.calls[0].resolve(r.saved('report (1).pdf', { folder: 'Taxes', nameChanged: true }));
  await flush();
  const row = r.rows()[0];
  assert.equal(row.phase, 'sealed');
  assert.equal(row.state, 'done');
  assert.equal(row.resultId, 'id-report (1).pdf');
  assert.equal(row.destination, 'Taxes');
  assert.equal(row.savedAs, 'report (1).pdf');
  assert.equal(row.id, id);
  assert.equal(r.calls[0].options.folder, 'Taxes');
  assert.equal(r.calls[0].options.uploadKey, 'key-1');
});

test('screen updates are throttled to every 250 ms; the step into sealing is never held back', async () => {
  const r = rig();
  r.manager.enqueue([{ kind: 'upload', file: file('big.bin', 4000), folder: '' }]);
  await flush();
  const before = r.changes.length;
  for (let p = 1; p <= 99; p += 1) r.calls[0].onProgress(p);
  assert.ok(r.changes.length - before <= 2, `${r.changes.length - before} renders for 99 progress events`);
  r.clock.t += 300;
  r.fire();
  assert.equal(r.rows()[0].bytesDone, 3960, 'the scheduled update carries the newest bytes');
  const mark = r.changes.length;
  r.calls[0].onProgress(100);
  assert.ok(r.changes.length > mark, 'sealing is shown at once');
  assert.equal(r.rows()[0].phase, 'sealing');
});

// ---------- cancel ----------

test('Cancel: a waiting file leaves the queue and is never sent; a sending one is aborted and nothing was saved', async () => {
  const r = rig();
  const [a, b, c] = r.manager.enqueue(['a', 'b', 'c'].map((n) => ({ kind: 'upload', file: file(`${n}.txt`), folder: '' })));
  await flush();
  r.manager.cancel(c);
  await flush();
  assert.equal(r.rows()[2].phase, 'canceled');
  assert.equal(r.calls.length, 2, 'the third was never sent');
  r.calls[0].onProgress(40);
  r.manager.cancel(a);
  assert.equal(r.calls[0].signal.aborted, true);
  r.calls[0].reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
  await flush();
  const first = r.rows()[0];
  assert.equal(first.phase, 'canceled');
  assert.equal(first.error.message, 'Canceled. Nothing was saved.');
  assert.ok(!first.error.maybeSaved);
  assert.equal(first.error.retryable, false);
  r.calls[1].resolve(r.saved('b.txt'));
  await flush();
  assert.equal(r.rows()[1].phase, 'sealed');
  void b;
});

test('Cancel while sealing says the file MAY already be saved, and the lists are read again', async () => {
  const r = rig();
  const [id] = r.manager.enqueue([{ kind: 'upload', file: file('x.pdf'), folder: '' }]);
  await flush();
  r.calls[0].onProgress(100);
  assert.equal(r.rows()[0].phase, 'sealing');
  r.manager.cancel(id);
  r.calls[0].reject(new Error('aborted'));
  await flush();
  const row = r.rows()[0];
  assert.equal(row.phase, 'canceled');
  assert.match(row.error.message, /Canceled while sealing\. It may already be in your vault/);
  assert.equal(row.error.maybeSaved, true);
  assert.equal(r.finished.length, 1, 'the refresh runs even though it was canceled');
});

// ---------- failure and retry ----------

test('a failed upload keeps its file and offers Retry; the retry sends the SAME upload key and then seals once', async () => {
  const r = rig();
  const [id] = r.manager.enqueue([{ kind: 'upload', file: file('a.txt'), folder: 'Docs' }]);
  await flush();
  r.calls[0].reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
  await flush();
  assert.equal(r.rows()[0].phase, 'failed');
  assert.equal(r.rows()[0].error.message, 'Network error');
  assert.equal(r.rows()[0].error.retryable, true);
  assert.equal(r.finished.length, 1);
  r.manager.retry(id);
  assert.equal(r.rows()[0].phase, 'waiting');
  await flush();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].options.uploadKey, r.calls[0].options.uploadKey, 'the same key: a file the server already saved is answered, not duplicated');
  assert.equal(r.calls[1].options.uploadKey, 'key-1');
  r.calls[1].resolve(r.saved('a.txt', { replayed: true }));
  await flush();
  assert.equal(r.rows()[0].phase, 'sealed');
  assert.equal(r.finished.length, 2, 'one refresh per batch');
});

test('quota and size failures have no Retry; a server hiccup does', async () => {
  assert.deepEqual(describeTransferError({ response: { status: 413, data: { error: { code: 'STORAGE_QUOTA', message: 'Not enough storage: this needs 3.0 MB but only 1.0 MB of your 25 MB is free.' } } } }), { message: 'Over your 25 MB limit', code: 'quota', retryable: false });
  assert.equal(describeTransferError({ response: { status: 413, data: {} } }).retryable, false);
  assert.equal(describeTransferError({ response: { status: 413, data: {} } }).message, 'Over the 4 MB file limit');
  assert.equal(describeTransferError({ message: 'Network Error' }).retryable, true);
  assert.equal(describeTransferError({ response: { status: 503, data: {} } }).retryable, true);
  assert.equal(describeTransferError({ response: { status: 429, data: {} } }).retryable, true);
  const r = rig();
  const [id] = r.manager.enqueue([{ kind: 'upload', file: file('big.bin'), folder: '' }]);
  await flush();
  r.calls[0].reject(Object.assign(new Error('x'), { response: { status: 413, data: { error: { code: 'STORAGE_QUOTA', message: 'your 25 MB' } } } }));
  await flush();
  assert.equal(r.rows()[0].error.retryable, false);
  r.manager.retry(id);
  assert.equal(r.rows()[0].phase, 'failed', 'Retry does nothing for a quota failure');
  assert.equal(r.calls.length, 1);
});

test('Upload new version: sealed with the file as the current version; a retry whose first try had been saved is sealed too', async () => {
  const r = rig();
  const [id] = r.manager.enqueue([{ kind: 'newVersion', file: file('plan.txt', 500), documentId: 'doc1', destination: 'Plans' }]);
  await flush();
  assert.equal(r.calls[0].kind, 'newVersion');
  assert.equal(r.calls[0].id, 'doc1');
  r.calls[0].reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
  await flush();
  r.manager.retry(id);
  await flush();
  r.calls[1].reject(Object.assign(new Error('x'), { response: { status: 409, data: { error: { code: 'VERSION_IDENTICAL', message: 'identical' } } } }));
  await flush();
  assert.equal(r.rows()[0].phase, 'sealed');
  assert.deepEqual(r.finished.at(-1).replacedIds, ['doc1']);
});

// ---------- the checks before the dialog closes ----------

test('the 4 MB cap, the room left in the account and the name rules are checked before anything is queued', () => {
  const usage = { availableBytes: 3 * 1024 * 1024 };
  assert.deepEqual(validateUpload(file('ok.pdf', 1000), { usage }), { ok: true });
  const big = validateUpload(file('big.pdf', 4 * 1024 * 1024 + 1), { usage });
  assert.equal(big.ok, false);
  assert.equal(big.code, 'size');
  assert.match(big.reason, /at most 4 MB/);
  assert.equal(validateUpload(file('four.pdf', 4 * 1024 * 1024), { usage: { availableBytes: 10 * 1024 * 1024 } }).ok, true, 'exactly the cap is allowed');
  const quota = validateUpload(file('x.bin', 2 * 1024 * 1024), { usage, pendingBytes: 2 * 1024 * 1024 });
  assert.equal(quota.code, 'quota', 'what the same batch already claimed counts');
  assert.match(quota.reason, /Not enough storage/);
  assert.equal(validateUpload(file('x.bin', 10), { usage: { availableBytes: 10 } }).ok, true);
  assert.equal(validateUpload(file('   ', 5), {}).code, 'name');
  assert.equal(validateUpload(file('a'.repeat(256), 5), {}).code, 'name');
  assert.equal(validateUpload(file('a'.repeat(255), 5), {}).ok, true);
  assert.equal(validateUpload(file('é'.repeat(255), 5), {}).ok, true, 'characters, not bytes');
  assert.equal(validateUpload(file('ok.txt', 5), { usage: null }).ok, true, 'no meter known: the server decides');
});

// ---------- the session ----------

test('signing out, locking, an expiry or another account cancels every transfer and wipes the names', async () => {
  const r = rig();
  r.manager.enqueue([{ kind: 'upload', file: file('secret-name.pdf'), folder: '' }, { kind: 'upload', file: file('second.pdf'), folder: '' }, { kind: 'upload', file: file('third.pdf'), folder: '' }]);
  await flush();
  r.signIn(null);
  assert.equal(r.calls[0].signal.aborted, true);
  assert.equal(r.calls[1].signal.aborted, true);
  assert.deepEqual(r.rows(), []);
  assert.equal(JSON.stringify(r.manager.getState()).includes('secret-name'), false);
  assert.equal(r.events.removed.filter((e) => e.type === 'beforeunload').length >= 1, true);
  r.calls[0].reject(new Error('aborted'));
  await flush();
  assert.deepEqual(r.rows(), [], 'nothing comes back after the clear');

  const s = rig();
  s.manager.enqueue([{ kind: 'upload', file: file('a.txt'), folder: '' }]);
  await flush();
  s.signIn('token-A');
  assert.equal(s.rows().length, 1, 'the same session: nothing happens');
  s.signIn('token-B');
  assert.deepEqual(s.rows(), [], 'another account');
});

test('Lock vault with files being sealed asks first; "keep going" changes nothing; "stop and sign out" cancels, clears, then signs out', async () => {
  const r = rig();
  let signedOut = 0;
  assert.equal(await r.manager.requestSignOut(async () => { signedOut += 1; }), true);
  assert.equal(signedOut, 1, 'nothing running: just runs');
  r.manager.enqueue([{ kind: 'upload', file: file('a.txt'), folder: '' }]);
  await flush();
  const pending = r.manager.requestSignOut(async () => { signedOut += 1; });
  assert.match(r.manager.getState().signOutPrompt.text, /Files are still being sealed/);
  await r.manager.answerSignOut(false);
  assert.equal(await pending, false);
  assert.equal(signedOut, 1);
  assert.equal(r.rows()[0].phase, 'sending');
  const again = r.manager.requestSignOut(async () => { signedOut += 1; });
  await r.manager.answerSignOut(true);
  assert.equal(await again, true);
  assert.equal(signedOut, 2);
  assert.deepEqual(r.rows(), []);
  assert.equal(r.imp.cleared, 1);
  // an import running counts too, with its own words
  const i = rig({ importStatus: 'running' });
  const asked = i.manager.requestSignOut(async () => {});
  assert.equal(i.manager.getState().signOutPrompt.text, 'An import is running. Stop it and sign out?');
  await i.manager.answerSignOut(false);
  await asked;
});

// ---------- batches, announcements, the tab ----------

test('one refresh per batch, not per file; the tab warns while anything is working; announcements at the start, each quarter and the end', async () => {
  const r = rig();
  r.manager.enqueue([1, 2, 3, 4].map((n) => ({ kind: 'upload', file: file(`f${n}.txt`, 1000), folder: '' })));
  await flush();
  assert.equal(r.events.added.filter((e) => e.type === 'beforeunload').length, 1);
  const heard = new Set([r.manager.getState().announce]);
  for (let n = 0; n < 4; n += 1) {
    r.calls[n].onProgress(100);
    r.calls[n].resolve(r.saved(`f${n + 1}.txt`));
    await flush();
    r.clock.t += 300;
    r.fire();
    heard.add(r.manager.getState().announce);
    if (n < 3) assert.equal(r.finished.length, 0, 'not yet: the batch is not over');
    if (n === 1) await flush();
  }
  assert.equal(r.finished.length, 1, 'exactly one refresh for four files');
  assert.equal(r.finished[0].sealed, 4);
  assert.equal(r.events.removed.filter((e) => e.type === 'beforeunload').length, 1, 'the warning is gone');
  const lines = [...heard].filter(Boolean);
  assert.ok(lines.includes('4 files sealed.'), lines.join(' | '));
  assert.ok(lines.length <= 6);
  // a second batch refreshes again
  r.manager.enqueue([{ kind: 'upload', file: file('later.txt'), folder: '' }]);
  await flush();
  r.calls.at(-1).resolve(r.saved('later.txt'));
  await flush();
  assert.equal(r.finished.length, 2);
});

test('Dismiss removes a finished row; a running one cannot be dismissed; dismissing all keeps what is still running', async () => {
  const r = rig();
  const [a, b] = r.manager.enqueue([{ kind: 'upload', file: file('a.txt'), folder: '' }, { kind: 'upload', file: file('b.txt'), folder: '' }]);
  await flush();
  r.manager.dismiss(a);
  assert.equal(r.rows().length, 2, 'it is still running');
  r.calls[0].resolve(r.saved('a.txt'));
  await flush();
  r.manager.dismissFinished();
  assert.deepEqual(r.rows().map((row) => row.id), [b]);
  r.manager.dismiss(b);
  assert.equal(r.rows().length, 1);
});

// ---------- the model and the tray ----------

const idleJob = { status: 'idle', cardVisible: false, results: [], skipped: [], ignored: [], announce: '' };
const row = (patch) => ({ id: 1, kind: 'upload', name: 'a.pdf', size: 1000, phase: 'sending', state: 'running', bytesDone: 500, error: null, destination: '', resultId: null, savedAs: null, ...patch });

test('the header says what is going on: "Sealing 2 files", "3 files sealed", "1 failed", "Sealed 2, 1 failed"', () => {
  const title = (rows, job = idleJob) => buildTray({ rows, announce: '' }, job).title;
  assert.equal(title([row({}), row({ id: 2, phase: 'waiting', bytesDone: 0 })]), 'Sealing 2 files');
  assert.equal(title([row({ phase: 'sealing', bytesDone: 1000 })]), 'Sealing 1 file');
  assert.equal(title([1, 2, 3].map((id) => row({ id, phase: 'sealed', bytesDone: 1000 }))), '3 files sealed');
  assert.equal(title([row({ phase: 'failed', error: { message: 'Network error', retryable: true } })]), '1 failed');
  assert.equal(title([row({ id: 1, phase: 'sealed' }), row({ id: 2, phase: 'sealed' }), row({ id: 3, phase: 'failed', error: { message: 'x' } })]), 'Sealed 2, 1 failed');
  assert.equal(title([row({ phase: 'canceled', error: { message: 'Canceled.' } })]), 'Canceled');
});

test('rows: waiting, sending in bytes, sealing, sealed with Show in folder, failed with Retry only when it can help, canceled', () => {
  const m = (r, job = idleJob) => buildTray({ rows: [r], announce: '' }, job).rows[0];
  assert.deepEqual([m(row({ phase: 'waiting', bytesDone: 0 })).line, m(row({ phase: 'waiting', bytesDone: 0 })).ring], ['Waiting', RING.IDLE]);
  const sending = m(row({ bytesDone: 500 }));
  assert.match(sending.line, /^Sending 500 B of 1000 B$/);
  assert.equal(sending.ring, RING.PROGRESS);
  assert.equal(sending.percent, 50);
  assert.equal(sending.actions.cancel, true);
  const sealing = m(row({ phase: 'sealing', bytesDone: 1000 }));
  assert.equal(sealing.ring, RING.PULSE);
  assert.match(sealing.line, /^Sealing/);
  const sealed = m(row({ phase: 'sealed', bytesDone: 1000, destination: 'Taxes' }));
  assert.equal(sealed.ring, RING.SEALED);
  assert.equal(sealed.actions.show, '/files?path=Taxes');
  assert.equal(m(row({ phase: 'sealed', savedAs: 'a (1).pdf' })).line, 'Sealed as "a (1).pdf"');
  const failed = m(row({ phase: 'failed', error: { message: 'Network error', retryable: true } }));
  assert.equal(failed.ring, RING.FAILED);
  assert.equal(failed.line, 'Network error');
  assert.equal(failed.actions.retry, true);
  assert.equal(m(row({ phase: 'failed', error: { message: 'Over your 25 MB limit', retryable: false } })).actions.retry, false);
  assert.equal(m(row({ phase: 'canceled', error: { message: 'Canceled while sealing. It may already be in your vault: the list is refreshed.', maybeSaved: true } })).warn, true);
});

test('the tray closes by itself only when nothing runs and nothing failed; a failure keeps it open; the import is one of the rows', () => {
  const t = (rows, job = idleJob) => buildTray({ rows, announce: '' }, job);
  assert.equal(t([row({ phase: 'sealed' })]).autoDismiss, true);
  assert.equal(t([row({})]).autoDismiss, false, 'still running');
  assert.equal(t([row({ phase: 'sealed' }), row({ id: 2, phase: 'failed', error: { message: 'x', retryable: true } })]).autoDismiss, false, 'a failure stays until dismissed');
  const job = { ...idleJob, status: 'running', phase: 'uploading', fileName: 'backup.zip', done: 12, total: 48, bytesTotal: 4800, bytesDone: 1200, cardVisible: true, destination: '', uploaded: 12, announce: '' };
  const running = t([], job);
  assert.equal(running.rows.length, 1);
  assert.equal(running.rows[0].name, 'backup.zip');
  assert.equal(running.rows[0].line, '12 of 48 files');
  assert.equal(running.rows[0].kind, 'import');
  assert.equal(running.title, 'Importing 48 files');
  assert.equal(running.running, true);
  const both = t([row({})], job);
  assert.equal(both.rows.length, 2, 'the import is a row in the same tray');
  assert.equal(both.rows.at(-1).source, 'import');
  const done = t([], { ...job, status: 'done', phase: 'finished', done: 48, uploaded: 48, finishedAt: 5 });
  assert.equal(done.rows[0].ring, RING.SEALED);
  assert.equal(done.title, '48 files sealed');
  assert.equal(done.autoDismiss, true);
  assert.equal(t([], { ...job, status: 'failed', phase: 'finished', message: 'The zip is broken.' }).autoDismiss, false);
});

test('the overall progress counts bytes: sealed rows in full, canceled rows not at all', () => {
  const t = (rows) => buildTray({ rows, announce: '' }, idleJob);
  assert.equal(t([row({ size: 1000, bytesDone: 500 }), row({ id: 2, size: 1000, phase: 'sealed', bytesDone: 1000 })]).overall, 75);
  assert.equal(t([row({ phase: 'canceled', bytesDone: 100, error: { message: 'Canceled.' } }), row({ id: 2, phase: 'sealed' })]).overall, 100);
});

// ---------- memory only ----------

test('nothing of the tray or the queue is written to any browser storage, and the upload is XMLHttpRequest with the key and abort support', () => {
  for (const file of ['services/transfers.js', 'services/uploadSlots.js', 'services/transferRuntime.js', 'utils/trayModel.js', 'components/TransferTray.jsx', 'components/TransferTrayView.jsx']) {
    assert.doesNotMatch(strip(read(file)), /localStorage|sessionStorage|indexedDB|caches\.|serviceWorker/, file);
  }
  const service = strip(read('services/documentsService.js'));
  assert.match(service, /const XHR_ONLY = typeof XMLHttpRequest === 'undefined' \? \{\} : \{ adapter: 'xhr' \};/);
  assert.equal((service.match(/\.\.\.XHR_ONLY/g) || []).length, 2, 'uploads and new versions');
  assert.match(service, /formData\.append\('uploadKey', uploadKey \|\| newUploadKey\(\)\)/);
  assert.match(STOP_SEALING_PROMPT, /^Stop sealing\? Files already sealed stay in your vault\.$/);
});

test('every path that sends a file to the server goes through the manager', () => {
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(src, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(jsx?|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const text = strip(read(rel));
        if (/\buploadDocument\(|\buploadNewVersion\(/.test(text)) callers.push(rel);
      }
    }
  };
  for (const dir of ['components', 'pages', 'services', 'utils']) walk(dir);
  // the definitions, the manager's loaded runtime (injected as runtime.uploadDocument), and the zip import's own (slot-gated) upload: nothing else calls them
  assert.deepEqual(callers.sort(), ['services/documentsService.js', 'services/importRuntime.js', 'services/transfers.js']);
  for (const file of ['pages/FilesPage.jsx', 'components/scan/ScanDialog.jsx', 'components/DetailsVersions.jsx']) assert.match(strip(read(file)), /transfers\.enqueue\(/, file);
  assert.match(strip(read('pages/FilesPage.jsx')), /onDrop=\{handleComputerDrop\}/, 'files dropped on the page');
});
