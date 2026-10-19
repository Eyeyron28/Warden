import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import api from '../services/api.js';
import { clearToken, setToken } from '../services/session.js';
import { invalidateAll } from '../services/dataCache.js';
import { THUMBNAIL_READY, renamedNotice, uploadDocument } from '../services/documentsService.js';
import { splitForEllipsis } from './ellipsis.js';
import { splitNamedTitle } from './namedTitle.js';
import { splitIntoBlocks } from './fileBlocks.js';
import { createSingleFlight } from './useSingleFlight.js';
import { newUploadKey } from './uuid.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = (file) => read(file).replace(/\r\n/g, '\n');
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeServer(answer = () => ({ id: 'doc1', filename: 'x.txt', nameChanged: false })) {
  const seen = [];
  api.defaults.adapter = async (config) => {
    seen.push({ key: `${String(config.method).toUpperCase()} ${config.url}`, data: config.data, signal: config.signal });
    return { data: answer(config), status: 201, statusText: 'Created', headers: {}, config };
  };
  return seen;
}

// ---------- names in a narrow place ----------

test('a long name is cut in the middle: the extension and a few characters before it stay, whole characters only', () => {
  const long = `${'a'.repeat(251)}.pdf`;
  const { head, tail } = splitForEllipsis(long);
  assert.equal(head + tail, long);
  assert.ok(tail.endsWith('.pdf') && tail.length <= 12, tail);
  assert.ok(head.length > 200);
  // a name without an extension keeps its last characters
  const bare = splitForEllipsis('x'.repeat(100));
  assert.equal(bare.tail.length, 8);
  // short names are left whole
  assert.deepEqual(splitForEllipsis('a.pdf'), { head: '', tail: 'a.pdf' });
  // Unicode: never split inside a character (emoji, Chinese, combining accents stay in one piece)
  const unicode = `${'履歴書'.repeat(30)}\u{1F4C4}final.pdf`;
  const parts = splitForEllipsis(unicode);
  assert.equal(parts.head + parts.tail, unicode);
  assert.ok(!/[\ud800-\udbff]$/.test(parts.head) && !/^[\udc00-\udfff]/.test(parts.tail), 'no half of a surrogate pair');
  assert.ok(parts.tail.endsWith('final.pdf'));
  assert.deepEqual(splitForEllipsis(''), { head: '', tail: '' });
});

test('a dialog title with a quoted name is split so the name can be cut; other titles are left alone', () => {
  assert.deepEqual(splitNamedTitle('Share "passport.pdf"'), { before: 'Share "', name: 'passport.pdf', after: '"' });
  assert.deepEqual(splitNamedTitle('Edit "Taxes"'), { before: 'Edit "', name: 'Taxes', after: '"' });
  assert.equal(splitNamedTitle('Upload file'), null);
  assert.equal(splitNamedTitle('Empty Trash?'), null);
  const quoted = splitNamedTitle('Rename "He said "hi".pdf"');
  assert.equal(quoted.name, 'He said "hi".pdf', 'a quote inside the name stays inside it');
  const long = `${'x'.repeat(255)}.pdf`;
  assert.equal(splitNamedTitle(`Share "${long}"`).name, long);
});

test('every dialog goes through ONE structure: a fixed header, a body that scrolls (never sideways) and may shrink, an optional footer', () => {
  const modal = strip(read('components/Modal.jsx'));
  assert.match(modal, /className=\{styles\.header\}/);
  assert.match(modal, /className=\{styles\.body\}/);
  assert.match(modal, /footer && <div className=\{styles\.footer\}>/);
  assert.match(modal, /splitNamedTitle\(title\)/);
  assert.match(modal, /<span className=\{styles\.titleName\}>\{named\.name\}<\/span>/);
  const style = css('components/Modal.module.css');
  const rule = (name) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(style)[1];
  assert.match(rule('dialog'), /display: flex;/);
  assert.match(rule('dialog'), /flex-direction: column;/);
  assert.match(rule('dialog'), /overflow: hidden;/, 'the dialog itself never scrolls');
  assert.match(rule('header'), /flex: none;/, 'the header stays');
  assert.match(rule('title'), /min-width: 0;/);
  assert.match(rule('title'), /white-space: nowrap;/);
  assert.match(rule('title'), /text-overflow: ellipsis;/);
  assert.match(rule('body'), /overflow-y: auto;/);
  assert.match(rule('body'), /overflow-x: hidden;/);
  assert.match(rule('body'), /min-height: 0;/);
  assert.match(rule('body'), /overflow-wrap: anywhere;/, 'a long unbroken name wraps');
  assert.match(rule('footer'), /flex: none;/, 'the footer stays');
  assert.match(style, /\.body > \* \{\s*min-width: 0;/, 'children can shrink');
  assert.match(rule('closeButton'), /min-height: 44px;/);
});

test('the Upload dialog shows the name with a middle ellipsis, the full name as tooltip and accessible name, and no sideways scroll', () => {
  const form = strip(read('components/UploadForm.jsx'));
  assert.match(form, /<FileNameLabel name=\{row\.file\.name\} \/>/);
  assert.match(form, /aria-label=\{`Remove \$\{shortName\(row\.file\.name\)\}`\}/);
  const style = css('components/UploadForm.module.css');
  assert.match(/\.fileButton \{([^}]*)\}/.exec(style)[1], /min-width: 0;/);
  assert.match(/\.rowName \{([^}]*)\}/.exec(style)[1], /min-width: 0;/);
  assert.match(/\.rows \{([^}]*)\}/.exec(style)[1], /overflow-y: auto;/);
  assert.match(css('components/FileNameLabel.module.css'), /\.head \{[^}]*text-overflow: ellipsis;/);
});

test('names shown in the other dialogs and cards wrap or are cut: Details, Move, Import, Toast and the notice under Upload', () => {
  assert.match(strip(read('components/DetailsPanel.jsx')), /<FileNameLabel name=\{name\} \/>/);
  assert.match(css('components/MoveModal.module.css'), /\.folderName \{[^}]*text-overflow: ellipsis;/);
  assert.match(css('pages/ExportPage.module.css'), /\.text,\n\.small,\n\.warning,\n\.error \{\s*overflow-wrap: anywhere;/);
  assert.match(css('components/Toast.module.css'), /\.message \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css('components/Modal.module.css'), /\.body :where\(p, span, li, label/);
});

// ---------- the Share dialog ----------

test('the Share dialog: landscape from 760 px (two columns, 90% height, up to 960 px), one column with the link first on a phone', () => {
  const modal = css('components/Modal.module.css');
  assert.match(/\.share \{([^}]*)\}/.exec(modal)[1], /max-width: min\(960px, calc\(100vw - 48px\)\);/);
  assert.match(/\.share \{([^}]*)\}/.exec(modal)[1], /max-height: min\(90vh/);
  const share = css('components/ShareModal.module.css');
  assert.match(/@media \(min-width: 760px\) \{\s*\.layout \{([^}]*)\}/.exec(share)[1], /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(/\.layout \{([^}]*)\}/.exec(share)[1], /grid-template-columns: minmax\(0, 1fr\);/, 'one column by default (a phone)');
  assert.match(share, /@media \(min-width: 760px\)[\s\S]*\.settingsCol,\n {2}\.linkCol \{[^}]*overflow-y: auto;/, 'a column scrolls on its own only when it must');
  const jsx = strip(read('components/ShareModal.jsx'));
  assert.match(jsx, /useMediaQuery\('\(min-width: 760px\)'\)/);
  assert.match(jsx, /wide \? \(\s*<>\s*\{settings\}\s*\{linkBlock\}\s*<\/>\s*\) : \(\s*<>\s*\{linkBlock\}\s*\{settings\}/, 'wide: settings then link; a phone: the link first, in the markup too');
  assert.match(jsx, /size="share"/);
  assert.match(jsx, /footer=\{footer\}/);
  for (const heading of ['Link settings', 'Your link']) assert.match(jsx, new RegExp(heading));
  // what lives where
  const settingsPart = jsx.slice(jsx.indexOf('const settings'), jsx.indexOf('const linkBlock'));
  for (const field of ['share-password', 'share-max-downloads', 'share-recipient', 'share-purpose', 'Link expires after']) assert.ok(settingsPart.includes(field), `${field} is in Link settings`);
  const linkPart = jsx.slice(jsx.indexOf('const linkBlock'), jsx.indexOf('const footer'));
  assert.match(linkPart, /<ShareActions/);
  assert.ok(!linkPart.includes('share-password'));
});

test('the Share dialog has no fixed widths, shrinkable children, 44 px buttons, a link field that ends in an ellipsis and a square QR that scales down', () => {
  const share = css('components/ShareModal.module.css');
  const actions = css('components/ShareActions.module.css');
  assert.doesNotMatch(share, /(?<!max-|min-)width: \d+px/, 'no fixed width in ShareModal.module.css');
  assert.match(/\.linkInput \{([^}]*)\}/.exec(actions)[1], /min-width: 0;/);
  assert.match(/\.linkInput \{([^}]*)\}/.exec(actions)[1], /text-overflow: ellipsis;/);
  assert.match(/\.qrFrame \{([^}]*)\}/.exec(actions)[1], /width: min\(100%, 100px\);/);
  assert.match(/\.qrFrame \{([^}]*)\}/.exec(actions)[1], /aspect-ratio: 1 \/ 1;/);
  assert.match(/\.appGrid \{([^}]*)\}/.exec(actions)[1], /repeat\(auto-fill, minmax\(min\(96px, 100%\), 1fr\)\)/, 'a wrapping grid');
  assert.match(actions, /\.appButton \{[^}]*min-height: 44px|min-height: 44px;[\s\S]*\.appButton/);
  assert.match(share, /\.presetButton,\n\.secondaryButton,\n\.generateButton[\s\S]*?min-height: 44px;/);
  const jsx = strip(read('components/ShareActions.jsx'));
  assert.match(jsx, /useState\(showQr\)/, 'the QR is already there on a wide screen');
  for (const app of ['WhatsApp', 'Telegram', 'Viber', 'Messenger']) assert.ok(strip(read('utils/shareLinks.js')).includes(app), app);
});

// ---------- one request per press ----------

test('a double click, Enter twice or two taps run the action once; it can run again when it has finished, and after a failure', async () => {
  const run = createSingleFlight();
  let calls = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => { calls += 1; resolve('done'); }, 20));
  const results = await Promise.all([run(slow), run(slow), run(slow)]);
  assert.equal(calls, 1);
  assert.deepEqual(results, ['done', undefined, undefined]);
  assert.equal(await run(slow), 'done', 'free again');
  assert.equal(calls, 2);
  await assert.rejects(() => run(async () => { throw new Error('fails'); }), /fails/);
  assert.equal(await run(async () => 'after a failure'), 'after a failure');
});

test('pressing "Encrypt & upload" twice in the same moment sends ONE request', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer();
  const run = createSingleFlight();
  const file = new File(['hello'], 'x.txt', { type: 'text/plain' });
  await Promise.all([run(() => uploadDocument({ file, preview: false })), run(() => uploadDocument({ file, preview: false })), run(() => uploadDocument({ file, preview: false }))]);
  assert.equal(seen.filter((call) => call.key === 'POST /documents').length, 1);
  clearToken();
});

test('every submit that creates something is guarded: Upload, Scan, new version, Import, Export / Import, New folder, Rename, Edit, Move, Share', () => {
  const form = strip(read('components/UploadForm.jsx'));
  assert.match(form, /if \(!summary\.canUpload \|\| lock\.current\) return;\s*lock\.current = true;/, 'a ref set before any await');
  assert.match(form, /aria-disabled=\{!summary\.canUpload \|\| undefined\}/);
  // an upload is handed to the transfer tray at once: the dialog has nothing left to submit twice
  assert.match(strip(read('pages/FilesPage.jsx')), /transfers\.enqueue\(accepted\.map\(\(file\) => \(\{ kind: 'upload', file, folder: currentPath, expiryDate \}\)\)\);\s*setUploadOpen\(false\);/);
  assert.match(strip(read('components/scan/ScanDialog.jsx')), /if \(saving\.current\) return;\s*saving\.current = true;/);
  assert.match(strip(read('components/DetailsVersions.jsx')), /onChange=\{\(event\) => run\(\(\) => choose\(event\)\)\}/);
  // an import is one app-level job, and starting a second while one runs is refused by the job itself
  assert.match(strip(read('pages/ExportPage.jsx')), /importJob\.startPrepared\(\)/);
  assert.match(strip(read('services/importJob.js')), /if \(state\.status === 'running'\) return \{ ok: false, message: BLOCKED_MESSAGE \};/);
  assert.match(strip(read('pages/ExportPage.jsx')), /guardExport\(startExport\)/);
  for (const file of ['components/NewFolderModal.jsx', 'components/RenameFolderModal.jsx', 'components/EditDocumentModal.jsx']) {
    assert.match(strip(read(file)), /run\(\(\) => handleSubmit\(event\)\)/, file);
  }
  assert.match(strip(read('components/MoveModal.jsx')), /runMove\(handleMove\)/);
  assert.match(strip(read('components/MoveModal.jsx')), /runCreate\(\(\) => handleCreate\(event\)\)/);
  assert.match(strip(read('components/ShareModal.jsx')), /if \(!canGenerate \|\| generating\.current\) return;\s*generating\.current = true;/);
});

test('the Upload dialog checks the file BEFORE it closes (a refusal stays next to the file) and then hands it to the tray', () => {
  const page = strip(read('pages/FilesPage.jsx'));
  assert.match(page, /const \{ accepted, rejected \} = await sortOut\(files\);[\s\S]*?if \(rejected\.length > 0\) \{\s*setUploadError\(rejected\[0\]\.reason\);\s*return;/);
  assert.match(page, /validateUpload\(file, \{ usage, pendingBytes: pending \}\)/);
  assert.match(page, /await getStorage\(\)/, 'against the real storage meter');
});

// ---------- the upload request itself ----------

test('each upload sends its own random UUID key, the file last, and no preview with it (the preview is drawn after the file is saved)', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer();
  await uploadDocument({ file: new File(['a'], 'a.txt'), folder: 'Taxes', preview: false });
  await uploadDocument({ file: new File(['b'], 'b.txt'), preview: false });
  const [first, second] = seen.map((call) => call.data);
  assert.ok(first instanceof FormData);
  assert.match(first.get('uploadKey'), UUID);
  assert.match(second.get('uploadKey'), UUID);
  assert.notEqual(first.get('uploadKey'), second.get('uploadKey'), 'a new attempt, a new key');
  assert.equal(first.get('folder'), 'Taxes');
  assert.equal(first.has('thumb'), false, 'nothing optional is made before the request');
  assert.deepEqual([...first.keys()].at(-1), 'file', 'the file goes last');
  assert.match(newUploadKey(), UUID);
  assert.notEqual(newUploadKey(), newUploadKey());
  clearToken();
});

test('an upload can be cancelled with an AbortSignal and the notice for a renamed file says what it was saved as', async () => {
  invalidateAll();
  setToken(TOKEN);
  const controller = new AbortController();
  const seen = fakeServer();
  await uploadDocument({ file: new File(['x'], 'x.txt'), signal: controller.signal, preview: false });
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(renamedNotice({ nameChanged: true, filename: 'report (1).pdf' }), 'A file with this name already exists. Saved as "report (1).pdf".');
  assert.equal(renamedNotice({ nameChanged: false, filename: 'report.pdf' }), '');
  assert.equal(renamedNotice(null), '');
  assert.equal(THUMBNAIL_READY, 'warden:thumbnail-ready');
  clearToken();
});

test('the preview is drawn after the response, never before the request; the page shows it when it is stored', () => {
  const service = strip(read('services/documentsService.js'));
  const upload = service.slice(service.indexOf('export async function uploadDocument'), service.indexOf('/** The sentence shown'));
  assert.doesNotMatch(upload.slice(0, upload.indexOf('const { data } = await')), /generateThumbnail/, 'not before the request');
  assert.match(upload, /drawPreviewLater\(file, data\.id\)/);
  assert.match(service, /MAX_QUEUED_PREVIEWS = 3/);
  assert.match(strip(read('pages/FilesPage.jsx')), /window\.addEventListener\(THUMBNAIL_READY, onReady\)/);
});

test('a name that got a number is shown in the tray row ("Sealed as ...") for uploads, Scan and folder uploads alike', () => {
  const model = strip(read('utils/trayModel.js'));
  assert.match(model, /Sealed as "\$\{t\.savedAs\}"/);
  assert.match(strip(read('services/transfers.js')), /savedAs: data\?\.nameChanged \? data\.filename : null/);
});

// ---------- folders and files as two blocks ----------

const folder = (name) => ({ key: `folder:${name}`, kind: 'folder', name });
const file = (id) => ({ key: `file:${id}`, kind: 'file', id });

test('the blocks: folders first, the Folders block hidden when there are none, counts are right, folders never among the files', () => {
  const mixed = [file(1), folder('Taxes'), file(2), folder('Health'), file(3)];
  const split = splitIntoBlocks(mixed);
  assert.deepEqual(split.folders.map((item) => item.name), ['Taxes', 'Health']);
  assert.deepEqual(split.files.map((item) => item.id), [1, 2, 3]);
  assert.equal(split.showFolders, true);
  assert.ok(split.files.every((item) => item.kind === 'file'));
  assert.equal(splitIntoBlocks([file(1), file(2)]).showFolders, false, 'hidden when there are no subfolders');
  const onlyFolders = splitIntoBlocks([folder('A')]);
  assert.equal(onlyFolders.files.length, 0);
  assert.equal(onlyFolders.showFolders, true);
  assert.deepEqual(splitIntoBlocks([]), { folders: [], files: [], showFolders: false, selectAllKeys: [] });
});

test('selecting files never selects folders: select-all covers the files only', () => {
  const split = splitIntoBlocks([folder('A'), file(1), file(2)]);
  assert.deepEqual(split.selectAllKeys, ['file:1', 'file:2']);
  assert.match(strip(read('pages/FilesPage.jsx')), /useSelection\(orderedKeys, blocks\.selectAllKeys\)/);
  const hook = strip(read('utils/useSelection.js'));
  assert.match(hook, /selectAll = useCallback\(\(\) => setState\(selectEvery\(allRef\.current\)\)/);
  assert.match(hook, /header: headerState\(allKeys\.filter/);
});

test('the Files page renders Folders then Files, as separate blocks, with a divider; tiles for folders; files keep the list or grid', () => {
  const page = strip(read('pages/FilesPage.jsx'));
  const folders = page.indexOf('id="folders-heading"');
  const files = page.indexOf('id="files-heading"');
  assert.ok(folders > 0 && files > folders, 'Folders above Files');
  assert.match(page, /\{folderItems\.length > 0 && \(\s*<section className=\{styles\.block\} aria-labelledby="folders-heading">/, 'hidden when there are none');
  assert.match(page, /<hr className=\{styles\.blockDivider\} \/>/);
  assert.match(page, /view="tiles"/);
  assert.match(page, /view=\{view\}/);
  assert.match(page, /Files <span className=\{styles\.blockCount\}>\{fileItems\.length\}<\/span>/);
  assert.match(page, /Folders <span className=\{styles\.blockCount\}>\{folderItems\.length\}<\/span>/);
  assert.match(page, /No files in this folder yet\./, 'the empty state sits under the Files heading');
  // dropping selected files on a folder tile still moves them: both lists carry the drop handler
  assert.equal((page.match(/onDropOnFolder=\{handleDropDocument\}/g) || []).length, 2);
  const browser = strip(read('components/FileBrowser.jsx'));
  assert.match(browser, /view === 'tiles'/);
  const style = css('components/FileBrowser.module.css');
  assert.match(/\.tiles \{([^}]*)\}/.exec(style)[1], /repeat\(auto-fill, minmax\(min\(100%, 220px\), 1fr\)\)/);
  assert.match(style, /@media \(max-width: 559px\) \{\s*\.tiles \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'two columns on a phone');
  const pages = css('pages/FilePages.module.css');
  assert.match(/\.blockDivider \{([^}]*)\}/.exec(pages)[1], /margin: var\(--space-4\) 0;/);
  // no request was added, and the progressive rendering stays in the browser component (files only needs it)
  assert.doesNotMatch(page, /useProgressiveList/);
});
