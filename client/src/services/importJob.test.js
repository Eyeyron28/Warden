import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCKED_MESSAGE, PROGRESS_THROTTLE_MS, createImportJobManager, destinationOf } from './importJob.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

const file = (name, size = 100, dir = '') => ({ entry: name, name, dir, size });
const planOf = (files, extra = {}) => ({ ok: true, files, folders: [], ignored: [], skipped: [], totalBytes: 0, ...extra });

/** A manager wired to fakes: the zip code, the clock, the timers, the session and the window. */
function rig({ token = 'token-A' } = {}) {
  const runs = [];
  const timers = [];
  const clock = { t: 1_000_000 };
  const tokenListeners = new Set();
  const windowEvents = { added: [], removed: [] };
  const session = { token, notice: null };
  const finished = [];
  const manager = createImportJobManager({
    loadRuntime: async () => ({
      runImport: (options) => new Promise((resolve, reject) => runs.push({ options, resolve, reject })),
      loadJSZip: async () => ({ fake: 'jszip' }),
      inspect: () => ({ ok: true }),
      uploadFile: async () => ({}),
      createFolder: async () => ({}),
      onFinished: (result) => finished.push(result),
    }),
    getToken: () => session.token,
    subscribeToken: (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    peekSessionNotice: () => session.notice,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length;
    },
    clearTimer: (id) => {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
    window: {
      addEventListener: (type, fn) => windowEvents.added.push({ type, fn }),
      removeEventListener: (type, fn) => windowEvents.removed.push({ type, fn }),
    },
  });
  const changes = [];
  manager.subscribe(() => changes.push(manager.getState()));
  const signIn = (next, notice = null) => {
    session.token = next;
    session.notice = notice;
    tokenListeners.forEach((listener) => listener(next));
  };
  const fireTimers = () => timers.splice(0).filter((timer) => !timer.cancelled).forEach((timer) => timer.fn());
  const result = (overrides = {}) => ({ uploaded: 0, failures: [], cancelled: false, quotaHit: false, ...overrides });
  return { manager, runs, timers, clock, windowEvents, session, finished, changes, signIn, fireTimers, result };
}

const begin = async (r, files = [file('a.txt'), file('b.txt'), file('c.txt')], name = 'backup.zip') => {
  const started = r.manager.start({ name, bytes: new Uint8Array([1, 2, 3]), plan: planOf(files) });
  await flush();
  return started;
};

// ---------- start, progress, finish ----------

test('start: a running job with the file name, totals and destination; reading, then validating, then uploading', async () => {
  const r = rig();
  const started = r.manager.start({ name: 'backup.zip', bytes: new Uint8Array(3), plan: planOf([file('a.txt', 10, 'Taxes'), file('b.txt', 30, 'Taxes/2024')]) });
  assert.deepEqual(started, { ok: true });
  const first = r.manager.getState();
  assert.equal(first.status, 'running');
  assert.equal(first.phase, 'reading');
  assert.equal(first.fileName, 'backup.zip');
  assert.equal(first.total, 2);
  assert.equal(first.bytesTotal, 40);
  assert.equal(first.destination, 'Taxes', 'every file is inside one top-level folder');
  assert.equal(first.cardVisible, true);
  assert.ok(first.startedAt > 0);
  await flush();
  assert.equal(r.manager.getState().phase, 'uploading');
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].options.signal.aborted, false);
  assert.deepEqual(r.runs[0].options.JSZip, { fake: 'jszip' });
});

test('the destination is the top level unless every file is inside the same top-level folder', () => {
  assert.equal(destinationOf(planOf([file('a', 1, ''), file('b', 1, 'Docs')])), '');
  assert.equal(destinationOf(planOf([file('a', 1, 'Docs'), file('b', 1, 'Other')])), '');
  assert.equal(destinationOf(planOf([file('a', 1, 'Docs'), file('b', 1, 'Docs/Sub')])), 'Docs');
  assert.equal(destinationOf(planOf([file('a', 1, '')])), '');
});

test('progress is throttled: many files finishing in a burst reach the screen a few times a second, and the last count is always sent', async () => {
  const r = rig();
  await begin(r, Array.from({ length: 200 }, (_, i) => file(`f${i}.txt`)));
  const before = r.changes.length;
  const { options } = r.runs[0];
  for (let i = 1; i <= 200; i += 1) {
    options.onResult({ path: `f${i}.txt`, status: 'imported', size: 100 });
    options.onProgress({ done: i, total: 200, uploaded: i, current: `f${i}.txt` });
  }
  const during = r.changes.length - before;
  assert.ok(during <= 3, `200 updates produced ${during} renders (the first, and one scheduled for later)`);
  assert.equal(PROGRESS_THROTTLE_MS, 250);
  // the scheduled one carries the newest numbers
  r.clock.t += 300;
  r.fireTimers();
  assert.equal(r.manager.getState().done, 200);
  assert.equal(r.manager.getState().bytesDone, 20000);
  // and a later burst waits for the interval again
  assert.equal(r.timers.filter((t) => !t.cancelled).length, 0);
});

test('finish: done, with every file in the report, bytes and counts, the card visible, onFinished told, and the tab warning removed', async () => {
  const r = rig();
  await begin(r);
  const { options } = r.runs[0];
  assert.equal(r.windowEvents.added.filter((e) => e.type === 'beforeunload').length, 1, 'closing the tab now warns');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    options.onResult({ path: name, status: 'imported', size: 100 });
    options.onProgress({ done: 1, total: 3, uploaded: 1, current: name });
  }
  r.runs[0].resolve(r.result({ uploaded: 3 }));
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.phase, 'finished');
  assert.equal(state.uploaded, 3);
  assert.equal(state.bytesDone, 300);
  assert.deepEqual(state.results.map((item) => item.status), ['imported', 'imported', 'imported']);
  assert.equal(state.cardVisible, true);
  assert.ok(state.finishedAt >= state.startedAt);
  assert.equal(r.finished.length, 1);
  assert.equal(r.finished[0].uploaded, 3);
  assert.equal(r.windowEvents.removed.filter((e) => e.type === 'beforeunload').length, 1, 'the warning is gone');
  assert.match(state.announce, /Import finished\. 3 files imported\./);
  assert.ok(!('bytes' in state) && !JSON.stringify(state).includes('"zip"'), 'the zip is not part of the state');
});

test('a file saved under another name (same-name counter) is reported with its new name', async () => {
  const r = rig();
  await begin(r, [file('a.txt')]);
  r.runs[0].options.onResult({ path: 'a.txt', status: 'imported', size: 1, savedAs: 'a (1).txt' });
  r.runs[0].resolve(r.result({ uploaded: 1 }));
  await flush();
  assert.equal(r.manager.getState().results[0].savedAs, 'a (1).txt');
});

test('partial failure: the job still finishes as done, with each failure and its reason, and what was imported stays counted', async () => {
  const r = rig();
  await begin(r, [file('a.txt'), file('b.txt'), file('c.txt')], 'mixed.zip');
  const { options } = r.runs[0];
  options.onResult({ path: 'a.txt', status: 'imported', size: 10 });
  options.onResult({ path: 'b.txt', status: 'failed', reason: 'File exceeds the 4MB size limit.', size: 10 });
  options.onResult({ path: 'c.txt', status: 'imported', size: 10 });
  r.runs[0].resolve(r.result({ uploaded: 2, failures: [{ path: 'b.txt', reason: 'x' }] }));
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.uploaded, 2);
  assert.deepEqual(state.results.filter((item) => item.status === 'failed'), [{ path: 'b.txt', status: 'failed', reason: 'File exceeds the 4MB size limit.' }]);
});

test('a storage-full stop is reported on the job', async () => {
  const r = rig();
  await begin(r);
  r.runs[0].resolve(r.result({ uploaded: 1, quotaHit: true }));
  await flush();
  assert.match(r.manager.getState().message, /storage filled up/);
});

test('an error before any file is uploaded fails the job with a message, keeping nothing', async () => {
  const r = rig();
  await begin(r);
  r.runs[0].reject(Object.assign(new Error('boom'), { response: { data: { error: { message: 'The zip is broken.' } } } }));
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.message, 'The zip is broken.');
  assert.equal(state.uploaded, 0);
});

test('the zip is checked again before anything is uploaded: a zip that no longer passes never reaches the upload', async () => {
  const runs = [];
  const manager = createImportJobManager({
    loadRuntime: async () => ({
      runImport: async (o) => runs.push(o),
      loadJSZip: async () => ({}),
      inspect: () => ({ ok: false, message: 'That zip looks like a decompression bomb.' }),
      uploadFile: async () => ({}),
      createFolder: async () => ({}),
    }),
    getToken: () => 'x',
    subscribeToken: () => () => {},
    window: null,
  });
  manager.start({ name: 'bad.zip', bytes: new Uint8Array(1), plan: planOf([file('a')]) });
  await flush();
  assert.equal(runs.length, 0);
  assert.equal(manager.getState().status, 'failed');
  assert.match(manager.getState().message, /decompression bomb/);
});

// ---------- one at a time ----------

test('a second import while one runs is refused with the reason, and changes nothing', async () => {
  const r = rig();
  await begin(r);
  const before = r.manager.getState();
  const second = r.manager.start({ name: 'other.zip', bytes: new Uint8Array(1), plan: planOf([file('x')]) });
  assert.deepEqual(second, { ok: false, message: BLOCKED_MESSAGE });
  assert.equal(r.manager.getState(), before);
  assert.equal(r.runs.length, 1);
  assert.match(BLOCKED_MESSAGE, /already running/);
  // when the first is over, another may start, and the old report is replaced
  r.runs[0].resolve(r.result({ uploaded: 3 }));
  await flush();
  assert.deepEqual(r.manager.start({ name: 'other.zip', bytes: new Uint8Array(1), plan: planOf([file('x')]) }), { ok: true });
  assert.equal(r.manager.getState().fileName, 'other.zip');
  assert.equal(r.manager.getState().results.length, 0);
});

// ---------- cancel ----------

test('cancel: the signal is aborted, the job ends as cancelled after the current file, and what was imported stays counted', async () => {
  const r = rig();
  await begin(r);
  const { options } = r.runs[0];
  options.onResult({ path: 'a.txt', status: 'imported', size: 1 });
  options.onProgress({ done: 1, total: 3, uploaded: 1, current: '' });
  r.manager.cancel();
  assert.equal(options.signal.aborted, true);
  assert.equal(r.manager.getState().status, 'running', 'it stops after the file in flight');
  r.runs[0].resolve(r.result({ uploaded: 1, cancelled: true }));
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'cancelled');
  assert.equal(state.uploaded, 1);
  assert.match(state.announce, /Import cancelled\. 1 file imported\./);
  assert.equal(state.cardVisible, true);
});

// ---------- the session ----------

test('signing out or locking the vault (the token goes, no expiry notice) cancels the job and leaves no name or result behind', async () => {
  const r = rig();
  await begin(r, [file('secret-name.pdf'), file('b.pdf')], 'my-private-backup.zip');
  r.runs[0].options.onResult({ path: 'secret-name.pdf', status: 'imported', size: 1 });
  r.signIn(null);
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'idle');
  assert.equal(r.runs[0].options.signal.aborted, true);
  assert.equal(JSON.stringify(state).includes('secret-name'), false);
  assert.equal(JSON.stringify(state).includes('my-private-backup'), false);
  assert.deepEqual(state.results, []);
  assert.equal(state.cardVisible, false);
  assert.equal(r.windowEvents.removed.filter((e) => e.type === 'beforeunload').length, 1);
  // the run finishing afterwards does not bring anything back
  r.runs[0].resolve(r.result({ uploaded: 1 }));
  await flush();
  assert.equal(r.manager.getState().status, 'idle');
  assert.equal(r.finished.length, 0);
});

test('another account signing in clears the job; the same token announcing itself again does not', async () => {
  const r = rig();
  await begin(r);
  r.signIn('token-A');
  await flush();
  assert.equal(r.manager.getState().status, 'running', 'the same session: nothing happens');
  r.signIn('token-B');
  await flush();
  assert.equal(r.manager.getState().status, 'idle');
  assert.equal(r.runs[0].options.signal.aborted, true);
});

test('the account switch also clears a FINISHED job and its report', async () => {
  const r = rig();
  await begin(r, [file('a.txt')], 'report.zip');
  r.runs[0].options.onResult({ path: 'a.txt', status: 'imported', size: 1 });
  r.runs[0].resolve(r.result({ uploaded: 1 }));
  await flush();
  assert.equal(r.manager.getState().status, 'done');
  r.signIn('token-B');
  await flush();
  assert.equal(r.manager.getState().status, 'idle');
  assert.equal(r.manager.getState().fileName, '');
});

test('the session expiring mid-import stops it cleanly: what was imported is kept and reported, every name is let go', async () => {
  const r = rig();
  await begin(r, [file('a.txt'), file('b.txt')], 'trip.zip');
  r.runs[0].options.onResult({ path: 'a.txt', status: 'imported', size: 1 });
  r.runs[0].options.onProgress({ done: 1, total: 2, uploaded: 1, current: '' });
  r.signIn(null, 'Your session expired. Sign in again.');
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'stopped');
  assert.equal(state.uploaded, 1);
  assert.match(state.message, /Your session ended, so the import stopped\. 1 file was imported before that and is kept\./);
  assert.equal(state.fileName, '');
  assert.deepEqual(state.results, []);
  assert.equal(state.cardVisible, true, 'the card tells the person');
  assert.equal(r.runs[0].options.signal.aborted, true);
  assert.equal(JSON.stringify(state).includes('a.txt'), false);
});

test('a 401 on an upload (the server says the session is over) stops the job at once instead of failing every file left', async () => {
  const r = rig();
  await begin(r);
  const { options } = r.runs[0];
  options.onResult({ path: 'a.txt', status: 'imported', size: 1 });
  options.onResult({ path: 'b.txt', status: 'failed', reason: 'Your session expired', size: 1, sessionEnded: true });
  assert.equal(options.signal.aborted, true);
  r.runs[0].resolve(r.result({ uploaded: 1, cancelled: true, failures: [{ path: 'b.txt', reason: 'x' }] }));
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'stopped');
  assert.equal(state.uploaded, 1);
  assert.deepEqual(state.results, []);
});

// ---------- asking before sign-out ----------

test('Lock vault with nothing running just runs; with an import running it asks, and answering "keep importing" changes nothing', async () => {
  const r = rig();
  let locked = 0;
  assert.equal(await r.manager.requestSignOut(async () => { locked += 1; }), true);
  assert.equal(locked, 1);

  await begin(r);
  const pending = r.manager.requestSignOut(async () => { locked += 1; });
  assert.equal(r.manager.getState().signOutPrompt, true);
  assert.equal(locked, 1, 'not yet');
  await r.manager.answerSignOut(false);
  assert.equal(await pending, false);
  assert.equal(locked, 1);
  assert.equal(r.manager.getState().signOutPrompt, false);
  assert.equal(r.manager.getState().status, 'running');
});

test('answering "stop and sign out" stops the import, clears the job, then signs out; files already imported are not undone', async () => {
  const r = rig();
  const order = [];
  await begin(r);
  r.runs[0].options.onResult({ path: 'a.txt', status: 'imported', size: 1 });
  const pending = r.manager.requestSignOut(async () => { order.push(`signed out; job is ${r.manager.getState().status}`); });
  await r.manager.answerSignOut(true);
  assert.equal(await pending, true);
  assert.deepEqual(order, ['signed out; job is idle']);
  assert.equal(r.runs[0].options.signal.aborted, true);
  assert.match(strip(read('services/importJob.js')), /Files already imported stay imported|files already imported stay imported|NOT atomic/i);
});

// ---------- announcements ----------

test('screen readers are told at the start, at every quarter, and at the end - not for every file', async () => {
  const r = rig();
  await begin(r, Array.from({ length: 40 }, (_, i) => file(`f${i}.txt`)));
  const heard = new Set([r.manager.getState().announce]);
  const { options } = r.runs[0];
  for (let i = 1; i <= 40; i += 1) {
    options.onProgress({ done: i, total: 40, uploaded: i, current: '' });
    r.clock.t += 300; // past the throttle: every file is published
    r.fireTimers();
    heard.add(r.manager.getState().announce);
  }
  r.runs[0].resolve(r.result({ uploaded: 40 }));
  await flush();
  heard.add(r.manager.getState().announce);
  const lines = [...heard].filter(Boolean);
  assert.ok(lines.some((line) => /^Importing backup\.zip: 40 files\./.test(line)), 'the start');
  for (const quarter of [25, 50, 75]) assert.ok(lines.some((line) => line.startsWith(`Import ${quarter}% done`)), `${quarter}%`);
  assert.ok(lines.some((line) => /Import finished\. 40 files imported\./.test(line)), 'the end');
  assert.ok(lines.length <= 6, `${lines.length} announcements for 40 files`);
});

// ---------- the job lives above the pages, and keeps nothing on disk ----------

test('the job is a module of its own: no page owns it, and nothing of it is written to any browser storage', () => {
  const job = strip(read('services/importJob.js'));
  assert.doesNotMatch(job, /localStorage|sessionStorage|indexedDB|caches\.|serviceWorker/);
  assert.match(job, /export const importJob = createImportJobManager\(/);
  assert.match(job, /import\('\.\/importRuntime\.js'\)/, 'the zip code and the upload load with the first job, not with the app');
  assert.doesNotMatch(job, /zipImport|documentsService|jszip/);
  const exportPage = strip(read('pages/ExportPage.jsx'));
  assert.doesNotMatch(exportPage, /runImport|importAbort/, 'the page no longer runs or aborts the import');
  assert.doesNotMatch(exportPage, /useEffect/, 'nothing on the page is tied to its lifecycle');
  assert.match(exportPage, /useImportJob\(\)/);
  const main = strip(read('main.jsx'));
  assert.match(main, /<App \/>[\s\S]*<TransferHost \/>[\s\S]*<\/BrowserRouter>/, 'mounted beside the routes, inside the router, above every page');
  for (const file of ['components/TransferTray.jsx', 'components/TransferTrayView.jsx', 'services/transfers.js']) assert.doesNotMatch(strip(read(file)), /localStorage|sessionStorage|indexedDB/, file);
});

test('every way of leaving the session goes through the job: Lock vault and signing this device out ask first', () => {
  // the transfers manager asks for the whole tray (an import is one of its rows)
  assert.match(strip(read('App.jsx')), /transfers\.requestSignOut\(/);
  assert.match(strip(read('pages/DevicesPage.jsx')), /transfers\.requestSignOut\(/);
  assert.match(strip(read('services/transfers.js')), /An import is running\. Stop it and sign out\?/);
  assert.match(strip(read('services/importJob.js')), /watchToken\(\(next\) =>/);
  assert.match(strip(read('services/importJob.js')), /An import is running\. Stop it and sign out\?/);
  assert.match(strip(read('services/importJob.js')), /beforeunload/);
});

// ---------- a chosen zip is kept while the person looks at other pages ----------

const zipArgs = (name = 'chosen.zip') => ({ name, bytes: new Uint8Array([9, 9, 9]), plan: planOf([file('a.txt', 10, 'Top'), file('b.txt', 20, 'Top')]) });

test('prepare: the chosen zip (name and checked plan) lives in the job module, so it is still there after a route change', () => {
  const r = rig();
  assert.equal(r.manager.getState().prepared, null);
  r.manager.prepare(zipArgs());
  const kept = r.manager.getState().prepared;
  assert.equal(kept.name, 'chosen.zip');
  assert.equal(kept.plan.files.length, 2);
  assert.equal(JSON.stringify(r.manager.getState()).includes('"9,9,9"'), false, 'the bytes are not in the published state');
  // a page unmounts and another mounts: nothing in the module changes, and a new subscriber reads it at once
  let seen = null;
  r.manager.subscribe(() => {});
  seen = r.manager.getState().prepared;
  assert.equal(seen.name, 'chosen.zip');
  assert.equal(r.manager.isRunning(), false, 'nothing is running, so no warning on closing the tab');
  assert.equal(r.windowEvents.added.filter((e) => e.type === 'beforeunload').length, 0);
});

test('only one chosen zip at a time: choosing another replaces it', () => {
  const r = rig();
  r.manager.prepare(zipArgs('one.zip'));
  r.manager.prepare(zipArgs('two.zip'));
  assert.equal(r.manager.getState().prepared.name, 'two.zip');
});

test('Clear removes it; Import starts the job with it and the job takes over (nothing is left prepared)', async () => {
  const r = rig();
  r.manager.prepare(zipArgs());
  r.manager.unprepare();
  assert.equal(r.manager.getState().prepared, null);
  assert.deepEqual(r.manager.startPrepared(), { ok: false, message: 'Choose a zip first.' });
  r.manager.prepare(zipArgs('go.zip'));
  assert.deepEqual(r.manager.startPrepared(), { ok: true });
  await flush();
  const state = r.manager.getState();
  assert.equal(state.status, 'running');
  assert.equal(state.fileName, 'go.zip');
  assert.equal(state.prepared, null);
  assert.equal(r.runs.length, 1, 'the job really started with the prepared bytes');
  assert.deepEqual([...r.runs[0].options.bytes], [9, 9, 9]);
  // while a job runs a new zip cannot be prepared
  r.manager.prepare(zipArgs('later.zip'));
  assert.equal(r.manager.getState().prepared, null);
});

test('a chosen zip never outlives its session: sign-out, lock, a 401, an expiry and another account all clear it', async () => {
  for (const [label, next, notice] of [['sign-out or lock', null, null], ['a 401 / expiry', null, { kind: 'expired' }], ['another account', 'token-B', null]]) {
    const r = rig();
    r.manager.prepare(zipArgs());
    r.signIn(next, notice);
    await flush();
    assert.equal(r.manager.getState().prepared, null, label);
  }
  const same = rig();
  same.manager.prepare(zipArgs());
  same.signIn('token-A');
  await flush();
  assert.notEqual(same.manager.getState().prepared, null, 'the same session: it stays');
  // the app-wide reset (sessionReset.js) calls clear(): nothing of a chosen zip is left
  const reset = rig();
  reset.manager.prepare(zipArgs());
  reset.manager.clear();
  assert.equal(reset.manager.getState().prepared, null);
  assert.equal(reset.manager.startPrepared().ok, false, 'and its bytes are gone too');
});

test('a chosen zip is memory only: nothing is written to any browser storage', () => {
  const code = strip(read('services/importJob.js'));
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie/);
  assert.match(strip(read('pages/ExportPage.jsx')), /If you reload the page, you will need to choose the zip again\./);
  assert.match(strip(read('pages/ExportPage.jsx')), /onClick=\{\(\) => importJob\.unprepare\(\)\}/);
});
