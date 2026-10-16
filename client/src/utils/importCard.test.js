import test from 'node:test';
import assert from 'node:assert/strict';

import { createDismissTimer, describeCard, filesLink, importCardConfig, percentOf, skippedCount } from './importCard.js';


const state = (patch = {}) => ({
  id: 1,
  status: 'running',
  phase: 'uploading',
  fileName: 'backup.zip',
  destination: '',
  done: 12,
  total: 48,
  bytesDone: 0,
  bytesTotal: 0,
  current: '',
  uploaded: 12,
  results: [],
  ignored: [],
  skipped: [],
  startedAt: 1,
  finishedAt: 0,
  message: '',
  announce: '',
  cardVisible: true,
  signOutPrompt: false,
  ...patch,
});
const finished = (patch = {}) => state({ status: 'done', phase: 'finished', done: 48, uploaded: 48, finishedAt: 2, ...patch });

// ---------- what the card says and where a click goes ----------

test('running: "Importing backup.zip", "12 of 48 files", a percentage, Cancel, a click opens the Import screen, and it never closes itself', () => {
  const view = describeCard(state());
  assert.equal(view.kind, 'running');
  assert.equal(view.title, 'Importing');
  assert.equal(view.name, 'backup.zip');
  assert.equal(view.line, '12 of 48 files');
  assert.equal(view.percent, 25);
  assert.equal(view.target, '/export');
  assert.equal(view.canCancel, true);
  assert.equal(view.closable, false);
  assert.equal(view.autoDismiss, false, 'no auto-dismiss while running');
  assert.equal(describeCard(state({ done: 1, total: 1 })).line, '1 of 1 file');
  assert.equal(describeCard(state({ phase: 'reading' })).line, 'Reading the zip…');
  assert.equal(describeCard(state({ phase: 'validating' })).line, 'Checking the zip…');
  assert.equal(percentOf(state({ total: 0 })), 0);
  assert.equal(percentOf(state({ done: 48 })), 100);
});

test('finished: "Imported 48 files" with a check; a click opens the destination folder in the file list', () => {
  const view = describeCard(finished({ destination: 'Backup 2026' }));
  assert.equal(view.kind, 'done');
  assert.equal(view.title, 'Imported 48 files');
  assert.equal(view.target, '/files?path=Backup%202026');
  assert.equal(view.autoDismiss, true);
  assert.equal(view.closable, true);
  assert.equal(describeCard(finished()).target, '/files', 'no folder: My files');
  assert.equal(describeCard(finished({ uploaded: 1 })).title, 'Imported 1 file');
  assert.equal(filesLink('A/B & C'), '/files?path=A%2FB%20%26%20C');
});

test('finished with problems: "Imported 45 files, 3 skipped" with a warning; failures, skips and ignored entries all count', () => {
  const failed = (path) => ({ path, status: 'failed', reason: 'x' });
  const view = describeCard(finished({ uploaded: 45, results: [failed('a'), failed('b')], skipped: [{ path: 'big.bin', reason: 'Larger than 4 MB' }] }));
  assert.equal(view.kind, 'warning');
  assert.equal(view.title, 'Imported 45 files, 3 skipped');
  assert.match(view.target, /^\/files/);
  assert.equal(skippedCount(finished({ ignored: [{ path: '../x', reason: 'Unsafe' }] })), 1);
});

test('nothing imported but some skipped or failed: a click goes to the Import screen report, not to the files', () => {
  const view = describeCard(finished({ uploaded: 0, done: 3, total: 3, results: [{ path: 'a', status: 'failed', reason: 'x' }] }));
  assert.equal(view.kind, 'warning');
  assert.equal(view.title, 'Imported 0 files, 1 skipped');
  assert.equal(view.target, '/export');
});

test('cancelled: says what was kept, and a click opens the folder when anything was imported', () => {
  const view = describeCard(state({ status: 'cancelled', phase: 'finished', uploaded: 12 }));
  assert.equal(view.kind, 'cancelled');
  assert.equal(view.title, 'Import cancelled');
  assert.equal(view.line, '12 files imported before it stopped');
  assert.match(view.target, /^\/files/);
  assert.equal(view.autoDismiss, true);
  assert.equal(describeCard(state({ status: 'cancelled', uploaded: 0 })).target, '/export');
});

test('stopped (session ended) and failed: the reason, no name, no folder to open for a stop, and both close by themselves', () => {
  const stopped = describeCard(state({ status: 'stopped', fileName: '', message: 'Your session ended, so the import stopped. 12 files were imported before that and are kept.', uploaded: 12 }));
  assert.equal(stopped.kind, 'stopped');
  assert.equal(stopped.target, null);
  assert.equal(stopped.name, '');
  assert.match(stopped.line, /Your session ended/);
  assert.equal(stopped.autoDismiss, true);
  const failed = describeCard(state({ status: 'failed', message: 'That zip could not be imported.' }));
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.target, '/export');
  assert.equal(failed.autoDismiss, true);
});

test('no card when there is no job, or once it has been dismissed (the report stays on the Import page)', () => {
  assert.equal(describeCard(state({ status: 'idle' })), null);
  assert.equal(describeCard(finished({ cardVisible: false })), null);
});

// ---------- the 45-second dismissal ----------

function fakeClock() {
  const timers = [];
  const clock = { t: 0 };
  return {
    clock,
    timers,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: clock.t + ms, cancelled: false });
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1].cancelled = true;
    },
    now: () => clock.t,
    advance(ms) {
      clock.t += ms;
      for (const timer of timers) {
        if (!timer.cancelled && !timer.done && timer.at <= clock.t) {
          timer.done = true;
          timer.fn();
        }
      }
    },
  };
}

test('the finished card goes away after the dismiss time (45 s by default), and not a moment before', () => {
  assert.equal(importCardConfig.dismissMs, 45_000);
  const fake = fakeClock();
  let gone = 0;
  const timer = createDismissTimer({ ms: importCardConfig.dismissMs, onExpire: () => { gone += 1; }, ...fake });
  timer.start();
  fake.advance(44_999);
  assert.equal(gone, 0);
  fake.advance(1);
  assert.equal(gone, 1);
  fake.advance(100_000);
  assert.equal(gone, 1, 'once');
});

test('the time is a named value that can be overridden (the browser check shortens it)', () => {
  const original = importCardConfig.dismissMs;
  importCardConfig.dismissMs = 2000;
  const fake = fakeClock();
  let gone = 0;
  createDismissTimer({ ms: importCardConfig.dismissMs, onExpire: () => { gone += 1; }, ...fake }).start();
  fake.advance(2000);
  assert.equal(gone, 1);
  importCardConfig.dismissMs = original;
  assert.equal(importCardConfig.dismissMs, 45_000);
});

test('while the card has keyboard focus the timer is paused, and it resumes with the time that was left', () => {
  const fake = fakeClock();
  let gone = 0;
  const timer = createDismissTimer({ ms: 45_000, onExpire: () => { gone += 1; }, ...fake });
  timer.start();
  fake.advance(30_000);
  timer.pause(); // focus enters the card
  assert.equal(timer.remaining(), 15_000);
  fake.advance(600_000);
  assert.equal(gone, 0, 'paused: it stays however long focus is there');
  timer.resume(); // focus leaves
  fake.advance(14_999);
  assert.equal(gone, 0);
  fake.advance(1);
  assert.equal(gone, 1);
});

test('clicking or pressing close dismisses at once: the timer is cancelled and cannot fire later', () => {
  const fake = fakeClock();
  let gone = 0;
  const timer = createDismissTimer({ ms: 45_000, onExpire: () => { gone += 1; }, ...fake });
  timer.start();
  fake.advance(10_000);
  timer.cancel();
  fake.advance(100_000);
  assert.equal(gone, 0);
  timer.resume();
  fake.advance(100_000);
  assert.equal(gone, 0, 'a cancelled timer stays cancelled');
});
