import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { filenameFromDisposition, sanitizeDownloadName } from './fileNames.js';

const require = createRequire(import.meta.url);
const server = require('../../../server/utils/fileNames.js');
const { NAMES } = require('../../../server/test/helpers/samples.js');

test('the browser reads the REAL name from what the server sends, not the ASCII fallback', () => {
  // The fallback comes first in the header; a naive parser stops there and saves "R_sum_ __.pdf".
  const header = server.contentDisposition('Résumé 履歴.pdf');
  assert.match(header, /^attachment; filename="R_sum_/);
  assert.equal(filenameFromDisposition(header), 'Résumé 履歴.pdf');
  for (const { name } of NAMES) {
    assert.equal(filenameFromDisposition(server.contentDisposition(name)), sanitizeDownloadName(name), JSON.stringify(name));
  }
});

test('plain and odd headers', () => {
  assert.equal(filenameFromDisposition('attachment; filename="a b.pdf"'), 'a b.pdf');
  assert.equal(filenameFromDisposition('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E5%B1%A5.pdf"), '履.pdf'.replace('履', '履'));
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A"), 'document', 'a broken escape falls back');
  assert.equal(filenameFromDisposition(undefined), 'document');
  assert.equal(filenameFromDisposition(''), 'document');
});
