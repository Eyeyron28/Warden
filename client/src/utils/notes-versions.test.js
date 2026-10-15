import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import api from '../services/api.js';
import { invalidateAll, cacheSize } from '../services/dataCache.js';
import { clearToken, setToken } from '../services/session.js';
import {
  MAX_NOTE_CHARS,
  MAX_UPLOAD_BYTES,
  TOO_LARGE_MESSAGE,
  deleteDocumentVersion,
  fetchVersionBytes,
  getDocumentDetails,
  restoreDocumentVersion,
  setDocumentNote,
  uploadNewVersion,
} from '../services/documentsService.js';
import { describeEvent } from './activityText.js';
import { RETENTION } from '../components/site/retention.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const words = (file) => strip(read(file)).replace(/<[^>]+>/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ');
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(64)}`;

function fakeServer(answers = {}) {
  const seen = [];
  api.defaults.adapter = (config) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    let data = config.data;
    if (typeof data === 'string') data = JSON.parse(data);
    seen.push({ key, data, params: config.params });
    const body = typeof answers[key] === 'function' ? answers[key](seen.at(-1)) : answers[key] ?? {};
    return Promise.resolve({ data: body, status: 200, statusText: 'OK', headers: { 'content-disposition': 'attachment; filename="old.txt"' }, config });
  };
  return seen;
}

// ---------- the service calls ----------

test('a note is sent as text, or as null when it is empty or only spaces; the limit is the server\'s 2000', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({ 'PUT /documents/abc/note': (call) => ({ id: 'abc', hasNote: call.data.note !== null, note: call.data.note }) });
  assert.equal((await setDocumentNote('abc', 'Locker 14')).note, 'Locker 14');
  assert.equal((await setDocumentNote('abc', '   \n')).note, null);
  assert.equal((await setDocumentNote('abc', '')).note, null);
  assert.deepEqual(seen.map((call) => call.data), [{ note: 'Locker 14' }, { note: null }, { note: null }]);
  assert.equal(MAX_NOTE_CHARS, 2000);
  assert.equal(require('../../../server/controllers/notesVersions.controller.js').MAX_NOTE_CHARS, MAX_NOTE_CHARS, 'the same number as the server');
  clearToken();
});

test('saving a note, uploading a version, restoring and deleting are writes: they empty the page cache, so details are never stale', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({ 'GET /documents/abc/details': { id: 'abc', versions: [] } });
  const reread = async () => {
    await getDocumentDetails('abc');
    assert.equal(cacheSize(), 1);
  };
  await reread();
  await setDocumentNote('abc', 'x');
  assert.equal(cacheSize(), 0, 'a note');
  await reread();
  await restoreDocumentVersion('abc', 'v1');
  assert.equal(cacheSize(), 0, 'a restore');
  await reread();
  await deleteDocumentVersion('abc', 'v1');
  assert.equal(cacheSize(), 0, 'a deleted version');
  await reread();
  await uploadNewVersion('abc', new File(['new contents'], 'x.txt', { type: 'text/plain' }));
  assert.equal(cacheSize(), 0, 'a new version');
  assert.ok(seen.some((call) => call.key === 'POST /documents/abc/versions'));
  assert.ok(seen.some((call) => call.key === 'POST /documents/abc/versions/v1/restore'));
  assert.ok(seen.some((call) => call.key === 'DELETE /documents/abc/versions/v1'));
  clearToken();
});

test('a new version is checked against the same 4 MB cap in the browser before anything is sent, and carries the file', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer();
  const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.bin');
  await assert.rejects(() => uploadNewVersion('abc', big), (error) => error.response.status === 413 && error.response.data.error.message === TOO_LARGE_MESSAGE);
  assert.equal(seen.length, 0, 'nothing was sent');
  await uploadNewVersion('abc', new File(['hello'], 'x.txt', { type: 'text/plain' }));
  const form = seen[0].data;
  assert.ok(form instanceof FormData && form.get('file') instanceof Blob, 'multipart with the file');
  clearToken();
});

test('a previous version downloads as bytes with the name the server gave', async () => {
  invalidateAll();
  setToken(TOKEN);
  const seen = fakeServer({ 'GET /documents/abc/versions/v1/download': new Uint8Array([1, 2, 3]).buffer });
  const { bytes, filename } = await fetchVersionBytes('abc', 'v1');
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(filename, 'old.txt');
  assert.equal(seen.length, 1);
  clearToken();
});

test('the activity page words every new event, and never has a note to show', () => {
  for (const type of ['note_set', 'note_changed', 'note_cleared', 'version_created', 'version_restored', 'version_deleted']) {
    const text = describeEvent({ type, target: { kind: 'file', name: 'a.pdf' } });
    assert.ok(text !== 'Did something' && /a\.pdf/.test(text), type);
  }
});

// ---------- what the screens do ----------

test('the note box is plain text: a text box with a limit, a counter, Save and Clear, saved on blur, and the plain statement under it', () => {
  const notes = read('components/DetailsNotes.jsx');
  const code = strip(notes);
  assert.match(code, /<textarea/);
  assert.match(code, /maxLength=\{MAX_NOTE_CHARS\}/);
  assert.match(code, /\{text\.length\} \/ \{MAX_NOTE_CHARS\}/, 'a character counter');
  assert.match(code, /onBlur=\{\(\) => save\(text\)\}/, 'saves when the box loses focus');
  assert.match(code, />\s*Save\s*</);
  assert.match(code, />\s*Clear\s*</);
  assert.match(code, /return \(\) => \{[\s\S]*save\(typed\)/, 'what was typed is saved when the panel closes');
  // nothing here can turn the text into markup
  assert.doesNotMatch(code, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|marked|markdown|DOMPurify/i);
  assert.match(words('components/DetailsNotes.jsx'), /This note is encrypted with your vault key and is not searchable\./);
  assert.match(words('components/DetailsNotes.jsx'), /never added to a share link, and an emergency contact never sees it/);
});

test('the file list knows only that a note exists, never the note', () => {
  for (const file of ['components/FileBrowser.jsx', 'pages/FilesPage.jsx', 'pages/StarredPage.jsx', 'pages/RecentPage.jsx', 'components/DriveList.jsx']) {
    assert.doesNotMatch(strip(read(file)), /\b(doc|document|item\.document|summary)\.note\b/, `${file} does not read a note`);
  }
  const browser = strip(read('components/FileBrowser.jsx'));
  assert.match(browser, /item\.document\?\.hasNote && <NoteMarker \/>/);
  assert.match(browser, /aria-label="Has a private note"/, 'the marker has a text alternative');
  // and only the details panel takes the decrypted text
  assert.match(strip(read('components/DetailsPanel.jsx')), /note=\{details\.note\}/);
});

test('Versions: listed with date, size and device; Restore, Download and Delete; restore and delete ask first; hidden with none; the limits are shown', () => {
  const code = strip(read('components/DetailsVersions.jsx'));
  assert.match(code, /if \(!versions \|\| versions\.length === 0\) return null;/, 'hidden when there are none');
  assert.match(words('components/DetailsVersions.jsx'), /Versions are kept for/);
  assert.match(code, /up to \{limits\?\.max \?\? 3\} per file/);
  for (const action of ['Restore', 'Download', 'Delete']) assert.match(code, new RegExp(`aria-label=\\{\`${action} version`), action);
  assert.match(code, /setAsk\(\{ id: version\.id, action: 'restore' \}\)/);
  assert.match(code, /setAsk\(\{ id: version\.id, action: 'delete' \}\)/);
  // the calls to the server are made only from the confirm step (the part shown once something is being asked)
  const confirmStep = code.slice(code.indexOf('{asking ? ('), code.indexOf(') : ('));
  assert.match(confirmStep, /restoreDocumentVersion\(id, version\.id\)/);
  assert.match(confirmStep, /deleteDocumentVersion\(id, version\.id\)/);
  assert.doesNotMatch(code.replace(confirmStep, ''), /(restore|delete)DocumentVersion\(id/, 'nowhere else');
  assert.match(code, /formatManila\(version\.createdAt\)/);
  assert.match(code, /formatBytes\(version\.size\)/);
  assert.match(code, /version\.device/);
  // the panel is still its own chunk, and its new parts are inside it
  assert.match(strip(read('components/useDetailsPanel.jsx')), /lazy\(\(\) => import\('\.\/DetailsPanel\.jsx'\)\)/);
  const panel = strip(read('components/DetailsPanel.jsx'));
  assert.match(panel, /import DetailsNotes from '\.\/DetailsNotes\.jsx'/);
  assert.match(panel, /<DetailsVersions id=\{id\} versions=\{details\.versions\}/);
  assert.match(panel, /<UploadVersion id=\{id\}/);
});

test('"Upload new version" is in the file menu and the details panel, and notes and versions add no request to a page visit', () => {
  assert.match(strip(read('pages/FilesPage.jsx')), /label: 'Upload new version…'/);
  assert.match(strip(read('components/DetailsVersions.jsx')), /Upload new version/);
  // notes and versions ride on the details answer: the only new calls are user actions (a write), none on a page load
  const service = strip(read('services/documentsService.js'));
  assert.doesNotMatch(service, /documents\/\$\{id\}\/(versions|note)`\)\)\.data/, 'no read of notes or versions on their own');
  const prefetch = strip(read('services/prefetch.js'));
  assert.doesNotMatch(prefetch, /note|version/i, 'the first-screen prefetch is unchanged');
});

test('the export screen says notes and earlier versions are not in the zip', () => {
  assert.match(words('pages/ExportPage.jsx'), /private notes and earlier versions are not included/);
  // and the zip really is built from the current files only
  const zip = strip(read('utils/zipExport.js'));
  assert.doesNotMatch(zip, /note|version/i);
});

test('the privacy table names notes and versions; the landing page does not claim anything new', () => {
  const rows = Object.fromEntries(RETENTION.map((row) => [row.what, row.how]));
  assert.match(rows['Private notes on files'], /Until you delete them, or delete the file or your account/);
  assert.match(rows['Earlier versions of a file'], /30 days, up to 3 per file/);
  for (const file of ['pages/public/HomePage.jsx', 'pages/public/HomeBelow.jsx', 'pages/public/homeFaq.jsx']) {
    if (fs.existsSync(path.join(src, file))) assert.doesNotMatch(strip(read(file)), /private note|version history|earlier version/i, file);
  }
});
