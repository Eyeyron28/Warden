import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DOCX_UNCOMPRESSED, MAX_PREVIEW_BYTES, PREVIEW_MIME, sniffPreviewType } from './previewType.js';

const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)));
const pad = (n = 32) => Array.from({ length: n }, (_, i) => ((i * 7 + 3) % 200) + 20);

/** A structurally valid ZIP with these entry names (stored, empty bodies). */
function buildZip(names, { uncompressed = 0 } = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    new DataView(local.buffer).setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(24, uncompressed, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, names.length, true);
  view.setUint16(10, names.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return Uint8Array.from([...locals, ...centrals, eocd].flatMap((part) => [...part]));
}

test('images are recognised by their bytes, whatever they are called', () => {
  assert.deepEqual(sniffPreviewType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad())), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(sniffPreviewType(bytes([0xff, 0xd8, 0xff, 0xe0], pad())), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(sniffPreviewType(bytes('GIF89a', pad())), { kind: 'image', mime: 'image/gif' });
  assert.deepEqual(sniffPreviewType(bytes('RIFF', [1, 2, 3, 4], 'WEBP', pad())), { kind: 'image', mime: 'image/webp' });
});

test('pdf, audio and video', () => {
  assert.equal(sniffPreviewType(bytes('%PDF-1.7\n', pad())).mime, PREVIEW_MIME.pdf);
  assert.deepEqual(sniffPreviewType(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt ', pad())), { kind: 'audio', mime: 'audio/wav' });
  assert.equal(sniffPreviewType(bytes('ID3', [3, 0], pad())).kind, 'audio');
  assert.equal(sniffPreviewType(bytes('OggS', pad())).kind, 'audio');
  assert.equal(sniffPreviewType(bytes([0, 0, 0, 24], 'ftypM4A ', pad())).mime, 'audio/mp4');
  assert.equal(sniffPreviewType(bytes([0, 0, 0, 24], 'ftypisom', pad())).mime, 'video/mp4');
  assert.equal(sniffPreviewType(bytes([0x1a, 0x45, 0xdf, 0xa3], pad())).mime, 'video/webm');
});

test('a .docx is recognised inside its ZIP; .xlsx and .pptx get no preview', () => {
  const docx = buildZip(['[Content_Types].xml', 'word/document.xml', 'word/media/image1.png']);
  assert.deepEqual(sniffPreviewType(docx), { kind: 'docx', mime: null });
  assert.equal(sniffPreviewType(buildZip(['[Content_Types].xml', 'xl/workbook.xml'])).kind, 'none');
  assert.equal(sniffPreviewType(buildZip(['[Content_Types].xml', 'ppt/presentation.xml'])).kind, 'none');
  assert.equal(sniffPreviewType(buildZip(['a.txt'])).kind, 'none');
});

test('a docx that claims to inflate enormously is refused before any library sees it', () => {
  const bomb = buildZip(['[Content_Types].xml', 'word/document.xml'], { uncompressed: MAX_DOCX_UNCOMPRESSED });
  const result = sniffPreviewType(bomb);
  assert.equal(result.kind, 'none');
  assert.match(result.note, /too complex/);
});

test('a corrupt zip is not a docx', () => {
  const zip = buildZip(['[Content_Types].xml', 'word/document.xml']);
  assert.notEqual(sniffPreviewType(zip.slice(0, zip.length - 30)).kind, 'docx');
  assert.notEqual(sniffPreviewType(bytes('PK', [3, 4], pad())).kind, 'docx');
});

test('text is recognised; HTML, SVG and XML are never previewed', () => {
  assert.equal(sniffPreviewType(new TextEncoder().encode('# Notes\n\nplain markdown, **not** html\n')).kind, 'text');
  assert.equal(sniffPreviewType(new TextEncoder().encode('héllo wörld ✓')).kind, 'text');
  assert.equal(sniffPreviewType(new Uint8Array(0)).kind, 'text');
  for (const markup of [
    '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    '<?xml version="1.0"?><svg/>',
    '  \n<HTML><body>x</body></HTML>',
    'some text first\n<html><body>x</body></html>',
  ]) {
    assert.equal(sniffPreviewType(new TextEncoder().encode(markup)).kind, 'markup', markup);
  }
  assert.equal(sniffPreviewType(new TextEncoder().encode('﻿<svg onload=alert(1)>')).kind, 'markup');
  // Prose that only mentions tags is still plain text, shown as characters.
  assert.equal(sniffPreviewType(new TextEncoder().encode('# Notes\nUse <b>bold</b> and never <script>x</script> here.')).kind, 'text');
});

test('binary junk, NULs and invalid UTF-8 are not text', () => {
  assert.equal(sniffPreviewType(bytes('abc', [0], 'def')).kind, 'none');
  assert.equal(sniffPreviewType(Uint8Array.from([0xc3, 0x28, 0xa0, 0xa1, 0xff, 0xfe, 0x41, 0x42])).kind, 'none');
  assert.equal(sniffPreviewType(null).kind, 'none');
  assert.equal(sniffPreviewType('text').kind, 'none');
});

test('only an allowlist of types is ever used for a preview Blob', () => {
  assert.deepEqual(
    Object.values(PREVIEW_MIME).sort(),
    [
      'application/pdf', 'audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
      'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm',
    ].sort()
  );
  for (const mime of Object.values(PREVIEW_MIME)) assert.doesNotMatch(mime, /svg|html|xml|javascript/);
  assert.equal(MAX_PREVIEW_BYTES, 4 * 1024 * 1024);
});
