import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import api from '../services/api.js';
import { invalidateAll, cacheSize } from '../services/dataCache.js';
import { clearToken, setToken } from '../services/session.js';
import { getFolderStyles } from '../services/folderStyles.js';
import {
  BATCH_SIZE,
  batchMoveDocuments,
  batchTrashDocuments,
  createFolder,
  getDocumentDetails,
  listFolderChildren,
  listRecent,
  renameFolder,
  setFolderStyle,
  starDocuments,
} from '../services/documentsService.js';
import { describeMove, idsFromDrag } from './dragMove.js';
import { COLOR_LABELS, FOLDER_COLORS, FOLDER_ICONS, ICON_LABELS, folderColorVar } from './folderStyle.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(64)}`;

/** A fake server: records every request and answers by route. */
function fakeServer(answers = {}) {
  const seen = [];
  api.defaults.adapter = (config) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    seen.push({ key, data: config.data ? JSON.parse(config.data) : undefined, params: config.params });
    const body = typeof answers[key] === 'function' ? answers[key](seen.at(-1)) : answers[key] ?? {};
    return Promise.resolve({ data: body, status: 200, statusText: 'OK', headers: {}, config });
  };
  return seen;
}

// ---------- the lists mirror the server's ----------

test('the colour and icon lists are the server\'s, and every colour has a value for dark and for light', () => {
  const server = require('../../../server/utils/folderStyle.js');
  assert.deepEqual([...FOLDER_COLORS], [...server.FOLDER_COLORS]);
  assert.deepEqual([...FOLDER_ICONS], [...server.FOLDER_ICONS]);
  assert.equal(FOLDER_COLORS.length, 8);
  assert.ok(FOLDER_ICONS.length >= 12);
  for (const id of FOLDER_COLORS) assert.ok(COLOR_LABELS[id], id);
  for (const id of FOLDER_ICONS) assert.ok(ICON_LABELS[id], id);
  const tokens = read('styles/tokens.css').replace(/\r\n/g, '\n');
  const [dark, light] = [tokens.slice(0, tokens.indexOf(":root[data-theme='light']")), tokens.slice(tokens.indexOf(":root[data-theme='light']"))];
  for (const id of FOLDER_COLORS) {
    assert.match(dark, new RegExp(`--folder-${id}: #[0-9a-f]{6};`), `dark ${id}`);
    assert.match(light, new RegExp(`--folder-${id}: #[0-9a-f]{6};`), `light ${id}`);
  }
  assert.equal(folderColorVar('blue'), 'var(--folder-blue)');
  assert.equal(folderColorVar('javascript:alert(1)'), undefined, 'only listed ids become a colour');
  assert.equal(folderColorVar(null), undefined);
});

// ---------- the service calls ----------

test('stars, batch move and batch trash go out 50 files at a time with a result for each; nothing is lost across batches', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({
    'POST /documents/star': (call) => ({ starred: call.data.starred, updatedCount: call.data.ids.length }),
    'POST /documents/batch/move': (call) => ({ destination: call.data.destination, movedCount: call.data.ids.length, results: call.data.ids.map((id) => ({ type: 'file', id, status: 'moved' })) }),
    'POST /documents/batch/trash': (call) => ({ trashedCount: call.data.ids.length, results: call.data.ids.map((id) => ({ id, status: 'trashed' })) }),
  });
  const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
  assert.equal(BATCH_SIZE, 50);
  assert.equal(await starDocuments(ids, true), 120);
  assert.deepEqual(seen.map((call) => call.data.ids.length), [50, 50, 20]);
  const moved = await batchMoveDocuments(ids, 'Taxes');
  assert.equal(moved.movedCount, 120);
  assert.equal(moved.results.length, 120);
  assert.equal(moved.destination, 'Taxes');
  const trashed = await batchTrashDocuments(ids);
  assert.equal(trashed.trashedCount, 120);
  assert.equal(seen.filter((call) => call.key === 'POST /documents/batch/move').length, 3);
  assert.ok(seen.every((call) => call.data.ids.length <= 50), 'never more than the server accepts');
  clearToken();
});

test('the details of a file are one request, kept in the page cache, and gone after any write', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({ 'GET /documents/abc/details': { id: 'abc', name: 'x.txt', activity: [] }, 'POST /documents/star': { starred: true, updatedCount: 1 } });
  await getDocumentDetails('abc');
  await getDocumentDetails('abc');
  assert.equal(seen.filter((call) => call.key === 'GET /documents/abc/details').length, 1, 'the second open is free');
  await starDocuments(['abc'], true);
  assert.equal(cacheSize(), 0, 'a write empties the cache, so the panel never shows a stale star');
  await getDocumentDetails('abc');
  assert.equal(seen.filter((call) => call.key === 'GET /documents/abc/details').length, 2);
  fakeServer({ 'GET /documents/recent': { retentionDays: 30, items: [] } });
  assert.deepEqual(await listRecent(), { retentionDays: 30, items: [] });
  clearToken();
});

test('a folder\'s look is sent only as colour and icon (null clears), alone or with a rename, and never as anything else', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({ 'POST /documents/folders': { name: 'x' }, 'PATCH /documents/folders': { path: 'x' } });
  await createFolder('Taxes', { color: 'blue', icon: 'receipt', evil: '<script>' });
  assert.deepEqual(seen[0].data, { name: 'Taxes', color: 'blue', icon: 'receipt' });
  await createFolder('Plain');
  assert.deepEqual(seen[1].data, { name: 'Plain' }, 'no look: nothing extra goes out');
  await setFolderStyle('Taxes', { color: 'rose' });
  assert.deepEqual(seen[2].data, { path: 'Taxes', color: 'rose' }, 'style only: no name');
  await setFolderStyle('Taxes', { color: null, icon: '' });
  assert.deepEqual(seen[3].data, { path: 'Taxes', color: null, icon: null }, 'back to the default look');
  await renameFolder('Taxes', 'Taxes 2026', { color: 'green' });
  assert.deepEqual(seen[4].data, { path: 'Taxes', name: 'Taxes 2026', color: 'green' });
  await renameFolder('Taxes', 'Renamed');
  assert.deepEqual(seen[5].data, { path: 'Taxes', name: 'Renamed' });
  clearToken();
});

test('the look of every styled folder arrives with the top-level folder answer (no extra request) and is forgotten with the session', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({
    'GET /documents/folders/children': (call) => (call.params.path === '' ? { path: '', folders: [], styles: { Taxes: { color: 'blue', icon: 'receipt' } } } : { path: call.params.path, folders: [] }),
  });
  await listFolderChildren('');
  assert.deepEqual(getFolderStyles(), { Taxes: { color: 'blue', icon: 'receipt' } });
  await listFolderChildren('Taxes');
  assert.deepEqual(getFolderStyles(), { Taxes: { color: 'blue', icon: 'receipt' } }, 'a deeper level does not replace the map');
  assert.equal(seen.length, 2);
  clearToken();
  assert.deepEqual(getFolderStyles(), {}, 'a different sign-in never sees the previous one\'s folders');
});

// ---------- dragging and the batch result text ----------

test('a drag carries one id or several; the batch answer becomes one line of text', () => {
  const event = (value) => ({ dataTransfer: { getData: () => value, types: ['application/x-warden-document'] } });
  assert.deepEqual(idsFromDrag(event('a1')), ['a1']);
  assert.deepEqual(idsFromDrag(event('a1, b2,c3')), ['a1', 'b2', 'c3']);
  assert.deepEqual(idsFromDrag(event('')), []);
  assert.deepEqual(describeMove({ movedCount: 2, destination: 'Taxes', results: [] }), { message: 'Moved 2 items to Taxes' });
  assert.deepEqual(describeMove({ movedCount: 1, destination: '', results: [] }), { message: 'Moved 1 item to My files' });
  assert.deepEqual(describeMove({ movedCount: 0, destination: 'T', results: [{ status: 'conflict', message: 'A file named "x" is already there.' }] }), { error: 'A file named "x" is already there.' });
  assert.deepEqual(describeMove({ movedCount: 0, destination: 'T', results: [{ status: 'unchanged', message: 'Already in this folder.' }] }), { message: 'Already in that folder' });
});

// ---------- the pieces are wired ----------

test('the file list offers star, details, folder looks, select-by-long-press and dragging the whole selection', () => {
  const browser = strip(read('components/FileBrowser.jsx'));
  assert.match(browser, /onToggleStar,\s*onShowDetails/);
  assert.match(browser, /<StarButton name=\{item\.name\} starred=\{item\.document\.starred\}/);
  assert.match(browser, /aria-pressed=\{Boolean\(starred\)\}/);
  assert.match(browser, /if \(selectable\) selection\.toggle\(item\.key\);\s*else openContext/, 'a long press selects on touch');
  assert.match(browser, /items\.filter\(\(entry\) => entry\.kind === 'file' && selection\.isSelected\(entry\.key\)\)/, 'the selection is dragged together');
  assert.match(browser, /<FolderGlyph icon=\{looks\[item\.path\]\?\.icon\}/);
  const page = strip(read('pages/FilesPage.jsx'));
  assert.match(page, /onToggleStar=\{toggleStarItem\}/);
  assert.match(page, /batchTrashDocuments\(plan\.looseIds\)/);
  assert.match(page, /batchMoveDocuments\(ids, folderItem\.path\)/);
  assert.match(page, /key: 'star'/, 'a Star action in the selection bar');
  assert.doesNotMatch(page, /Download as zip|downloadZip/, 'no zip of a selection: the export path only does the whole vault');
});

test('the sidebar tree and the list both accept dropped files; breadcrumbs and tiles show a folder\'s look', () => {
  const tree = strip(read('components/FolderTree.jsx'));
  assert.match(tree, /moveDroppedDocuments\(ids, folder\.path\)/);
  assert.match(tree, /<FolderGlyph icon=\{folder\.icon\} color=\{folder\.color\}/);
  assert.match(strip(read('components/FolderBreadcrumb.jsx')), /useFolderStyles\(\)/);
  assert.match(strip(read('components/Sidebar.jsx')), /to="\/recent"[\s\S]*to="\/starred"/);
});

test('the details panel is loaded only when opened, shows what it should, and never asks for a secret', () => {
  for (const file of ['pages/FilesPage.jsx', 'pages/StarredPage.jsx', 'pages/RecentPage.jsx', 'components/FileBrowser.jsx', 'App.jsx']) {
    assert.doesNotMatch(strip(read(file)), /import DetailsPanel|from '\.\.?\/components\/DetailsPanel/, `${file} must not import the panel statically`);
  }
  assert.match(strip(read('components/useDetailsPanel.jsx')), /lazy\(\(\) => import\('\.\/DetailsPanel\.jsx'\)\)/);
  const panel = strip(read('components/DetailsPanel.jsx'));
  for (const piece of ['Type', 'Size', 'Folder', 'Created', 'Modified', 'Expires on', 'Shared', 'Purpose', 'Fingerprint', 'Latest activity', 'What is this?', 'Copy', 'role="dialog"', 'useFocusTrap']) assert.ok(panel.includes(piece), piece);
  assert.match(panel, /getDocumentDetails\(id\)/, 'one call');
  assert.doesNotMatch(panel, /\bdetails\.(checksum|wrapped\w*|iv|authTag|encryptedBlob|storagePath|key)\b/i, 'no secret field is read (only the 12-character fingerprint)');
  const css = read('components/DetailsPanel.module.css');
  assert.match(css, /@media \(max-width: 719px\)[\s\S]*align-items: flex-end/, 'a bottom sheet on a phone');
});

test('the folder picker is two groups of real radio buttons, in both dialogs, with "default" first', () => {
  const picker = strip(read('components/FolderStylePicker.jsx'));
  assert.equal((picker.match(/type="radio"/g) || []).length, 4);
  assert.match(picker, /Default colour/);
  assert.match(picker, /Default icon/);
  assert.match(strip(read('components/NewFolderModal.jsx')), /<FolderStylePicker value=\{style\}/);
  assert.match(strip(read('components/RenameFolderModal.jsx')), /<FolderStylePicker value=\{style\}/);
  assert.match(strip(read('components/RenameFolderModal.jsx')), /styleChanged \? style : \{\}/, 'only a changed look is sent');
});

test('the icons are a separate chunk, so a folder with no look costs the main bundle nothing', () => {
  assert.match(strip(read('components/FolderGlyph.jsx')), /lazy\(\(\) => import\('\.\/FolderGlyphIcons\.jsx'\)\)/);
  assert.doesNotMatch(strip(read('components/FolderGlyph.jsx')), /IdentificationCard|GraduationCap/);
});

test('Starred and Recent add no request of their own: Starred reads the list My files loads, Recent is one call', () => {
  const prefetch = strip(read('services/prefetch.js'));
  assert.match(prefetch, /'\/starred': \(\) => \[listDocuments\(\), STATUS\(\)\]/);
  assert.match(prefetch, /'\/recent': \(\) => \[listRecent\(\), STATUS\(\)\]/);
  assert.match(prefetch, /'\/files': \(\) => \[listDocuments\(\), listFolders\(\), listFolderChildren\(''\), listExpiringDocuments\(\), getFrequentFiles\(\), STATUS\(\)\]/, 'My files asks for exactly what it did');
  const starred = strip(read('pages/StarredPage.jsx'));
  assert.match(starred, /listDocuments\(\)/);
  assert.doesNotMatch(starred, /listRecent|api\.get/);
  assert.match(strip(read('pages/RecentPage.jsx')), /Recent reaches back \{days\} days/, 'the empty state and the footer say how far back it goes');
  assert.match(strip(read('App.jsx')), /path="\/starred"[\s\S]*path="\/recent"/);
});

test('a landing page or privacy page claim did not change: neither mentions stars, Recent, details or folder colours', () => {
  for (const file of ['pages/public/HomePage.jsx', 'pages/public/HomeBelow.jsx', 'pages/public/PrivacyPage.jsx', 'pages/public/homeFaq.jsx']) {
    assert.doesNotMatch(strip(read(file)), /\bStarred\b|folder colou?rs?|details panel|\bRecent\b/i, file);
  }
});
