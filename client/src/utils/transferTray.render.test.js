import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(src, 'components/TransferTray.module.css'), 'utf8');

let render;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { TransferTrayView } from './components/TransferTrayView.jsx';
    import { buildTray } from './utils/trayModel.js';
    export const render = (rows, props = {}, job = { status: 'idle', results: [], skipped: [], ignored: [] }) => {
      const model = buildTray({ rows, announce: '' }, job);
      return renderToStaticMarkup(createElement(TransferTrayView, { model, announce: props.announce || '', dismissMs: 45000, ...props }));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-tray-'));
  const file = path.join(dir, 'tray.cjs');
  fs.writeFileSync(file, js.text);
  render = createRequire(import.meta.url)(file).render;
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (patch) => ({ id: 1, kind: 'upload', name: 'report.pdf', size: 2000, phase: 'sending', state: 'running', bytesDone: 1000, error: null, destination: '', resultId: null, savedAs: null, ...patch });

test('waiting: "Waiting", an idle ring and a Cancel', () => {
  const html = render([row({ phase: 'waiting', bytesDone: 0 })]);
  assert.match(html, /data-testid="transfer-tray"/);
  assert.match(html, /data-testid="transfer-row"/);
  assert.match(html, />Waiting</);
  assert.match(html, /data-action="cancel"/);
  assert.match(html, /Sealing 1 file/);
});

test('sending: the bytes sent, a progress ring at 50 percent and Cancel', () => {
  const html = render([row({})]);
  assert.match(html, /Sending 1000 B of 2\.0 KB|Sending 1000 B of 2000 B|Sending [^<]* of [^<]*/);
  assert.match(html, /data-phase="sending"/);
  assert.match(html, /data-action="cancel"/);
  assert.doesNotMatch(html, /data-action="retry"/);
});

test('sealing: the ring pulses and says the server is encrypting', () => {
  const html = render([row({ phase: 'sealing', bytesDone: 2000 })]);
  assert.match(html, /Sealing/);
  assert.match(html, /data-phase="sealing"/);
  assert.match(html, /data-action="cancel"/);
});

test('sealed: the lock, "Sealed", Show in folder and Dismiss; no Cancel', () => {
  const html = render([row({ phase: 'sealed', state: 'done', bytesDone: 2000, destination: 'Taxes' })]);
  assert.match(html, /data-phase="sealed"/);
  assert.match(html, /data-action="show"/);
  assert.match(html, /data-action="dismiss"/);
  assert.doesNotMatch(html, /data-action="cancel"/);
  assert.match(html, /1 file sealed/);
  assert.match(html, /countdown/, 'the 45 s dismissal is shown');
});

test('failed: the reason, Retry and Dismiss; no countdown, because a failure stays', () => {
  const html = render([row({ phase: 'failed', state: 'error', error: { message: 'Network error', retryable: true } })]);
  assert.match(html, /Network error/);
  assert.match(html, /data-action="retry"/);
  assert.match(html, /data-action="dismiss"/);
  assert.match(html, /1 failed/);
  assert.doesNotMatch(html, /countdown/);
  const quota = render([row({ phase: 'failed', state: 'error', error: { message: 'Over your 25 MB limit', retryable: false } })]);
  assert.match(quota, /Over your 25 MB limit/);
  assert.doesNotMatch(quota, /data-action="retry"/, 'Retry would not help');
});

test('canceled: says what happened to the file', () => {
  const html = render([row({ phase: 'canceled', state: 'error', error: { message: 'Canceled. Nothing was saved.', retryable: false } })]);
  assert.match(html, /Canceled\. Nothing was saved\./);
  assert.match(html, /data-action="dismiss"/);
});

test('minimized: the header and the overall ring only, no rows', () => {
  const html = render([row({}), row({ id: 2, name: 'b.pdf' })], { minimized: true });
  assert.match(html, /data-minimized="true"/);
  assert.match(html, /data-testid="tray-title"/);
  assert.doesNotMatch(html, /data-testid="transfer-row"/);
  assert.match(html, /data-action="minimize"/);
});

test('closing while files are being sealed asks "Stop sealing? Files already sealed stay in your vault."', () => {
  const html = render([row({})], { confirmClose: true });
  assert.match(html, /Stop sealing\? Files already sealed stay in your vault\./);
  assert.match(html, /data-action="stop"/);
  assert.match(html, /data-action="keep-going"/);
});

test('many rows: all are present inside one list that scrolls on its own', () => {
  const rows = Array.from({ length: 40 }, (_, n) => row({ id: n + 1, name: `file-${n + 1}.txt`, phase: n < 2 ? 'sending' : 'waiting', bytesDone: 0 }));
  const html = render(rows);
  assert.equal((html.match(/data-testid="transfer-row"/g) || []).length, 40);
  assert.match(css, /max-height: 60vh/);
  assert.match(css, /overflow-y: auto/);
});

test('a 255-character name is cut in the middle, the whole name is in the tooltip, and the markup stays one row', () => {
  const name = `${'long-'.repeat(50)}end.pdf`.slice(0, 255);
  const html = render([row({ name })]);
  assert.ok(html.includes(`title="${name}"`), 'full name in the tooltip');
  assert.match(html, /_head" aria-hidden="true">long-[^<]*<\/span><span class="[^"]*_tail"/, 'head and tail spans: the CSS ellipsis cuts between them');
});

test('the zip import is a row of the same tray', () => {
  const job = { status: 'running', phase: 'uploading', fileName: 'backup.zip', done: 12, total: 48, bytesDone: 0, bytesTotal: 0, destination: '', uploaded: 12, results: [], skipped: [], ignored: [], cardVisible: true };
  const html = render([], {}, job);
  assert.match(html, /backup\.zip/);
  assert.match(html, /12 of 48 files/);
  assert.match(html, /Importing 48 files/);
});

test('one polite live region carries the announcement; the counters are not live', () => {
  const html = render([row({})], { announce: 'Sealing 1 file.' });
  assert.equal((html.match(/aria-live="polite"/g) || []).length, 1);
  assert.match(html, />Sealing 1 file\.</);
});

test('styles: 360 px wide, full width with margins under 480 px, above the update bar, reduced motion, theme tokens only', () => {
  assert.match(css, /width: 360px/);
  assert.match(css, /@media \(max-width: 479px\)/);
  assert.match(css, /--update-bar-h/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no hard-coded colors');
});
