import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { buildTray, RING, shortReasons } from './trayModel.js';
import { describeTransferError } from './transferRules.js';
import { describeEvent, iconKind } from './activityText.js';
import { runImport } from './zipImport.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let ui;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import QuarantineList from './components/QuarantineList.jsx';
    import ReleaseDialog, { matchesReleaseWord } from './components/ReleaseDialog.jsx';
    import Sidebar from './components/Sidebar.jsx';
    import { scanLine } from './components/DetailsPanel.jsx';
    import { quarantineCount } from './services/quarantineCount.js';
    import { TransferTrayView } from './components/TransferTrayView.jsx';
    import { buildTray } from './utils/trayModel.js';
    export { matchesReleaseWord, scanLine, quarantineCount };
    export const list = (props) => renderToStaticMarkup(createElement(QuarantineList, props));
    export const dialog = (props) => renderToStaticMarkup(createElement(ReleaseDialog, { onCancel() {}, onConfirm() {}, ...props }));
    export const sidebar = (props, held = 0) => {
      quarantineCount.set(held);
      return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/files'] }, createElement(Sidebar, { onClose() {}, onToggleCollapsed() {}, version: 0, ...props })));
    };
    export const tray = (rows, props = {}) => renderToStaticMarkup(createElement(TransferTrayView, { model: buildTray({ rows, announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }), dismissMs: 45000, ...props }));
  `;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-quarantine-'));
  const file = path.join(dir, 'ui.cjs');
  fs.writeFileSync(file, js.text);
  ui = createRequire(import.meta.url)(file);
  fs.rmSync(dir, { recursive: true, force: true });
});

const reason = (code, text = `${code} in plain words.`) => ({ code, text });
const item = (patch = {}) => ({ id: 'a1', name: 'form.pdf', folder: 'root', size: 2048, heldAt: '2026-10-16T01:00:00Z', severity: 'medium', reasons: [reason('PDF_ACTIVE')], ...patch });

// ---------- the page: every state ----------

test('loading: a skeleton with a status role, no rows', () => {
  const html = ui.list({ state: 'loading' });
  assert.match(html, /data-testid="quarantine-loading"/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /quarantine-row/);
});

test('error: the message in an alert with "Try again"', () => {
  const html = ui.list({ state: 'error', error: 'Could not load the held files.' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load the held files\./);
  assert.match(html, />Try again</);
});

test('empty: "Nothing is held. Every upload so far looked fine."', () => {
  const html = ui.list({ state: 'empty' });
  assert.match(html, /data-testid="quarantine-empty"/);
  assert.match(html, /Nothing is held\./);
  assert.match(html, /Every upload so far looked fine\./);
  assert.match(ui.list({ state: 'list', items: [] }), /Nothing is held\./, 'an empty list is the empty state');
});

test('list: name, size, date, a severity chip and the reasons in plain words, with Release and Delete', () => {
  const html = ui.list({
    state: 'list',
    items: [item(), item({ id: 'b2', name: 'macro.docm', severity: 'high', reasons: [reason('OFFICE_MACRO'), reason('TYPE_MISMATCH')] }), item({ id: 'c3', name: 'odd.txt', severity: 'low', reasons: [reason('TYPE_MISMATCH')] })],
  });
  assert.equal((html.match(/data-testid="quarantine-row"/g) || []).length, 3);
  assert.match(html, /data-severity="medium"[\s\S]*Medium/);
  assert.match(html, /data-severity="high"[\s\S]*High/);
  assert.match(html, /data-severity="low"[\s\S]*Low/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, /Held [A-Z][a-z]{2} \d{1,2}, 2026/);
  assert.match(html, /OFFICE_MACRO in plain words\./);
  assert.match(html, /aria-label="Release form\.pdf"/);
  assert.match(html, /aria-label="Delete form\.pdf"/);
  assert.match(html, /aria-label="Why it is held"/);
});

test('a 255-character name is cut in the middle (head and tail) with the whole name as the tooltip', () => {
  const name = `${'x'.repeat(250)}.pdf`;
  const html = ui.list({ state: 'list', items: [item({ name })] });
  assert.ok(html.includes(`title="${name}"`));
  assert.match(html, /_head" aria-hidden="true">x+<\/span><span class="[^"]*_tail"/);
});

test('while one is being handled its buttons are disabled', () => {
  const html = ui.list({ state: 'list', items: [item()], busyId: 'a1' });
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
});

// ---------- the release dialog ----------

test('the release dialog explains the risk and keeps the button off until the word RELEASE is typed', () => {
  const closed = ui.dialog({ item: item() });
  assert.match(closed, /role="dialog"/);
  assert.match(closed, /Release this file\?/);
  assert.match(closed, /PDF_ACTIVE in plain words\./);
  assert.match(closed, /Warden cannot tell for sure whether this file is harmful/);
  assert.match(closed, /Only release a file you trust\./);
  assert.match(closed, /Type RELEASE to confirm/);
  assert.match(closed, /data-action="confirm-release"[^>]*>/);
  assert.match(closed, /<button type="submit"[^>]*disabled=""[^>]*>Release file/, 'off while nothing is typed');
  assert.match(ui.dialog({ item: item(), initialValue: 'release' }), /<button type="submit"[^>]*disabled=""/, 'the word is in capitals');
  assert.match(ui.dialog({ item: item(), initialValue: 'RELEAS' }), /<button type="submit"[^>]*disabled=""/);
  const ready = ui.dialog({ item: item(), initialValue: 'RELEASE' });
  assert.doesNotMatch(ready, /<button type="submit"[^>]*disabled=""/, 'on once the word matches');
  assert.doesNotMatch(ui.dialog({ item: item(), initialValue: '  RELEASE ' }), /<button type="submit"[^>]*disabled=""/, 'spaces around it do not count');
  assert.match(ui.dialog({ item: item(), initialValue: 'RELEASE', busy: true }), /disabled=""[^>]*>Releasing…/);
  assert.match(ui.dialog({ item: item(), error: 'Could not release that file.' }), /role="alert"[^>]*>Could not release that file\./);
});

test('matchesReleaseWord is exact', () => {
  for (const [typed, ok] of [['RELEASE', true], [' RELEASE ', true], ['release', false], ['Release', false], ['RELEASED', false], ['', false], [null, false]]) assert.equal(ui.matchesReleaseWord(typed), ok, String(typed));
});

// ---------- the sidebar badge ----------

for (const [label, props] of [['expanded', {}], ['collapsed', { collapsed: true }], ['drawer', { drawer: true, open: true }]]) {
  test(`sidebar badge, ${label}: the count shows on Quarantine when something is held and is gone when nothing is`, () => {
    const withBadge = ui.sidebar(props, 3);
    assert.match(withBadge, /href="\/quarantine"[^>]*>[\s\S]*?data-testid="quarantine-badge"[^>]*>3</);
    assert.equal((withBadge.match(/data-testid="quarantine-badge"/g) || []).length, 1);
    assert.doesNotMatch(ui.sidebar(props, 0), /quarantine-badge/);
    // still between Emergency Access and Trash, in the same group
    const order = [...withBadge.matchAll(/href="(\/[a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order.slice(order.indexOf('/emergency-access'), order.indexOf('/trash') + 1), ['/emergency-access', '/quarantine', '/trash']);
  });
}

test('the badge is only memory, resets for another session, and rides on an answer the app already asks for', () => {
  const store = strip(read('services/folderStyles.js'));
  assert.match(store, /subscribeToken\(\(\) => \{\s*setFolderStyles\(\{\}\);\s*quarantineCount\.set\(0\);/);
  assert.doesNotMatch(store, /localStorage|sessionStorage|indexedDB/);
  assert.match(strip(read('services/documentsService.js')), /if \(path === ''\) quarantineCount\.set\(data\?\.heldCount\);/);
  assert.doesNotMatch(strip(read('components/Sidebar.jsx')), /api\.|fetch\(|listHeld/, 'the sidebar asks for nothing of its own');
});

// ---------- the transfer tray ----------

const row = (patch) => ({ id: 1, kind: 'upload', name: 'form.pdf', size: 2000, phase: 'sealed', state: 'done', bytesDone: 2000, error: null, destination: '', resultId: 'x', savedAs: null, ...patch });

test('tray, held: amber "Held for review" with the reason and a way to Quarantine', () => {
  const html = ui.tray([row({ held: ['PDF_ACTIVE'] })]);
  assert.match(html, /data-ring="held"/);
  assert.match(html, /Held for review: PDF with active content/);
  assert.match(html, /data-action="show" data-target="\/quarantine"/);
  assert.match(html, />Open Quarantine</);
  assert.doesNotMatch(html, /countdown/, 'a held file keeps the tray open until it is dismissed');
  assert.match(html, /1 file held for review/);
});

test('tray, refused: red "Not saved" with the short reason, no Retry', () => {
  const html = ui.tray([row({ phase: 'failed', state: 'failed', error: { message: 'Not saved', refused: true, retryable: false, reasons: ['KNOWN_TEST_SIGNATURE'] } })]);
  assert.match(html, /data-ring="refused"/);
  assert.match(html, /Not saved: antivirus test file/);
  assert.doesNotMatch(html, /data-action="retry"/);
  assert.match(html, /1 not saved/);
});

test('tray titles: "Sealed 2, 1 held", "Sealed 1, 1 not saved", "2 files held for review"; the old ones are unchanged', () => {
  const title = (rows) => buildTray({ rows, announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }).title;
  const refused = (id) => row({ id, phase: 'failed', error: { refused: true, reasons: ['EXECUTABLE_CONTENT'], retryable: false } });
  assert.equal(title([row({ id: 1 }), row({ id: 2 }), row({ id: 3, held: ['OFFICE_MACRO'] })]), 'Sealed 2, 1 held for review');
  assert.equal(title([row({ id: 1 }), refused(2)]), 'Sealed 1, 1 not saved');
  assert.equal(title([row({ id: 1, held: ['PDF_ACTIVE'] }), row({ id: 2, held: ['PDF_ACTIVE'] })]), '2 files held for review');
  assert.equal(title([row({ id: 1 }), row({ id: 2, phase: 'failed', error: { message: 'Network error', retryable: true } })]), 'Sealed 1, 1 failed');
  assert.equal(title([row({ id: 1 }), row({ id: 2 })]), '2 files sealed');
  assert.equal(buildTray({ rows: [row({})], announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }).autoDismiss, true);
  assert.equal(RING.HELD, 'held');
  assert.equal(RING.REFUSED, 'refused');
});

test('short reasons: one word-group, "and N more" for several, nothing for an unknown code', () => {
  assert.equal(shortReasons(['OFFICE_MACRO']), 'contains macros');
  assert.equal(shortReasons(['TYPE_MISMATCH', 'PDF_ACTIVE', 'DOUBLE_EXTENSION']), 'name and content do not match and 2 more');
  assert.equal(shortReasons(['NOPE']), '');
  assert.equal(shortReasons(undefined), '');
});

test('a refused upload is worded for the tray by the (lazy) runtime; the main code only reads the result', () => {
  const runtime = strip(read('services/transferRuntime.js'));
  assert.match(runtime, /code !== 'FILE_BLOCKED' && code !== 'VERSION_REFUSED' && code !== 'USE_IMPORT'/);
  assert.match(runtime, /error\.described = \{ message: 'Not saved'/);
  assert.match(runtime, /uploadDocument: watched\(uploadDocument\)/);
  assert.match(runtime, /uploadNewVersion: watched\(uploadNewVersion\)/);
  assert.deepEqual(describeTransferError({ described: { message: 'Not saved', refused: true } }), { message: 'Not saved', refused: true });
  // a refusal can never be retried, however it is worded
  assert.equal(buildTray({ rows: [row({ phase: 'failed', error: { refused: true, retryable: false, reasons: [] } })], announce: '' }, { status: 'idle', results: [], skipped: [], ignored: [] }).rows[0].actions.retry, false);
});

// ---------- the zip import counts ----------

test('zip import: each file is judged by the server; imported, held and refused are counted apart', async () => {
  const entries = ['ok.txt', 'risky.svg', 'bad.txt', 'plain.png'];
  const plan = { files: entries.map((name) => ({ entry: name, name, dir: '', size: 5 })), folders: [], ignored: [], skipped: [] };
  const zip = { file: () => ({ async: async () => new Uint8Array(5) }) };
  const JSZip = { loadAsync: async () => zip };
  const results = [];
  const uploadFile = async (file) => {
    if (file.name === 'risky.svg') return { id: 'h', held: true, reasons: [{ code: 'ACTIVE_MARKUP' }] };
    if (file.name === 'bad.txt') throw Object.assign(new Error('x'), { response: { status: 422, data: { error: { code: 'FILE_BLOCKED', reasons: [{ code: 'KNOWN_TEST_SIGNATURE' }] } } } });
    return { id: file.name, filename: file.name };
  };
  const out = await runImport({ bytes: new Uint8Array(1), plan, JSZip, uploadFile, createFolder: async () => {}, onResult: (r) => results.push(r), concurrency: 1 });
  assert.equal(out.uploaded, 2, 'only the clean files count as imported');
  assert.equal(out.held, 1);
  assert.deepEqual(results.map((r) => r.status), ['imported', 'held', 'refused', 'imported']);
  assert.deepEqual(results[1].reasons, ['ACTIVE_MARKUP']);
  assert.deepEqual(results[2].reasons, ['KNOWN_TEST_SIGNATURE']);
  assert.match(results[2].reason, /^Not saved/);
  assert.equal(out.failures.length, 1, 'a refused file is listed with the problems');
});

test('the import report on the Export / Import page counts imported, held and not saved, and links to Quarantine; Export says how many were left out', () => {
  const page = strip(read('pages/ExportPage.jsx'));
  assert.match(page, /outcomeText\(outcomeOf\(job\)\)/);
  assert.match(page, /import \{ filesLink, outcomeOf, outcomeText \}/);
  assert.match(page, /<Link to="\/quarantine">Review the held files<\/Link>/);
  assert.match(page, /title="Not saved"/);
  assert.match(page, /listHeld\(\)\.then\(\(data\) => data\.count, \(\) => 0\)/);
  assert.match(page, /held in Quarantine \{e\.heldLeftOut === 1 \? 'was' : 'were'\} left out of the zip/);
  assert.match(strip(read('services/importRuntime.js')), /if \(stored\?\.held\) quarantineCount\.bump\(1\)/);
});

// ---------- details and activity ----------

test('Details: "Scan: clean (rules v1, date)", "Not scanned", "Released after review", and the other states', () => {
  assert.match(ui.scanLine({ verdict: 'clean', version: 1, at: '2026-10-16T01:00:00Z', state: null }), /^Clean \(rules v1, [A-Z][a-z]{2} \d{1,2}, 2026\)$/);
  assert.equal(ui.scanLine(null), 'Not scanned');
  assert.equal(ui.scanLine({ verdict: 'suspicious', version: 1, at: '2026-10-16T01:00:00Z', state: 'released' }), 'Released after review');
  assert.match(ui.scanLine({ verdict: 'suspicious', version: 1, at: '2026-10-16T01:00:00Z', state: 'held' }), /^Held for review \(rules v1/);
  assert.match(ui.scanLine({ verdict: 'unchecked', version: 1, at: null, state: null }), /^Not scanned/);
  assert.match(strip(read('components/DetailsPanel.jsx')), /<Row label="Scan">\{scanLine\(details\.scan\)\}<\/Row>/);
});

test('the activity log has plain wording and an icon for the three new events', () => {
  assert.equal(describeEvent({ type: 'file_held', target: { kind: 'document', name: 'a.pdf' } }), "Held 'a.pdf' in Quarantine");
  assert.equal(describeEvent({ type: 'file_released', target: { kind: 'document', name: 'a.pdf' } }), "Released 'a.pdf'");
  assert.equal(describeEvent({ type: 'file_refused' }), 'Refused an upload');
  for (const type of ['file_held', 'file_released', 'file_refused']) assert.ok(iconKind(type));
});

// ---------- lazy loading and wording ----------

test('everything new is lazy: the page is its own chunk, and the main bundle imports only the badge store and the route', () => {
  const app = strip(read('App.jsx'));
  assert.match(app, /const QuarantinePage = lazy\(\(\) => import\('\.\/pages\/QuarantinePage\.jsx'\)\);/);
  assert.doesNotMatch(strip(read('components/Sidebar.jsx')), /QuarantinePage|QuarantineList|ReleaseDialog|quarantineService/);
  assert.doesNotMatch(strip(read('services/transfers.js')), /quarantine/i, 'the transfers manager (main bundle) knows nothing of Quarantine: its lazy runtime does');
});

test('no "sandbox" or "AI" in the Quarantine wording', () => {
  for (const file of ['components/QuarantineList.jsx', 'components/ReleaseDialog.jsx', 'pages/QuarantinePage.jsx', 'utils/trayModel.js', 'services/quarantineService.js']) {
    assert.doesNotMatch(strip(read(file)), /sandbox|\bAI\b/i, file);
  }
  assert.match(read('components/QuarantineList.jsx'), /Warden checks uploads with simple rules\. Files that look risky are held here until you decide\. This is not a full antivirus\./);
});

test('theme tokens only in the new styles', () => {
  for (const file of ['components/QuarantineList.module.css', 'components/ReleaseDialog.module.css', 'pages/QuarantinePage.module.css']) {
    assert.doesNotMatch(strip(read(file)), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, file);
  }
});
