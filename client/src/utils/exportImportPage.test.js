import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let render;
let isZipFile;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ImportDropZone, { isZipFile, NOT_A_ZIP } from './components/ImportDropZone.jsx';
    export { isZipFile, NOT_A_ZIP };
    export const render = (props) => renderToStaticMarkup(createElement(ImportDropZone, props));`;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-zone-'));
  const file = path.join(dir, 'zone.cjs');
  fs.writeFileSync(file, js.text);
  const loaded = createRequire(import.meta.url)(file);
  render = loaded.render;
  isZipFile = loaded.isZipFile;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idle: "Drag a .zip here" and a "Choose a .zip…" button that works from the keyboard (a real button)', () => {
  const html = render({});
  assert.match(html, /data-state="idle"/);
  assert.match(html, /Drag a \.zip here/);
  assert.match(html, /<button type="button"[^>]*>Choose a \.zip…<\/button>/);
  assert.match(html, /aria-label="Choose a \.zip to import"/, 'the file input keeps its name');
  assert.match(html, /accept="\.zip,application\/zip"/);
});

test('drag over: highlighted, and it says where to drop', () => {
  const html = render({ dragOver: true });
  assert.match(html, /data-state="dragover"/);
  assert.match(html, /Drop the \.zip here/);
});

test('chosen: the name and chips for files, size and folders; the choose button offers another zip', () => {
  const html = render({ chosen: { name: 'backup.zip', files: 48, size: '2.4 MB', folders: 6 } });
  assert.match(html, /data-state="chosen"/);
  assert.match(html, /backup\.zip/);
  assert.match(html, /<li>48 files<\/li>/);
  assert.match(html, /<li>2\.4 MB<\/li>/);
  assert.match(html, /<li>6 folders<\/li>/);
  assert.match(html, /Choose another \.zip…/);
  assert.match(render({ chosen: { name: 'a.zip', files: 1, size: '1 KB', folders: 1 } }), /<li>1 file<\/li>[\s\S]*<li>1 folder<\/li>/);
  assert.match(render({ chosen: { name: 'a.zip', files: 1, size: '1 KB', folders: 1 }, children: 'PROBLEMS' }), /PROBLEMS/, 'what was found in the zip is shown inside');
});

test('invalid: the message in an alert, the danger state, and the choose button is still there', () => {
  const html = render({ error: 'Only a .zip file can be imported. “notes.txt” is not one.' });
  assert.match(html, /data-state="invalid"/);
  assert.match(html, /role="alert"[^>]*>Only a \.zip file can be imported\. “notes\.txt” is not one\./);
  assert.match(html, /Choose a \.zip…/);
});

test('while an import runs the zone has no choose button and ignores drops', () => {
  const html = render({ disabled: true, dragOver: true });
  assert.doesNotMatch(html, /Choose a \.zip…/);
  assert.match(html, /data-state="idle"/, 'no highlight while it cannot take a zip');
});

test('only a .zip is taken: by extension (any case) or by its type; a text file, a picture and a nameless file are not', () => {
  assert.equal(isZipFile({ name: 'backup.zip' }), true);
  assert.equal(isZipFile({ name: 'BACKUP.ZIP' }), true);
  assert.equal(isZipFile({ name: 'download', type: 'application/zip' }), true);
  assert.equal(isZipFile({ name: 'x.zip.txt' }), false);
  assert.equal(isZipFile({ name: 'photo.jpg', type: 'image/jpeg' }), false);
  assert.equal(isZipFile({}), false);
});

test('the page is called Export / Import: the heading, the tab title, the sidebar and the one-sentence header', () => {
  const page = strip(read('pages/ExportPage.jsx'));
  assert.match(page, /<h1 className=\{styles\.title\}>Export \/ Import<\/h1>/);
  assert.match(page, /usePageMeta\('Export \/ Import'/);
  assert.match(page, /Take your files out as a zip, or bring a zip in\./);
  const sidebar = strip(read('components/Sidebar.jsx'));
  assert.match(sidebar, /label\('Export \/ Import'\)/);
  assert.match(sidebar, /tipFor\('Export \/ Import'\)/);
  assert.match(sidebar, /to="\/export"/, 'the route path is unchanged');
  assert.match(strip(read('App.jsx')), /path="\/export"/);
});

test('the old name is gone from what people read (the route path /export stays)', () => {
  for (const file of ['pages/AccountPage.jsx', 'pages/public/homeFaq.jsx', 'pages/public/HomeBelow.jsx']) {
    assert.doesNotMatch(strip(read(file)).replace(/Export \/ Import/g, ''), /\bExport\b(?! my files)/, file);
  }
});

test('Export card: three short lines, what is not included, the unencrypted warning and the Download button; nothing is loaded for counts', () => {
  const page = strip(read('pages/ExportPage.jsx'));
  assert.match(page, /Every file in My files, as it is now, with its original name\./);
  assert.match(page, /Your folders, empty ones too\./);
  assert.match(page, /Not included: Trash, share links, previews, private notes and earlier versions\./);
  assert.match(page, /<strong>The zip is not encrypted\.<\/strong> Anyone who gets the file can open it\./);
  assert.match(page, /Download all my files \(\.zip\)/);
  assert.doesNotMatch(page, /useEffect/, 'no extra request just to show counts');
});

test('Import card: three short bullets replace the paragraph, the Import button is the big one, the report is a grid item under it', () => {
  const page = strip(read('pages/ExportPage.jsx'));
  assert.match(page, /Each file follows the normal upload rules: storage limit, 4 MB per file\./);
  assert.match(page, /A name already in use gets a number added\./);
  assert.match(page, /It keeps running if you change page; progress is in the card at the bottom right\. Stopping does not undo files already imported\./);
  assert.match(page, /className=\{`\$\{styles\.primary\} \$\{styles\.big\}`\}/);
  assert.match(page, /className=\{styles\.report\}[\s\S]*<ImportReport job=\{job\} \/>/);
});

test('layout: stacked below 1000 px, two equal columns from 1000 px, the report under the Import card, theme tokens only', () => {
  const css = strip(read('pages/ExportPage.module.css'));
  assert.match(css, /\.grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*align-items: stretch;/);
  assert.match(css, /@media \(min-width: 1000px\) \{\s*\.grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.report \{\s*grid-column: 2;/);
  assert.match(css, /\.cardFoot \{[^}]*margin-top: auto;/, 'the buttons end on the same line in both cards');
  for (const file of ['pages/ExportPage.module.css', 'components/ImportDropZone.module.css']) {
    assert.doesNotMatch(strip(read(file)), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${file}: no hard-coded colors`);
  }
  const zone = strip(read('components/ImportDropZone.module.css'));
  assert.match(zone, /\.zone\[data-state='dragover'\]/);
  assert.match(zone, /prefers-reduced-motion: reduce/);
});

test('a zip that is not a .zip is refused with a clear message before anything is read; the export and import logic is untouched', () => {
  const page = strip(read('pages/ExportPage.jsx'));
  assert.match(page, /if \(!isZipFile\(file\)\) \{[\s\S]*NOT_A_ZIP\(file\.name\)/);
  assert.ok(page.indexOf('isZipFile(file)') < page.indexOf('file.arrayBuffer()'), 'checked before the bytes are read');
  assert.match(page, /buildExportZip\(\{/);
  assert.match(page, /importJob\.startPrepared\(\)/);
});
