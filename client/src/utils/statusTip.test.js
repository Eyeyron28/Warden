import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { TIP_DELAY_MS, createTipController, placeTip } from './statusTip.js';
import { TIPS, buildTray, reasonSentences } from './trayModel.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- the behaviour: hover, focus, Escape, touch ----------

function rig() {
  const timers = [];
  const log = [];
  const clock = { t: 0 };
  const ctl = createTipController({
    onChange: (open) => log.push(open),
    setTimer: (fn, ms) => { timers.push({ fn, at: clock.t + ms, dead: false }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
  });
  const advance = (ms) => { clock.t += ms; timers.forEach((t) => { if (!t.dead && !t.done && t.at <= clock.t) { t.done = true; t.fn(); } }); };
  return { ctl, log, advance };
}

test('mouse: the tooltip opens after about 200 ms over the icon, not before, and hides when the mouse leaves', () => {
  assert.equal(TIP_DELAY_MS, 200);
  const { ctl, log, advance } = rig();
  ctl.mouseEnter();
  advance(199);
  assert.equal(ctl.isOpen(), false);
  advance(1);
  assert.equal(ctl.isOpen(), true);
  ctl.mouseLeave();
  assert.equal(ctl.isOpen(), false);
  assert.deepEqual(log, [true, false]);
  // passing over quickly never shows it
  ctl.mouseEnter();
  advance(100);
  ctl.mouseLeave();
  advance(500);
  assert.deepEqual(log, [true, false]);
});

test('keyboard: focus shows it at once, blur hides it, Escape hides it and says it used the key (so the tray does not also minimize)', () => {
  const { ctl, advance } = rig();
  ctl.focus();
  assert.equal(ctl.isOpen(), true);
  assert.equal(ctl.keyDown('Tab'), false);
  assert.equal(ctl.isOpen(), true);
  assert.equal(ctl.keyDown('Escape'), true);
  assert.equal(ctl.isOpen(), false);
  assert.equal(ctl.keyDown('Escape'), false, 'nothing open: Escape is the tray\'s');
  ctl.focus();
  ctl.blur();
  assert.equal(ctl.isOpen(), false);
  ctl.mouseEnter();
  ctl.keyDown('Escape');
  advance(1000);
  assert.equal(ctl.isOpen(), false, 'a pending hover does not reopen it');
});

test('touch: a tap toggles the popover; a tap elsewhere closes it', () => {
  const { ctl, log } = rig();
  ctl.tap();
  assert.equal(ctl.isOpen(), true);
  ctl.tap();
  assert.equal(ctl.isOpen(), false);
  ctl.tap();
  ctl.outside();
  assert.equal(ctl.isOpen(), false);
  ctl.outside();
  assert.deepEqual(log, [true, false, true, false], 'only real changes are reported');
});

// ---------- where it goes ----------

const inside = (box, vw, vh, margin = 8) => box.left >= margin && box.top >= margin && box.left + box.width <= vw - margin && box.top + (box.height ?? 0) <= vh - margin;

test('placement: beside the icon, flipped above when there is no room below, shifted inside the viewport', () => {
  const tip = { width: 260, height: 90 };
  // 360 px phone, icon at the right edge of a tray, near the bottom
  const phone = placeTip({ left: 300, top: 700, width: 36, height: 36, bottom: 736 }, tip, { width: 360, height: 760 });
  assert.equal(phone.side, 'top', 'no room below: above');
  assert.ok(phone.left >= 8 && phone.left + phone.width <= 360 - 8, `inside at 360: ${JSON.stringify(phone)}`);
  assert.ok(phone.top >= 8 && phone.top + tip.height <= 760 - 8);
  // the very right edge of a wide screen
  const edge = placeTip({ left: 1244, top: 300, width: 36, height: 36, bottom: 336 }, tip, { width: 1280, height: 800 });
  assert.equal(edge.side, 'bottom');
  assert.ok(edge.left + edge.width <= 1280 - 8, `not past the right edge: ${edge.left + edge.width}`);
  // the left edge
  assert.equal(placeTip({ left: 0, top: 100, width: 36, height: 36, bottom: 136 }, tip, { width: 1280, height: 800 }).left, 8);
  // wider than the screen: it shrinks
  const tiny = placeTip({ left: 10, top: 10, width: 36, height: 36, bottom: 46 }, { width: 400, height: 60 }, { width: 320, height: 640 });
  assert.equal(tiny.width, 304);
  assert.ok(inside({ ...tiny, height: 60 }, 320, 640));
  // centered on the icon when there is room
  const mid = placeTip({ left: 500, top: 100, width: 36, height: 36, bottom: 136 }, tip, { width: 1280, height: 800 });
  assert.equal(mid.left, 500 + 18 - 130);
});

// ---------- the texts ----------

const row = (patch) => ({ id: 1, kind: 'upload', name: 'a.pdf', size: 1000, phase: 'sealed', state: 'done', bytesDone: 1000, error: null, destination: '', ...patch });
const tipOf = (r, job = { status: 'idle', results: [], skipped: [], ignored: [] }) => buildTray({ rows: [r], announce: '' }, job).rows[0].tip;
const sentence = (code, text) => ({ code, text });

test('every state has its tip, in the words of the prompt', () => {
  assert.equal(tipOf(row({ phase: 'waiting' })), 'Waiting its turn. Warden sends two files at a time.');
  assert.equal(tipOf(row({ phase: 'sending', bytesDone: 5 })), 'Sending this file to your vault.');
  assert.equal(tipOf(row({ phase: 'sealing' })), 'Encrypting and saving. Almost done.');
  assert.equal(tipOf(row({})), "Sealed: encrypted with your vault key and saved. Warden's simple rules found nothing risky. This is not a full antivirus.");
  assert.equal(tipOf(row({ unchecked: true })), 'Sealed and saved. This file could not be checked.');
  assert.equal(tipOf(row({ phase: 'canceled', error: { message: 'Canceled. Nothing was saved.' } })), 'Canceled. Nothing was saved.');
  const sealing = 'Canceled while sealing. It may already be in your vault: the list is refreshed.';
  assert.equal(tipOf(row({ phase: 'canceled', error: { message: sealing, maybeSaved: true } })), sealing);
  assert.equal(tipOf(row({ phase: 'failed', error: { message: 'Network error', retryable: true } })), 'Could not finish: Network error. You can try again.');
  assert.equal(tipOf(row({ phase: 'failed', error: { message: 'Over your 25 MB limit', retryable: false } })), 'Could not finish: Over your 25 MB limit.');
  assert.ok(Object.values(TIPS).every((text) => text.length > 10 && !/sandbox|\bAI\b/i.test(text)));
});

test('held and not saved: the sentences come from the shared table (the server\'s), never raw codes, and never content', () => {
  const held = tipOf(row({ held: [sentence('PDF_ACTIVE', 'This PDF contains active content (scripts, automatic actions or embedded files).'), sentence('TYPE_MISMATCH', 'The name says one kind of file, but the content looks like another.')] }));
  assert.equal(held, "Held for review: Warden's rules found something risky. Reasons: This PDF contains active content (scripts, automatic actions or embedded files). The name says one kind of file, but the content looks like another. Open Quarantine to decide.");
  assert.doesNotMatch(held, /PDF_ACTIVE|TYPE_MISMATCH/);
  const refused = tipOf(row({ phase: 'failed', error: { refused: true, retryable: false, reasons: [sentence('KNOWN_TEST_SIGNATURE', 'This file carries the standard antivirus test signature.')] } }));
  assert.equal(refused, 'Not saved: This file carries the standard antivirus test signature.');
  assert.equal(tipOf(row({ phase: 'failed', error: { refused: true, reasons: [sentence('PLAIN_ZIP', 'Zip files go through Export / Import, so every file inside is checked.')] } })), 'Not saved: Zip files go through Export / Import, so every file inside is checked.');
  assert.match(tipOf(row({ held: ['OFFICE_MACRO'] })), /Reasons: Contains macros\./, 'a bare code still reads as words');
  assert.equal(reasonSentences([sentence('X', 'No full stop')]), 'No full stop.');
  assert.equal(reasonSentences(undefined), '');
});

test('the status line says "checked" or "not checked" next to Sealed; the import row says what happened to the files inside', () => {
  const line = (r, job) => buildTray({ rows: [r], announce: '' }, job || { status: 'idle', results: [], skipped: [], ignored: [] }).rows[0].line;
  assert.equal(line(row({})), 'Sealed · checked');
  assert.equal(line(row({ unchecked: true })), 'Sealed · not checked');
  assert.equal(line(row({ kind: 'newVersion' })), 'New version sealed · checked');
  assert.equal(line(row({ savedAs: 'a (1).pdf' })), 'Sealed as "a (1).pdf" · checked');
  const done = { status: 'done', phase: 'finished', fileName: 'b.zip', done: 8, total: 8, uploaded: 5, bytesTotal: 100, bytesDone: 100, finishedAt: 5, destination: '', cardVisible: true, announce: '', ignored: [], skipped: [],
    results: [...Array(5).fill({ status: 'imported' }), { status: 'held' }, { status: 'held' }, { status: 'refused' }] };
  const importLine = buildTray({ rows: [], announce: '' }, done).rows[0].line;
  assert.match(importLine, /^Imported 5 files, 2 held, 1 not saved · each file checked$/);
  assert.equal(buildTray({ rows: [], announce: '' }, done).rows[0].tip, TIPS.importDone);
});

// ---------- the icon, rendered ----------

let render;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import StatusRing from './components/StatusRing.jsx';
    import { TransferTrayView } from './components/TransferTrayView.jsx';
    import { buildTray } from './utils/trayModel.js';
    export const icon = (props) => renderToStaticMarkup(createElement(StatusRing, { ring: 'sealed', percent: 100, ...props }));
    export const tray = (rows) => renderToStaticMarkup(createElement(TransferTrayView, { model: buildTray({ rows, announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }), dismissMs: 45000 }));`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: src, loader: 'jsx' },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const js = built.outputFiles.find((file) => file.path.endsWith('.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-tip-'));
  const file = path.join(dir, 'tip.cjs');
  fs.writeFileSync(file, js.text);
  render = createRequire(import.meta.url)(file);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the icon is a focusable button named by its explanation; open, it has a role="tooltip" that the button is described by', () => {
  const closed = render.icon({ tip: TIPS.sealed });
  assert.match(closed, /<button type="button"[^>]*aria-label="Sealed: encrypted with your vault key/);
  assert.doesNotMatch(closed, /role="tooltip"|aria-describedby/);
  const open = render.icon({ tip: TIPS.sealed, forceOpen: true });
  assert.match(open, /role="tooltip"[^>]*data-testid="status-tip"[^>]*>Sealed: encrypted with your vault key/);
  const id = /<span id="([^"]+)" role="tooltip"/.exec(open)[1];
  assert.match(open, new RegExp(`aria-describedby="${id.replace(/[:]/g, '\\$&')}"`));
  assert.doesNotMatch(open, /tabindex="-1"/, 'reachable by Tab');
});

test('every row state in the tray renders its icon with its tip', () => {
  const rows = [
    { id: 1, kind: 'upload', name: 'a', size: 10, phase: 'waiting', bytesDone: 0 },
    { id: 2, kind: 'upload', name: 'b', size: 10, phase: 'sending', bytesDone: 5 },
    { id: 3, kind: 'upload', name: 'c', size: 10, phase: 'sealing', bytesDone: 10 },
    { id: 4, kind: 'upload', name: 'd', size: 10, phase: 'sealed', bytesDone: 10 },
    { id: 5, kind: 'upload', name: 'e', size: 10, phase: 'sealed', bytesDone: 10, held: [{ code: 'PDF_ACTIVE', text: 'Active content.' }] },
    { id: 6, kind: 'upload', name: 'f', size: 10, phase: 'failed', error: { refused: true, reasons: [{ code: 'KNOWN_TEST_SIGNATURE', text: 'Test signature.' }] } },
    { id: 7, kind: 'upload', name: 'g', size: 10, phase: 'failed', error: { message: 'Network error', retryable: true } },
    { id: 8, kind: 'upload', name: 'h', size: 10, phase: 'canceled', error: { message: 'Canceled. Nothing was saved.' } },
  ];
  const html = render.tray(rows);
  assert.equal((html.match(/data-testid="status-icon"/g) || []).length, 8);
  for (const text of ['Waiting its turn', 'Sending this file', 'Encrypting and saving', 'Sealed: encrypted', 'Held for review: Warden&#x27;s rules found something risky. Reasons: Active content.', 'Not saved: Test signature.', 'Could not finish: Network error. You can try again.', 'Canceled. Nothing was saved.']) {
    assert.ok(html.includes(`aria-label="${text}`), text);
  }
});

test('wiring: a mouse never opens it from an emulated touch hover, Escape is kept from the tray, the box is portaled and clamped', () => {
  const code = strip(read('components/StatusRing.jsx'));
  assert.match(code, /if \(pointer\.current !== 'touch'\) control\.current\.mouseEnter\(\)/);
  assert.match(code, /event\.stopPropagation\(\);/);
  assert.match(code, /createPortal\(tooltip, document\.body\)/);
  assert.match(code, /placeTip\(anchor,/);
  assert.match(code, /document\.addEventListener\('pointerdown', outside, true\)/);
  assert.doesNotMatch(code, /autoFocus|(button|box)\.current\??\.focus\(/, 'focus is never moved');
  const css = strip(read('components/TransferTray.module.css'));
  assert.match(/\.statusTip \{([^}]*)\}/.exec(css)[1], /max-width: min\(280px, calc\(100vw - 16px\)\);/);
  assert.doesNotMatch(/\.statusTip \{([^}]*)\}/.exec(css)[1], /#[0-9a-f]{3,8}|rgba?\(/i, 'theme tokens only');
});

test('the tooltip code lives in the lazy tray chunk, not the main bundle', () => {
  assert.doesNotMatch(strip(read('App.jsx')) + strip(read('services/transfers.js')) + strip(read('components/Sidebar.jsx')), /statusTip|StatusRing/);
});
