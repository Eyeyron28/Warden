import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadName, keepExtension, sanitizeDownloadName, sniffExtension, splitName, withSniffedExtension } from './fileNames.js';

const require = createRequire(import.meta.url);
const server = require('../../../server/utils/fileNames.js');
const { SAMPLES, NAMES } = require('../../../server/test/helpers/samples.js');

const here = path.dirname(fileURLToPath(import.meta.url));

test('the browser and the server name files identically for every sample and name', () => {
  for (const sample of SAMPLES) {
    const bytes = new Uint8Array(sample.bytes);
    assert.equal(sniffExtension(bytes), sample.sniff, `.${sample.ext} bytes`);
    assert.equal(sniffExtension(bytes), server.sniffExtension(sample.bytes));
    for (const { name } of NAMES) {
      assert.equal(downloadName(name, bytes), server.downloadName(name, sample.bytes), `${JSON.stringify(name)} / ${sample.ext}`);
    }
    assert.equal(downloadName('mod12', bytes), sample.sniff ? `mod12.${sample.sniff}` : 'mod12');
  }
  for (const { name } of NAMES) assert.equal(sanitizeDownloadName(name), server.sanitizeDownloadName(name));
});

test('splitting a name', () => {
  assert.deepEqual(splitName('report.final.v2.docx'), { base: 'report.final.v2', ext: 'docx' });
  assert.deepEqual(splitName('PHOTO.JPG'), { base: 'PHOTO', ext: 'JPG' });
  assert.deepEqual(splitName('.env'), { base: '.env', ext: '' });
  assert.deepEqual(splitName('mod12'), { base: 'mod12', ext: '' });
  assert.deepEqual(splitName('trailing.'), { base: 'trailing.', ext: '' });
  assert.deepEqual(splitName('Résumé 履歴.pdf'), { base: 'Résumé 履歴', ext: 'pdf' });
  assert.equal(splitName('version 1.5 final').ext, '', 'a tail with spaces is not an extension');
});

test('an extension is only ever added to a name that has none', () => {
  assert.equal(withSniffedExtension('mod12', 'pdf'), 'mod12.pdf');
  assert.equal(withSniffedExtension('mod12.pdf', 'pdf'), 'mod12.pdf');
  assert.equal(withSniffedExtension('photo.dat', 'png'), 'photo.dat');
  assert.equal(withSniffedExtension('mod12', null), 'mod12');
});

test('rename keeps the extension unless a different one is typed on purpose', () => {
  assert.equal(keepExtension('mod12.pdf', 'Module 12'), 'Module 12.pdf', 'only the base name typed');
  assert.equal(keepExtension('mod12.pdf', 'Module 12.pdf'), 'Module 12.pdf');
  assert.equal(keepExtension('mod12.pdf', 'Module 12.docx'), 'Module 12.docx', 'a deliberate change');
  assert.equal(keepExtension('mod12.pdf', 'Chapter 1.5'), 'Chapter 1.5.pdf', 'a number is not an extension');
  assert.equal(keepExtension('mod12.pdf', 'notes.'), 'notes', 'ending with a dot removes it');
  assert.equal(keepExtension('report.final.v2.docx', 'summary'), 'summary.docx');
  assert.equal(keepExtension('PHOTO.JPG', 'holiday'), 'holiday.JPG');
  assert.equal(keepExtension('mod12', 'week 1'), 'week 1', 'a file with no extension gets none invented');
  assert.equal(keepExtension('.env', 'config'), 'config');
  assert.equal(keepExtension('a.pdf', '  spaced  '), 'spaced.pdf');
  assert.equal(keepExtension('a.pdf', ''), '', 'empty stays empty (the dialog rejects it)');
});

test('every browser download path names files through the shared rules', () => {
  const src = path.join(here, '..');
  const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
  // Vault downloads use the name the server chose (extension recovered from the bytes).
  for (const file of ['pages/FilesPage.jsx', 'pages/PhotosPage.jsx']) {
    assert.match(read(file), /const \{ bytes, filename \} = await fetchDocumentBytes/, file);
    assert.doesNotMatch(read(file), /downloadBytes\(bytes, doc\.filename\)/, file);
  }
  assert.match(read('components/FilePreview.jsx'), /downloadBytes\(bytes, name \?\? doc\.filename\)/);
  // The service sanitises once more before saving; share links use the same functions as the vault.
  assert.match(read('services/documentsService.js'), /sanitizeDownloadName\(filename\)/);
  const share = read('pages/SharedDocumentPage.jsx');
  assert.match(share, /downloadName\(entry\.name, new Uint8Array\(plain\)\)/);
  assert.match(share, /saveBlobAs\(loaded\.url, loaded\.fileName\)/);
  assert.match(share, /saveBlobAs\(opened\.url, opened\.fileName\)/);
  assert.doesNotMatch(share, /saveBlobAs\([^,]+, entry\.name\)/);
  // The rename dialog applies the keep-the-extension rule.
  assert.match(read('components/EditDocumentModal.jsx'), /keepExtension\(document\.filename, filename\)/);
});
