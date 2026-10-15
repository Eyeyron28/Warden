import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { createDismissTimer, describeCard, filesLink, importCardConfig, percentOf, skippedCount } from './importCard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

test('the container starts the timer only for a finished card, pauses it on focus, and counts the line down for the same time', () => {
  const card = strip(read('components/ImportCard.jsx'));
  assert.match(card, /const autoDismiss = Boolean\(view\?\.autoDismiss\);\s*useEffect\(\(\) => \{\s*if \(!autoDismiss\) return undefined;/, 'nothing while running');
  assert.match(card, /createDismissTimer\(\{ ms: importCardConfig\.dismissMs, onExpire: \(\) => importJob\.dismissCard\(\) \}\)/);
  assert.match(card, /timer\.current\?\.pause\(\)/);
  assert.match(card, /timer\.current\?\.resume\(\)/);
  assert.match(card, /navigate\(view\.target\);\s*if \(view\.autoDismiss\) importJob\.dismissCard\(\);/, 'a click opens the target, and dismisses a finished card');
  assert.match(card, /onClose=\{\(\) => importJob\.dismissCard\(\)\}/);
  assert.match(card, /onStop=\{\(\) => importJob\.cancel\(\)\}/);
  const style = read('components/ImportCard.module.css').replace(/\r\n/g, '\n');
  assert.match(style, /animation: drain var\(--dismiss-ms, 45s\) linear forwards;/);
  assert.match(style, /\.countdownFill\[data-paused\] \{\s*animation-play-state: paused;/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.spin \{\s*animation: none;/);
});

// ---------- the card as markup (the real component, rendered) ----------

let renderCard;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ImportCardView } from './components/ImportCardView.jsx';
    import { describeCard } from './utils/importCard.js';
    export const render = (state, props = {}) => {
      const view = describeCard(state);
      return view ? renderToStaticMarkup(createElement(ImportCardView, { view, announce: state.announce, dismissMs: 45000, ...props })) : '';
    };`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: src, loader: 'jsx' },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const js = built.outputFiles.find((file) => file.path.endsWith('.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-card-'));
  const file = path.join(dir, 'card.cjs');
  fs.writeFileSync(file, js.text);
  renderCard = createRequire(import.meta.url)(file).render;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('markup, running: the title, the name, the count, the bar, Cancel, one click target; no close button and no countdown', () => {
  const html = renderCard(state({ announce: 'Importing backup.zip: 48 files.' }));
  assert.match(html, /data-testid="import-card"/);
  assert.match(html, /data-kind="running"/);
  assert.match(html, /Importing /);
  assert.match(html, /aria-label="backup\.zip"/, 'the file name, as text');
  assert.match(html, /12 of 48 files/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="25"/);
  assert.match(html, />25%</);
  assert.match(html, /data-action="cancel"/);
  assert.match(html, /data-action="open" data-target="\/export"/);
  assert.doesNotMatch(html, /data-action="dismiss"/, 'it cannot be closed while it runs');
  assert.doesNotMatch(html, /countdown/);
  assert.match(html, /<div class="[^"]*" role="status" aria-live="polite">Importing backup\.zip: 48 files\.<\/div>/, 'one polite live region with the announcement');
  assert.equal((html.match(/aria-live=/g) || []).length, 1, 'the counters themselves are not live');
});

test('markup, Cancel asks first: "Stop the import?" with Stop and Keep going, and the Cancel button is gone', () => {
  const html = renderCard(state(), { confirming: true });
  assert.match(html, /Stop the import\?/);
  assert.match(html, /data-action="stop"/);
  assert.match(html, /data-action="keep-going"/);
  assert.doesNotMatch(html, /data-action="cancel"/);
});

test('markup, finished: the title, a click target to the folder, a close button, and the countdown line for 45 seconds', () => {
  const html = renderCard(finished({ destination: 'Backup' }));
  assert.match(html, /data-kind="done"/);
  assert.match(html, /Imported 48 files/);
  assert.match(html, /data-action="open" data-target="\/files\?path=Backup"/);
  assert.match(html, /data-action="dismiss"/);
  assert.match(html, /--dismiss-ms:45000ms/);
  assert.doesNotMatch(html, /data-paused/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(renderCard(finished(), { focused: true }), /data-paused="true"/, 'the line stops while the card has focus');
});

test('markup, finished with problems, cancelled, stopped and failed', () => {
  const warning = renderCard(finished({ uploaded: 45, skipped: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] }));
  assert.match(warning, /data-kind="warning"/);
  assert.match(warning, /Imported 45 files, 3 skipped/);
  const cancelled = renderCard(state({ status: 'cancelled', uploaded: 12 }));
  assert.match(cancelled, /data-kind="cancelled"/);
  assert.match(cancelled, /Import cancelled/);
  assert.match(cancelled, /data-action="dismiss"/);
  const stopped = renderCard(state({ status: 'stopped', fileName: '', message: 'Your session ended, so the import stopped.' }));
  assert.match(stopped, /Your session ended/);
  assert.doesNotMatch(stopped, /data-action="open"/, 'nothing to open');
  assert.match(renderCard(state({ status: 'failed', message: 'That zip could not be imported.' })), /data-kind="failed"/);
  assert.equal(renderCard(finished({ cardVisible: false })), '');
});

test('markup: a 255-character zip name is plain text with the full name as the tooltip and accessible name; markup in a name is escaped', () => {
  const long = `${'quarterly_report_'.repeat(16).slice(0, 251)}.zip`;
  assert.equal(long.length, 255);
  const html = renderCard(state({ fileName: long }));
  assert.ok(html.includes(`title="${long}"`) && html.includes(`aria-label="${long}"`));
  assert.match(html, /aria-hidden="true">[^<]*<\/span><span class="[^"]*" aria-hidden="true">[^<]*\.zip<\/span>/, 'the extension is the visible tail');
  const evil = renderCard(state({ fileName: '<img src=x onerror=alert(1)>.zip' }));
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img/);
});
