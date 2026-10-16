import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import JSZip from 'jszip';

import { describeCard, outcomeOf, outcomeText, skippedCount } from './importCard.js';
import { RING, buildTray } from './trayModel.js';
import { inspectZip, runImport } from './zipImport.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const job = (patch = {}) => ({
  id: 1, status: 'done', phase: 'finished', fileName: 'mix.zip', destination: 'Mix', done: 4, total: 4, bytesDone: 0, bytesTotal: 400, current: '',
  uploaded: 0, results: [], ignored: [], skipped: [], startedAt: 1, finishedAt: 2, message: '', announce: '', cardVisible: true, signOutPrompt: false, prepared: null, ...patch,
});
const statuses = (...list) => list.map((status, n) => ({ path: `f${n}`, status }));

// ---------- the real case: a zip with 1 clean and 3 risky files ----------

test('a zip with 1 clean and 3 risky files, built in memory and imported through the real import code, reports 1 imported and 3 held', async () => {
  const zip = new JSZip();
  zip.file('Mix/clean.txt', 'plain words');
  zip.file('Mix/form-1.pdf', '%PDF-1.4 /JavaScript');
  zip.file('Mix/form-2.pdf', '%PDF-1.4 /OpenAction');
  zip.file('Mix/logo.svg', '<svg><script>x</script></svg>');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const plan = inspectZip(bytes);
  assert.equal(plan.ok, true);
  const results = [];
  // the server's answer for each file, as the real upload route gives it (held: true with reasons for the risky ones)
  const uploadFile = async (file) => (file.name === 'clean.txt' ? { id: 'ok', filename: file.name } : { id: `h-${file.name}`, held: true, reasons: [{ code: 'PDF_ACTIVE', text: 'x' }] });
  const out = await runImport({ bytes, plan, JSZip, uploadFile, createFolder: async () => {}, onResult: (r) => results.push(r), concurrency: 1 });
  assert.equal(out.uploaded, 1, 'only the clean file is imported');
  assert.equal(out.held, 3);
  const state = job({ uploaded: out.uploaded, results, total: 4, done: 4 });
  assert.deepEqual(outcomeOf(state), { imported: 1, held: 3, refused: 0, other: 0 });
  // the words that were wrong before: "Imported 1 file, 3 skipped" (held counted as skipped) and "Some files were not imported."
  assert.equal(describeCard(state).title, 'Imported 1 file, 3 held for review');
  assert.equal(skippedCount(state), 0, 'a held file is not a skipped one');
  const tray = buildTray({ rows: [], announce: '' }, state);
  assert.equal(tray.rows[0].line, 'Imported 1 file, 3 held for review · each file checked');
  assert.equal(tray.title, 'Sealed 1, 3 held for review');
});

// ---------- the wording ----------

test('"Imported 4 files" only when every file is clean; held and not saved are named; nothing clean says so', () => {
  assert.equal(outcomeText({ imported: 4, held: 0, refused: 0, other: 0 }), 'Imported 4 files');
  assert.equal(outcomeText({ imported: 1, held: 0, refused: 0, other: 0 }), 'Imported 1 file');
  assert.equal(outcomeText({ imported: 1, held: 3, refused: 0, other: 0 }), 'Imported 1 file, 3 held for review');
  assert.equal(outcomeText({ imported: 1, held: 2, refused: 1, other: 0 }), 'Imported 1 file, 2 held for review, 1 not saved');
  assert.equal(outcomeText({ imported: 0, held: 4, refused: 0, other: 0 }), 'No files imported. 4 held for review');
  assert.equal(outcomeText({ imported: 0, held: 0, refused: 2, other: 0 }), 'No files imported. 2 not saved');
  assert.equal(outcomeText({ imported: 45, held: 0, refused: 0, other: 3 }), 'Imported 45 files, 3 skipped');
  assert.equal(outcomeText({ imported: 0, held: 0, refused: 0, other: 0 }), 'Imported 0 files');
  for (const text of ['Imported 4 files', 'Imported 1 file, 3 held for review']) assert.doesNotMatch(text, /sandbox|\bAI\b/i);
});

test('the finished card: colour tone, click target and the held count', () => {
  const clean = describeCard(job({ uploaded: 4, results: statuses('imported', 'imported', 'imported', 'imported') }));
  assert.equal(clean.kind, 'done');
  assert.equal(clean.tone, 'ok');
  assert.equal(clean.target, '/files?path=Mix', 'something imported: its folder');
  const held = describeCard(job({ uploaded: 1, results: statuses('imported', 'held', 'held') }));
  assert.equal(held.kind, 'warning');
  assert.equal(held.tone, 'held');
  assert.equal(held.held, 2);
  assert.equal(held.target, '/files?path=Mix', 'at least one imported: the folder');
  const refused = describeCard(job({ uploaded: 1, results: statuses('imported', 'held', 'refused') }));
  assert.equal(refused.tone, 'refused');
  const none = describeCard(job({ uploaded: 0, results: statuses('held', 'held') }));
  assert.equal(none.title, 'No files imported. 2 held for review');
  assert.equal(none.target, '/quarantine', 'nothing imported and something held: Quarantine');
  assert.equal(describeCard(job({ uploaded: 0, results: statuses('refused') })).target, '/export', 'nothing imported, nothing held: the report');
});

test('tray titles for mixed batches: "Sealed 1, 1 held for review", and the import row\'s review button only when something is held', () => {
  const upload = (id, patch) => ({ id, kind: 'upload', name: `f${id}`, size: 10, phase: 'sealed', state: 'done', bytesDone: 10, error: null, destination: '', ...patch });
  const idle = { status: 'idle', results: [], skipped: [], ignored: [] };
  assert.equal(buildTray({ rows: [upload(1), upload(2, { held: [{ code: 'PDF_ACTIVE', text: 'x.' }] })], announce: '' }, idle).title, 'Sealed 1, 1 held for review');
  const withHeld = buildTray({ rows: [], announce: '' }, job({ uploaded: 1, results: statuses('imported', 'held') }));
  assert.equal(withHeld.rows[0].actions.review, '/quarantine');
  assert.equal(withHeld.rows[0].ring, RING.HELD, 'amber, not the sealed lock');
  assert.equal(withHeld.autoDismiss, false);
  const clean = buildTray({ rows: [], announce: '' }, job({ uploaded: 2, results: statuses('imported', 'imported') }));
  assert.equal(clean.rows[0].actions.review, null);
  assert.equal(clean.rows[0].ring, RING.SEALED);
  assert.equal(clean.autoDismiss, true);
  const redOnly = buildTray({ rows: [], announce: '' }, job({ uploaded: 1, results: statuses('imported', 'refused') }));
  assert.equal(redOnly.rows[0].ring, RING.REFUSED);
  assert.equal(redOnly.anyRefused, true);
});

test('the screen-reader sentence at the end uses the same counts: held files are never "imported"', () => {
  const runtime = read('services/importRuntime.js');
  assert.match(runtime, /outcomeLine: \(state\) => outcomeText\(outcomeOf\(state\)\)/);
  const jobCode = read('services/importJob.js');
  assert.match(jobCode, /announce: `Import \$\{cancelled \? 'cancelled' : 'finished'\}\. \$\{outcomeLine\(/);
  assert.doesNotMatch(jobCode, /Import finished\. \$\{uploaded\} file/);
});

// ---------- the look of the rows, rendered ----------

let ui;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { TransferTrayView } from './components/TransferTrayView.jsx';
    import { buildTray } from './utils/trayModel.js';
    export const tray = (rows, job, props = {}) => renderToStaticMarkup(createElement(TransferTrayView, { model: buildTray({ rows, announce: '' }, job || { status: 'idle', results: [], skipped: [], ignored: [] }), dismissMs: 45000, ...props }));`;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-outcome-'));
  const file = path.join(dir, 'ui.cjs');
  fs.writeFileSync(file, js.text);
  ui = createRequire(import.meta.url)(file);
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (id, patch) => ({ id, kind: 'upload', name: `f${id}`, size: 10, phase: 'sealed', state: 'done', bytesDone: 10, error: null, destination: '', ...patch });
const ringOf = (html) => /data-ring="([a-z]+)"/.exec(html)[1];
const svgOf = (html) => /<svg[^>]*class="[^"]*TransferTray_(?:lock|warn)[^"]*"[^>]*>([\s\S]*?)<\/svg>/.exec(html)?.[1] ?? '';

test('a sealed row has the lock, a held row the amber warning shield, a not-saved row the red blocked sign: the shapes differ, not only the colours', () => {
  const sealed = ui.tray([upload(1)]);
  const held = ui.tray([upload(2, { held: [{ code: 'PDF_ACTIVE', text: 'Active content.' }] })]);
  const refused = ui.tray([upload(3, { phase: 'failed', error: { refused: true, reasons: [{ code: 'KNOWN_TEST_SIGNATURE', text: 'T.' }] } })]);
  assert.deepEqual([ringOf(sealed), ringOf(held), ringOf(refused)], ['sealed', 'held', 'refused']);
  const shapes = [sealed, held, refused].map((html) => svgOf(html));
  assert.ok(shapes.every(Boolean), 'each has an icon');
  assert.equal(new Set(shapes).size, 3, 'three different icon shapes');
  assert.match(held, /Held for review/);
  assert.doesNotMatch(held, /data-ring="sealed"/);
  const css = fs.readFileSync(path.join(src, 'components/TransferTray.module.css'), 'utf8');
  assert.match(/\.ring\[data-ring='held'\] \{([^}]*)\}/.exec(css)[1], /color: var\(--color-warn\)/);
  assert.match(/\.ring\[data-ring='refused'\] \{([^}]*)\}/.exec(css)[1], /color: var\(--color-danger\)/);
});

test('the minimized tray: amber when anything is held, red when something is not saved and nothing is held, the lock otherwise', () => {
  const held = ui.tray([upload(1), upload(2, { held: [{ code: 'X', text: 'x.' }] })], null, { minimized: true });
  const refused = ui.tray([upload(1), upload(3, { phase: 'failed', error: { refused: true, reasons: [] } })], null, { minimized: true });
  const both = ui.tray([upload(2, { held: [{ code: 'X', text: 'x.' }] }), upload(3, { phase: 'failed', error: { refused: true, reasons: [] } })], null, { minimized: true });
  const sealed = ui.tray([upload(1)], null, { minimized: true });
  const headerRing = (html) => /<header[\s\S]*?data-ring="([a-z]+)"/.exec(html)[1];
  assert.equal(headerRing(held), 'held');
  assert.equal(headerRing(refused), 'refused');
  assert.equal(headerRing(both), 'held', 'held wins: amber');
  assert.equal(headerRing(sealed), 'sealed');
});

test('the finished import row shows "Review held files" only when something is held, and the state of the tray says held', () => {
  const withHeld = ui.tray([], job({ uploaded: 1, results: statuses('imported', 'held', 'held', 'held') }));
  assert.match(withHeld, /data-action="review"[^>]*>Review held files</);
  assert.match(withHeld, /Imported 1 file, 3 held for review · each file checked/);
  assert.match(withHeld, /data-state="held"/);
  const clean = ui.tray([], job({ uploaded: 4, results: statuses('imported', 'imported', 'imported', 'imported') }));
  assert.doesNotMatch(clean, /data-action="review"/);
  assert.match(clean, /Imported 4 files · each file checked/);
  assert.match(clean, /data-state="done"/);
});

test('amber and its icon meet WCAG AA (3:1 for the icon, 4.5:1 for text) on the tray background, light and dark', () => {
  const tokens = fs.readFileSync(path.join(src, 'styles/tokens.css'), 'utf8');
  const pick = (block, name) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];
  // the tokens file: dark is the default (first block), light is the :root[data-theme='light'] override
  const lightStart = tokens.indexOf(":root[data-theme='light']");
  assert.ok(lightStart > 0);
  const dark = tokens.slice(0, lightStart);
  const light = tokens.slice(lightStart);
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [theme, block] of [['light', light], ['dark', dark]]) {
    const warn = pick(block, '--color-warn');
    const bg = pick(block, '--color-bg-raised') || pick(block, '--color-surface');
    assert.ok(warn && bg, `${theme}: tokens found`);
    assert.ok(ratio(warn, bg) >= 3, `${theme}: the amber icon on the tray is ${ratio(warn, bg).toFixed(2)}:1 (needs 3:1)`);
  }
});
