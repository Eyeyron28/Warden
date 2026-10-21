import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { CONTROL_SELECTOR, MAX_WIDTH, OPEN_MS, SWITCH_MS, createEngine, hasVisibleText, placeTip, resolveTip, suppressTitle } from './tooltipCore.js';
import { TIPS, buildTray, reasonSentences } from './trayModel.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const el = (attrs = {}) => {
  const a = { ...attrs };
  return {
    getAttribute: (n) => (n in a ? a[n] : null),
    setAttribute: (n, v) => { a[n] = String(v); },
    removeAttribute: (n) => { delete a[n]; },
  };
};
const noText = () => false;
const hasText = () => true;

test('the words: data-tip first, then aria-label, then the title attribute', () => {
  assert.equal(resolveTip(el({ 'data-tip': 'Tip', 'aria-label': 'Aria', title: 'Title' }), { visibleText: noText }), 'Tip');
  assert.equal(resolveTip(el({ 'aria-label': 'Aria', title: 'Title' }), { visibleText: noText }), 'Aria');
  assert.equal(resolveTip(el({ title: 'Title' }), { visibleText: noText }), 'Title');
  assert.equal(resolveTip(el({}), { visibleText: noText }), '');
  assert.equal(resolveTip(el({ 'aria-label': '   ' }), { visibleText: noText }), '', 'blank is nothing');
});

test('a control with visible text of its own shows no tooltip unless it has a data-tip; decided at hover time', () => {
  assert.equal(resolveTip(el({ 'aria-label': 'Cancel' }), { visibleText: hasText }), '');
  assert.equal(resolveTip(el({ title: 'Cancel upload' }), { visibleText: hasText }), '');
  assert.equal(resolveTip(el({ 'data-tip': 'Encrypt the files and save them to your vault' }), { visibleText: hasText }), 'Encrypt the files and save them to your vault');
  const button = el({ 'aria-label': 'Scan' });
  let wide = true;
  const visible = () => wide;
  assert.equal(resolveTip(button, { visibleText: visible }), '');
  wide = false;
  assert.equal(resolveTip(button, { visibleText: visible }), 'Scan');
});

test('"visible text": a text node whose box is on screen counts; whitespace, a 1px clipped label and hidden text do not', () => {
  const doc = (nodes) => ({
    createTreeWalker: () => { let i = -1; return { nextNode: () => (++i < nodes.length ? nodes[i].node : null) }; },
    defaultView: { getComputedStyle: (p) => ({ visibility: p.style?.visibility || 'visible', display: p.style?.display || 'block' }) },
  });
  const node = (text, w, h, style = {}) => ({ node: { nodeValue: text, parentElement: { getBoundingClientRect: () => ({ width: w, height: h }), style } } });
  assert.equal(hasVisibleText({}, doc([node('Cancel', 60, 20)])), true);
  assert.equal(hasVisibleText({}, doc([node('   ', 60, 20)])), false);
  assert.equal(hasVisibleText({}, doc([node('Lock vault', 1, 1)])), false, 'the screen-reader-only trick');
  assert.equal(hasVisibleText({}, doc([node('Lock vault', 60, 20, { display: 'none' })])), false);
  assert.equal(hasVisibleText({}, doc([node('Hidden', 60, 20, { visibility: 'hidden' })])), false);
  assert.equal(hasVisibleText({}, doc([])), false);
});

test('title suppression: the title moves to data-tip so the browser\'s own tooltip never also shows; the accessible name is kept', () => {
  const icon = el({ title: 'Details' });
  assert.equal(suppressTitle(icon, { visibleText: noText }), true);
  assert.equal(icon.getAttribute('title'), null);
  assert.equal(icon.getAttribute('data-tip'), 'Details');
  assert.equal(icon.getAttribute('aria-label'), 'Details', 'still named for a screen reader');
  const labelled = el({ title: 'Star', 'aria-label': 'Star report.pdf' });
  suppressTitle(labelled, { visibleText: noText });
  assert.equal(labelled.getAttribute('aria-label'), 'Star report.pdf', 'an existing aria-label is not replaced');
  const texty = el({ title: 'Full name of the file.pdf' });
  suppressTitle(texty, { visibleText: hasText });
  assert.equal(texty.getAttribute('aria-label'), null, 'a control with its own text needs no extra name');
  assert.equal(texty.getAttribute('data-tip'), 'Full name of the file.pdf', 'but its title now shows once, in the shared tooltip');
  const tipped = el({ title: 'Old', 'data-tip': 'Mine' });
  suppressTitle(tipped, { visibleText: noText });
  assert.equal(tipped.getAttribute('data-tip'), 'Mine');
  assert.equal(suppressTitle(el({}), { visibleText: noText }), false);
});

function rig() {
  const timers = [];
  const clock = { t: 0 };
  const log = [];
  const words = new Map();
  const engine = createEngine({
    resolve: (e) => words.get(e) || '',
    show: (e, text) => log.push(`show:${text}`),
    hide: (e) => log.push(`hide:${words.get(e)}`),
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, at: clock.t + ms, dead: false, done: false }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
  });
  const advance = (ms) => { clock.t += ms; timers.forEach((t) => { if (!t.dead && !t.done && t.at <= clock.t) { t.done = true; t.fn(); } }); };
  const make = (text) => { const e = {}; words.set(e, text); return e; };
  return { engine, log, advance, make, words, clock };
}

test('hover: opens after 400 ms of rest, not before; hides when the pointer leaves', () => {
  assert.equal(OPEN_MS, 400);
  const { engine, log, advance, make } = rig();
  const a = make('Close');
  engine.enter(a);
  advance(399);
  assert.deepEqual(log, []);
  advance(1);
  assert.deepEqual(log, ['show:Close']);
  engine.leave(a);
  assert.deepEqual(log, ['show:Close', 'hide:Close']);
  advance(301);
  const b = make('Star');
  engine.enter(b);
  advance(200);
  engine.leave(b);
  advance(1000);
  assert.equal(log.filter((l) => l.startsWith('show')).length, 1, 'a quick pass never shows');
});

test('switching: moving to a neighbour while one shows, or within 300 ms of one hiding, shows it at once', () => {
  assert.equal(SWITCH_MS, 300);
  const { engine, log, advance, make, clock } = rig();
  const a = make('Details');
  const b = make('More actions');
  engine.enter(a);
  advance(400);
  engine.enter(b);
  assert.deepEqual(log.slice(-2), ['hide:Details', 'show:More actions']);
  engine.leave(b);
  clock.t += 250;
  const c = make('Star');
  engine.enter(c);
  assert.equal(log.at(-1), 'show:Star', 'within 300 ms of hiding: instant');
  engine.leave(c);
  advance(400);
  const d = make('Close');
  engine.enter(d);
  advance(399);
  assert.equal(log.at(-1), 'hide:Star', 'after 300 ms of rest the 400 ms delay applies again');
  advance(1);
  assert.equal(log.at(-1), 'show:Close');
});

test('it hides on click or activation, scroll, resize and Escape, and does not come back by itself', () => {
  for (const how of ['press', 'scroll', 'resize', 'escape']) {
    const { engine, log, advance, make } = rig();
    const a = make('Download');
    engine.enter(a);
    advance(400);
    assert.equal(engine.current(), a, how);
    assert.equal(engine[how](), true, `${how} hides it`);
    assert.equal(engine.current(), null);
    advance(2000);
    assert.deepEqual(log, ['show:Download', 'hide:Download'], how);
    assert.equal(engine[how](), false, `${how} with nothing showing does nothing`);
  }
  const r = rig();
  const a = r.make('Share');
  r.engine.enter(a);
  r.advance(200);
  r.engine.press();
  r.advance(1000);
  assert.deepEqual(r.log, []);
});

test('keyboard focus (focus-visible only) shows at once and blur hides; a mouse click\'s focus does not show it', () => {
  const { engine, log, make } = rig();
  const a = make('Minimize');
  engine.focus(a, false);
  assert.deepEqual(log, []);
  engine.focus(a, true);
  assert.deepEqual(log, ['show:Minimize']);
  engine.blur(a);
  assert.deepEqual(log, ['show:Minimize', 'hide:Minimize']);
});

test('touch pointers are ignored; a pen counts like a mouse; a control with no words closes the previous tooltip', () => {
  const { engine, log, advance, make } = rig();
  const a = make('Star');
  engine.enter(a, 'touch');
  advance(2000);
  assert.deepEqual(log, []);
  engine.enter(a, 'pen');
  advance(400);
  assert.deepEqual(log, ['show:Star']);
  const plain = make('');
  engine.enter(plain);
  assert.equal(engine.current(), null, 'nothing to say: the old tooltip goes');
  assert.equal(log.at(-1), 'hide:Star');
});

test('the words are re-read when the delay is over: words that vanished meanwhile mean no tooltip', () => {
  const { engine, log, advance, make, words } = rig();
  const a = make('Scan');
  engine.enter(a);
  words.set(a, '');
  advance(400);
  assert.deepEqual(log, []);
});

test('placement: below, flipped above near the bottom, shifted at least 8 px inside, at most 240 px wide (and the screen minus margins)', () => {
  assert.equal(MAX_WIDTH, 240);
  const tip = { width: 300, height: 40 };
  const below = placeTip({ left: 600, top: 100, width: 32, height: 32, bottom: 132 }, tip, { width: 1280, height: 800 });
  assert.equal(below.side, 'bottom');
  assert.equal(below.top, 140);
  assert.equal(below.width, 240, 'capped at 240');
  assert.equal(below.left, 600 + 16 - 120, 'centred on the control');
  const above = placeTip({ left: 600, top: 760, width: 32, height: 32, bottom: 792 }, tip, { width: 1280, height: 800 });
  assert.equal(above.side, 'top');
  assert.equal(above.top, 760 - 8 - 40);
  const edge = placeTip({ left: 1250, top: 100, width: 32, height: 32, bottom: 132 }, tip, { width: 1280, height: 800 });
  assert.equal(edge.left + edge.width, 1280 - 8, 'shifted left to stay 8 px inside');
  assert.equal(placeTip({ left: 0, top: 100, width: 32, height: 32, bottom: 132 }, tip, { width: 1280, height: 800 }).left, 8);
  const phone = placeTip({ left: 10, top: 10, width: 32, height: 32, bottom: 42 }, { width: 400, height: 60 }, { width: 320, height: 640 });
  assert.equal(phone.width, 240);
  const narrow = placeTip({ left: 10, top: 10, width: 32, height: 32, bottom: 42 }, { width: 400, height: 60 }, { width: 200, height: 640 });
  assert.equal(narrow.width, 184, 'never wider than the screen minus margins');
  assert.ok(narrow.left >= 8 && narrow.left + narrow.width <= 192);
});

test('the controls that get tooltips: buttons, links, role="button" and menu items, and anything with data-tip', () => {
  for (const part of ['button', 'a[href]', '[role="button"]', '[role="menuitem"]', '[data-tip]']) assert.ok(CONTROL_SELECTOR.includes(part), part);
});

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
  assert.match(importLine, /^Imported 5 files, 2 held for review, 1 not saved · each file checked$/);
  assert.equal(buildTray({ rows: [], announce: '' }, done).rows[0].tip, TIPS.importDone);
});

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

test('the tray icon is a focusable button named by its explanation and carrying it as data-tip for the shared tooltip', () => {
  const html = render.icon({ tip: TIPS.sealed });
  assert.match(html, /<button type="button"[^>]*aria-label="Sealed: encrypted with your vault key/);
  assert.match(html, /data-tip="Sealed: encrypted with your vault key/);
  assert.doesNotMatch(html, /tabindex="-1"|role="tooltip"/, 'reachable by Tab; the tooltip itself is the one shared element');
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
    assert.ok(html.includes(`data-tip="${text}`), text);
  }
});

test('one implementation: the tray has no tooltip of its own; a tap on a touch screen uses the shared floating element', () => {
  const code = strip(read('components/StatusRing.jsx'));
  assert.doesNotMatch(code, /createPortal|role="tooltip"|placeTip|createTipController/);
  assert.match(code, /import\('\.\.\/utils\/tooltip\.js'\)\.then\(\(module\) => module\.toggleSticky\(/);
  assert.doesNotMatch(strip(read('components/Sidebar.jsx')), /createPortal|role="tooltip"|setTip/, 'the rail has no tooltip of its own either');
  assert.ok(!fs.existsSync(path.join(src, 'utils', 'statusTip.js')));
});

test('the DOM side: one floating element, pointer-events none, above modals, no animation for reduced motion, theme tokens, nothing inline in markup', () => {
  const code = strip(read('utils/tooltip.js'));
  assert.equal((code.match(/createElement\('div'\)/g) || []).length, 1, 'one element');
  assert.match(code, /setAttribute\('role', 'tooltip'\)/);
  assert.match(code, /document\.addEventListener\(type, handle, \{ capture: true, passive: true \}\)/, 'delegated');
  const css = strip(read('utils/tooltip.css'));
  assert.match(css, /pointer-events: none;/);
  assert.match(css, /z-index: 2000;/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*#warden-tooltip \{\s*animation:/, 'animated only when motion is welcome');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}\b|rgba?\(/, 'theme tokens only');
  assert.doesNotMatch(code, /setAttribute\('style'|innerHTML/);
});

test('aria-describedby is added only when the tooltip says more than the name', () => {
  const code = strip(read('utils/tooltip.js'));
  assert.match(code, /if \(name !== text\) \{\s*el\.setAttribute\('aria-describedby', ID\);/);
  assert.match(code, /described\.removeAttribute\('aria-describedby'\)/);
});

test('the bootstrap is tiny, listens for mouse hover and keyboard focus only, ignores touch, and loads the tooltip lazily', () => {
  const boot = read('utils/tooltipBootstrap.js');
  assert.match(boot, /import\('\.\/tooltip\.js'\)/);
  assert.match(boot, /event\.pointerType === 'touch'/);
  assert.match(boot, /:focus-visible/);
  assert.ok(boot.replace(/\/\/.*$/gm, '').length < 900, 'a few lines');
  assert.doesNotMatch(strip(read('main.jsx')), /utils\/tooltip\.js|tooltipCore/, 'main only imports the bootstrap');
});

test('disabled controls with a reason: aria-disabled (so hover works) and a data-tip; the handlers refuse the action too', () => {
  const upload = strip(read('components/UploadForm.jsx'));
  assert.match(upload, /aria-disabled=\{!summary\.canUpload \|\| undefined\}/);
  assert.match(upload, /'Choose at least one file'/);
  assert.match(upload, /'Encrypt the files and save them to your vault'/);
  assert.match(upload, /if \(!summary\.canUpload \|\| lock\.current\) return;/);
  const exportPage = strip(read('pages/ExportPage.jsx'));
  assert.match(exportPage, /'Choose a \.zip first'/);
  assert.match(exportPage, /onClick=\{\(\) => i\.phase === 'checked' && startImport\(\)\}/);
  const release = strip(read('components/ReleaseDialog.jsx'));
  assert.match(release, /'Type RELEASE to enable'/);
  assert.match(release, /if \(ready\) onConfirm\(typed\.trim\(\)\);/);
  assert.match(strip(read('utils/tooltip.js')), /querySelectorAll\('\[data-tip\]:disabled'\)/);
});

test('names: shortName cuts a name to 40 characters in the middle and keeps the ending; short names are untouched', async () => {
  const { shortName } = await import('./ellipsis.js');
  assert.equal(shortName('report.pdf'), 'report.pdf');
  const long = `${'quarterly_'.repeat(30)}final-report.pdf`;
  const cut = shortName(long);
  assert.equal([...cut].length, 40);
  assert.ok(cut.includes('…') && cut.endsWith('final-report.pdf'.slice(-14)));
  assert.equal(shortName('é'.repeat(41)).length, 40, 'whole characters');
  assert.equal(shortName(undefined), '');
});

test('a tap-opened popover starts the listeners itself, so a touch-only visitor can close it by tapping elsewhere', () => {
  assert.match(strip(read('utils/tooltip.js')), /export function toggleSticky\(el, text\) \{\s*start\(\);/);
});
