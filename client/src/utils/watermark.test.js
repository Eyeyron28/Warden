import test from 'node:test';
import assert from 'node:assert/strict';

import { drawWatermark, formatSharedDate, isStampable, stampImageBlob, watermarkText, WATERMARK_HINT, PDF_DOWNLOAD_NOTE } from './watermark.js';

test('the watermark text is "<purpose> · shared <date> · Warden", and none without a purpose', () => {
  assert.equal(watermarkText({ purpose: 'For BDO account opening', sharedAt: '2026-10-09' }), 'For BDO account opening · shared Oct 9, 2026 · Warden');
  assert.equal(watermarkText({ purpose: '  Visa  ', sharedAt: '2026-01-31' }), 'Visa · shared Jan 31, 2026 · Warden');
  assert.equal(watermarkText({ purpose: 'Visa', sharedAt: '' }), 'Visa · shared · Warden');
  for (const none of [{}, { purpose: '' }, { purpose: '   ' }, { purpose: null }, { purpose: 5 }, undefined]) {
    assert.equal(watermarkText(none), null, JSON.stringify(none));
  }
  assert.equal(formatSharedDate('2026-10-09'), 'Oct 9, 2026');
  assert.equal(formatSharedDate('nope'), '');
});

test('only png, jpeg and webp downloads are stamped; gif, pdf and the rest are the original', async () => {
  assert.equal(isStampable('image/png'), true);
  assert.equal(isStampable('image/jpeg'), true);
  assert.equal(isStampable('image/webp'), true);
  assert.equal(isStampable('image/gif'), false);
  assert.equal(isStampable('application/pdf'), false);
  const original = new Blob(['x'], { type: 'application/pdf' });
  assert.equal(await stampImageBlob(original, 'application/pdf', 'text'), original);
  const png = new Blob(['x'], { type: 'image/png' });
  assert.equal(await stampImageBlob(png, 'image/png', null), png, 'no purpose, no change');
  // no canvas here (Node): it must fall back to the original and never throw
  assert.equal(await stampImageBlob(png, 'image/png', 'Visa · shared · Warden'), png);
});

test('the drawing tiles the text across the whole image, rotated, semi-transparent', () => {
  const calls = { fill: 0, stroke: 0, rotate: [], translate: [] };
  const ctx = {
    save() {}, restore() {},
    measureText: (text) => ({ width: text.length * 8 }),
    translate: (...args) => calls.translate.push(args),
    rotate: (angle) => calls.rotate.push(angle),
    fillText: () => { calls.fill += 1; },
    strokeText: () => { calls.stroke += 1; },
  };
  drawWatermark(ctx, 800, 600, 'Visa · shared Oct 9, 2026 · Warden');
  assert.ok(calls.fill > 20, 'many tiles');
  assert.equal(calls.fill, calls.stroke);
  assert.deepEqual(calls.translate, [[400, 300]]);
  assert.ok(calls.rotate[0] < 0, 'diagonal');
  assert.match(ctx.fillStyle, /^rgba\(.*0\.\d+\)$/, 'semi-transparent');
});

test('the wording promised to the owner', () => {
  assert.equal(WATERMARK_HINT, 'A watermark discourages reuse. It cannot stop a screenshot.');
  assert.equal(PDF_DOWNLOAD_NOTE, 'Watermark applies to preview and image downloads.');
});
