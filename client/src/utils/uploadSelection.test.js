import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { MAX_FILES_PER_UPLOAD, addFiles, fileKey, overflowMessage, removeItem, rowError, submitLabel, summarize } from './uploadSelection.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MB = 1024 * 1024;
const f = (name, size = 1000, lastModified = 1) => ({ name, size, lastModified });
const many = (n, size = 1000) => Array.from({ length: n }, (_, i) => f(`file-${i + 1}.txt`, size, i));

// ---------- the model ----------

test('the limit is one constant: 10', () => {
  assert.equal(MAX_FILES_PER_UPLOAD, 10);
});

test('add: files become rows in order, each with its own check', () => {
  const { items, overflow, added } = addFiles([], many(3));
  assert.deepEqual(items.map((r) => r.file.name), ['file-1.txt', 'file-2.txt', 'file-3.txt']);
  assert.equal(new Set(items.map((r) => r.id)).size, 3);
  assert.equal(overflow, 0);
  assert.equal(added, 3);
  assert.ok(items.every((r) => r.error === ''));
});

test('limit: the first 10 are added, the rest are counted for a visible message, never dropped silently', () => {
  const { items, overflow } = addFiles([], many(13));
  assert.equal(items.length, 10);
  assert.equal(items.at(-1).file.name, 'file-10.txt');
  assert.equal(overflow, 3);
  assert.equal(overflowMessage(3), 'Only 10 files at a time. 3 were not added.');
  assert.equal(overflowMessage(1), 'Only 10 files at a time. 1 was not added.');
  assert.equal(overflowMessage(0), '');
  assert.equal(addFiles([], many(10)).overflow, 0);
  assert.equal(addFiles([], many(11)).overflow, 1);
});

test('"Choose more" appends while room is left, and counts the overflow against what is left', () => {
  const first = addFiles([], many(8)).items;
  const more = addFiles(first, [f('a.txt'), f('b.txt'), f('c.txt'), f('d.txt')]);
  assert.equal(more.items.length, 10);
  assert.equal(more.overflow, 2);
  assert.deepEqual(more.items.slice(0, 8).map((r) => r.id), first.map((r) => r.id), 'earlier rows keep their place and id');
  const full = addFiles(more.items, [f('z.txt')]);
  assert.equal(full.items.length, 10);
  assert.equal(full.overflow, 1);
});

test('remove frees a place for another file', () => {
  const { items } = addFiles([], many(10));
  const fewer = removeItem(items, items[3].id);
  assert.equal(fewer.length, 9);
  assert.ok(!fewer.some((r) => r.file.name === 'file-4.txt'));
  const again = addFiles(fewer, [f('new.txt')]);
  assert.equal(again.items.length, 10);
  assert.equal(again.overflow, 0);
  assert.equal(new Set(again.items.map((r) => r.id)).size, 10, 'ids stay unique');
});

test('an exact duplicate (name, size and last-modified time) shows "Already added" and is never sent twice; a different time or size is another file', () => {
  const first = addFiles([], [f('a.txt', 10, 5)]).items;
  const second = addFiles(first, [f('a.txt', 10, 5), f('a.txt', 10, 6), f('a.txt', 11, 5)]);
  assert.deepEqual(second.items.map((r) => r.error), ['', 'Already added', '', '']);
  assert.equal(second.duplicates, 1);
  assert.equal(summarize(second.items).valid.length, 3);
  // a duplicate inside the same batch of files
  const same = addFiles([], [f('b.txt', 1, 1), f('b.txt', 1, 1)]);
  assert.deepEqual(same.items.map((r) => r.error), ['', 'Already added']);
  assert.equal(fileKey(f('x', 1, 2)), fileKey(f('x', 1, 2)));
  assert.notEqual(fileKey(f('x', 1, 2)), fileKey(f('x', 1, 3)));
});

test('row errors: over 4 MB, an empty file, a name longer than 255 characters; a name already in the folder is fine', () => {
  assert.equal(rowError(f('big.bin', 4 * MB + 1)), 'Over 4 MB');
  assert.equal(rowError(f('exactly.bin', 4 * MB)), '');
  assert.equal(rowError(f('empty.txt', 0)), 'Empty file');
  assert.match(rowError(f('x'.repeat(256), 5)), /longer than 255/);
  assert.equal(rowError(f('report.pdf', 5)), '', 'the server adds "(1)" to a name that is taken');
  const { items } = addFiles([], [f('ok.txt'), f('big.bin', 5 * MB), f('empty.txt', 0)]);
  assert.deepEqual(items.map((r) => r.error), ['', 'Over 4 MB', 'Empty file']);
  assert.equal(summarize(items).valid.length, 1, 'rows with an error are skipped');
  assert.equal(items.length, 3, 'but stay visible');
});

test('quota: the valid files together must fit; the message says how much is left; nothing partial; error rows do not count', () => {
  const usage = { availableBytes: 3 * MB };
  const fits = summarize(addFiles([], [f('a', 1 * MB), f('b', 1 * MB)]).items, usage);
  assert.equal(fits.canUpload, true);
  assert.equal(fits.quotaMessage, '');
  const over = summarize(addFiles([], [f('a', 2 * MB), f('b', 2 * MB)]).items, usage);
  assert.equal(over.canUpload, false);
  assert.match(over.quotaMessage, /Not enough storage: this needs 4\.0 MB but only 3\.0 MB is free/);
  const withBig = summarize(addFiles([], [f('a', 2 * MB), f('huge', 9 * MB)]).items, usage);
  assert.equal(withBig.canUpload, true, 'the over-size row is not part of the batch');
  assert.match(summarize(addFiles([], [f('a', 1000)]).items, { availableBytes: 10 }).quotaMessage, /storage is full/);
  assert.equal(summarize(addFiles([], [f('a', 1000)]).items, null).canUpload, true, 'meter unknown: the server decides');
  // removing a file clears the message
  const rows = addFiles([], [f('a', 2 * MB), f('b', 2 * MB)]).items;
  assert.equal(summarize(removeItem(rows, rows[0].id), usage).canUpload, true);
});

test('counter and button: "3 of 10 files · 5.2 MB", and "Encrypt & upload" for one, "Encrypt & upload 3 files" for several, off with none', () => {
  const { items } = addFiles([], [f('a', 2 * MB), f('b', 2 * MB), f('c', 1.2 * MB)]);
  const s = summarize(items);
  assert.equal(s.counter, '3 of 10 files · 5.2 MB');
  assert.equal(s.canAddMore, true);
  assert.equal(summarize(addFiles([], many(10)).items).canAddMore, false);
  assert.equal(submitLabel(1), 'Encrypt & upload');
  assert.equal(submitLabel(3), 'Encrypt & upload 3 files');
  assert.equal(submitLabel(0), 'Encrypt & upload');
  assert.equal(summarize([]).canUpload, false);
  assert.equal(summarize(addFiles([], [f('e', 0)]).items).canUpload, false, 'only an error row: off');
});

// ---------- the dialog, rendered ----------

let render;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import UploadForm from './components/UploadForm.jsx';
    export const render = (props = {}) => renderToStaticMarkup(createElement(UploadForm, { onSubmit() {}, onCancel() {}, destinationLabel: 'My files', ...props }));`;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-upload-'));
  const file = path.join(dir, 'form.cjs');
  fs.writeFileSync(file, js.text);
  render = createRequire(import.meta.url)(file).render;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('empty: "Choose files", "or drop them here", the batch expiry label, and the button off', () => {
  const html = render();
  assert.match(html, />Choose files</);
  assert.match(html, /or drop them here/);
  assert.match(html, /<input[^>]*type="file"[^>]*multiple/);
  assert.match(html, /Expiry date for all files \(optional\)/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Encrypt &amp; upload</);
  assert.doesNotMatch(html, /upload-rows|upload-counter/);
});

test('one file: a row with name, size and a Remove button; the button reads "Encrypt & upload" and is on; "Choose more"', () => {
  const html = render({ initialFiles: [f('report.pdf', 2048)] });
  assert.equal((html.match(/data-testid="upload-row"/g) || []).length, 1);
  assert.match(html, /1 of 10 files · 2\.0 KB/);
  assert.match(html, /aria-label="Remove report\.pdf"/);
  assert.match(html, />Choose more</);
  assert.match(html, /<button type="submit"[^>]*>Encrypt &amp; upload<\/button>/);
  assert.doesNotMatch(html, /<button type="submit"[^>]*disabled/);
});

test('10 files: ten rows, "10 of 10", the limit reached, and the button counts them', () => {
  const html = render({ initialFiles: many(10) });
  assert.equal((html.match(/data-testid="upload-row"/g) || []).length, 10);
  assert.match(html, /10 of 10 files/);
  assert.match(html, /The limit is reached/);
  assert.match(html, />Encrypt &amp; upload 10 files</);
});

test('over the limit: the visible message "Only 10 files at a time. 3 were not added."', () => {
  const html = render({ initialFiles: many(10), initialOverflow: 3 });
  assert.match(html, /data-testid="upload-limit-message">Only 10 files at a time\. 3 were not added\./);
  assert.equal((render({ initialFiles: many(13) }).match(/data-testid="upload-row"/g) || []).length, 10, 'a 13-file selection shows ten rows');
});

test('error rows: the reason in the error style, the row still there, and not counted in the button', () => {
  const html = render({ initialFiles: [f('ok.txt'), f('big.bin', 5 * MB), f('empty.txt', 0)] });
  assert.equal((html.match(/data-error="true"/g) || []).length, 2);
  assert.match(html, />Over 4 MB</);
  assert.match(html, />Empty file</);
  assert.match(html, /<button type="submit"[^>]*>Encrypt &amp; upload<\/button>/, 'one valid file');
  assert.match(render({ initialFiles: [f('a', 5), f('a', 5)] }), />Already added</);
});

test('quota error: the message with the room left, and the upload button off', () => {
  const html = render({ initialFiles: [f('a', 2 * MB), f('b', 2 * MB)], initialUsage: { availableBytes: 3 * MB } });
  assert.match(html, /data-testid="upload-quota-message"[^>]*>Not enough storage: this needs 4\.0 MB but only 3\.0 MB is free/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Encrypt &amp; upload 2 files</);
});

test('a 255-character name: cut in the middle with the whole name as the tooltip; the rows scroll inside; nothing wider than the dialog', () => {
  const name = `${'n'.repeat(251)}.pdf`;
  const html = render({ initialFiles: [f(name, 10)] });
  assert.ok(html.includes(`title="${name}"`));
  assert.match(html, /_head" aria-hidden="true">n+<\/span><span class="[^"]*_tail"/);
  const css = fs.readFileSync(path.join(src, 'components/UploadForm.module.css'), 'utf8');
  assert.match(/\.rows \{([^}]*)\}/.exec(css)[1], /max-height: min\(26vh, 200px\);[\s\S]*overflow-y: auto;/);
  assert.match(/\.row \{([^}]*)\}/.exec(css)[1], /grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(/\.remove \{([^}]*)\}/.exec(css)[1], /width: 44px;[\s\S]*height: 44px;/);
});

// ---------- wiring ----------

test('the dialog hands the valid files over once, keeps the lock, announces politely, and never steals focus', () => {
  const form = strip(read('components/UploadForm.jsx'));
  assert.match(form, /onSubmit\(\{ files: summary\.valid\.map\(\(row\) => row\.file\), expiryDate \}\)/);
  assert.match(form, /lock\.current = true; \/\/ synchronous/);
  assert.match(form, /role="status" aria-live="polite"/);
  assert.match(form, /event\.key === 'Delete' \|\| event\.key === 'Backspace'/);
  assert.doesNotMatch(form, /autoFocus|\.focus\(\)/, 'no focus is moved except to keep the place after a removal');
  assert.match(form, /onDrop=\{[\s\S]*?event\.stopPropagation\(\);\s*setDragOver\(false\);/, 'a drop on the zone does not also reach the Files page behind the dialog');
  assert.match(form, /type="file"\s+multiple/);
  const page = strip(read('pages/FilesPage.jsx'));
  assert.match(page, /transfers\.enqueue\(accepted\.map\(\(file\) => \(\{ kind: 'upload', file, folder: currentPath, expiryDate \}\)\)\)/);
});

test('"Upload new version" stays one file; the limit constant lives with the dialog, not in the main bundle', () => {
  const version = strip(read('components/DetailsVersions.jsx'));
  assert.doesNotMatch(version, /multiple|MAX_FILES_PER_UPLOAD/);
  assert.doesNotMatch(strip(read('utils/transferRules.js')), /MAX_FILES_PER_UPLOAD/);
  assert.doesNotMatch(strip(read('App.jsx')) + strip(read('services/transfers.js')), /uploadSelection/);
});
