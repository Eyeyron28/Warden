import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPdf } from './pdfWriter.js';
import { LIMIT_BYTES, planScan } from './scanPlan.js';
import {
  FULL_CROP,
  MAX_SIDE,
  MIN_CROP,
  applyHandle,
  cleanScanName,
  clampCrop,
  cropToPixels,
  defaultScanName,
  documentFilter,
  fitWithin,
  isFullCrop,
  normalizeRotation,
  rotateCrop,
  rotatedSize,
} from './imageOps.js';
import { sniffPreviewType } from '../previewType.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64'
  )
);
const text = (bytes) => Buffer.from(bytes).toString('latin1');
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a photo is scaled so its longest side is at most about 2000 px, and never scaled up', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 2000, height: 1500 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1500, height: 2000 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.equal(MAX_SIDE, 2000);
  assert.deepEqual(fitWithin(1, 100000), { width: 1, height: 2000 });
});

test('rotation: quarter turns, and the size swaps on a turn of 90 or 270', () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.deepEqual(rotatedSize(400, 300, 90), { width: 300, height: 400 });
  assert.deepEqual(rotatedSize(400, 300, 180), { width: 400, height: 300 });
  assert.deepEqual(rotatedSize(400, 300, -90), { width: 300, height: 400 });
});

test('the crop stays inside the picture and keeps a minimum size, whatever is dragged', () => {
  for (const handle of ['move', 'nw', 'ne', 'sw', 'se']) {
    for (const [dx, dy] of [[5, 5], [-5, -5], [5, -5], [-5, 5], [0.3, -0.2]]) {
      const rect = applyHandle({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, handle, dx, dy);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9, `${handle} ${dx},${dy}: ${JSON.stringify(rect)}`);
      assert.ok(rect.w >= MIN_CROP - 1e-9 && rect.h >= MIN_CROP - 1e-9, `${handle}: not smaller than the minimum`);
    }
  }
  assert.deepEqual(clampCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
});

test('a corner moves only itself: the opposite corner stays, and "move" keeps the size', () => {
  const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const se = applyHandle(start, 'se', 0.1, 0.2);
  assert.ok(near(se.x, 0.2) && near(se.y, 0.2) && near(se.w, 0.5) && near(se.h, 0.6));
  const nw = applyHandle(start, 'nw', 0.1, 0.1);
  assert.ok(near(nw.x + nw.w, 0.6) && near(nw.y + nw.h, 0.6));
  const moved = applyHandle(start, 'move', 0.1, -0.1);
  assert.ok(near(moved.w, 0.4) && near(moved.h, 0.4) && near(moved.x, 0.3));
  assert.ok(applyHandle(start, 'move', 0.01, 0).x > start.x);
});

test('turning the picture takes the crop with it: four turns are the identity, and left undoes right', () => {
  const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.5 };
  let r = crop;
  for (let i = 0; i < 4; i += 1) r = rotateCrop(r, 'right');
  for (const key of Object.keys(crop)) assert.ok(near(r[key], crop[key]), key);
  const back = rotateCrop(rotateCrop(crop, 'right'), 'left');
  for (const key of Object.keys(crop)) assert.ok(near(back[key], crop[key]), key);
  const turned = rotateCrop(crop, 'right');
  assert.ok(near(turned.w, crop.h) && near(turned.h, crop.w));
  assert.ok(isFullCrop(FULL_CROP) && !isFullCrop({ x: 0, y: 0, w: 0.9, h: 1 }));
});

test('a crop in pixels is never empty and never outside the image', () => {
  assert.deepEqual(cropToPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 200, 100), { x: 50, y: 25, width: 100, height: 50 });
  const edge = cropToPixels({ x: 1, y: 1, w: 0.05, h: 0.05 }, 10, 10);
  assert.ok(edge.width >= 1 && edge.height >= 1 && edge.x + edge.width <= 10 && edge.y + edge.height <= 10);
});

const imageOf = (grays) => ({ width: grays.length, height: 1, data: Uint8ClampedArray.from(grays.flatMap((g) => [g, g, g, 255])) });
const channel = (image) => [...image.data].filter((_, index) => index % 4 === 0);

test('document mode: colour becomes gray, a dull page is stretched to white paper and black ink', () => {
  const page = imageOf([...Array(95).fill(150), ...Array(5).fill(90)]);
  documentFilter(page);
  assert.equal(Math.max(...channel(page)), 255, 'paper is white');
  assert.equal(Math.min(...channel(page)), 0, 'ink is black');
  const colour = { width: 3, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) };
  documentFilter(colour);
  for (let i = 0; i < 3; i += 1) assert.ok(colour.data[i * 4] === colour.data[i * 4 + 1] && colour.data[i * 4] === colour.data[i * 4 + 2]);
});

test('document mode threshold: with a level every pixel is pure black or pure white; 0 leaves the grays', () => {
  const gradient = imageOf(Array.from({ length: 100 }, (_, index) => index * 2 + 20));
  documentFilter(gradient, { threshold: 50 });
  assert.deepEqual([...new Set(channel(gradient))].sort((a, b) => a - b), [0, 255]);
  const smooth = imageOf(Array.from({ length: 100 }, (_, index) => index * 2 + 20));
  documentFilter(smooth, { threshold: 0 });
  assert.ok(new Set(channel(smooth)).size > 10, 'still grays');
  const flat = imageOf(Array(50).fill(128));
  documentFilter(flat);
  assert.equal(new Set(channel(flat)).size, 1, 'a flat picture is not stretched into noise');
});

test('the default name is "Scan YYYY-MM-DD HH.MM" and a typed name is made safe', () => {
  assert.equal(defaultScanName(new Date(2026, 9, 15, 14, 32)), 'Scan 2026-10-15 14.32');
  assert.equal(cleanScanName('  Passport / page: 1?.pdf '), 'Passport page 1');
  assert.equal(cleanScanName('///'), '');
  assert.equal(cleanScanName('x'.repeat(300)).length, 100);
});

test('the PDF starts with %PDF-, ends with %%EOF, and the apps own sniffing calls it a PDF', () => {
  const pdf = buildPdf([{ jpeg: JPEG, width: 1200, height: 1600 }]);
  assert.equal(text(pdf.slice(0, 5)), '%PDF-');
  assert.match(text(pdf.slice(-6)), /%%EOF\n$/);
  assert.deepEqual(sniffPreviewType(pdf), { kind: 'pdf', mime: 'application/pdf' });
});

test('the PDF has one page per picture, sized to its shape, with the JPEG embedded as it is', () => {
  const pdf = buildPdf([
    { jpeg: JPEG, width: 1500, height: 2000 },
    { jpeg: JPEG, width: 2000, height: 1000 },
    { jpeg: JPEG, width: 1000, height: 1000 },
  ]);
  const body = text(pdf);
  assert.match(body, /\/Type \/Pages \/Count 3 /);
  assert.equal((body.match(/\/Type \/Page /g) || []).length, 3);
  assert.equal((body.match(/\/Filter \/DCTDecode/g) || []).length, 3);
  const boxes = [...body.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((match) => [Number(match[1]), Number(match[2])]);
  assert.equal(boxes.length, 3);
  assert.ok(Math.abs(boxes[0][0] / boxes[0][1] - 0.75) < 0.01, 'portrait 3:4');
  assert.ok(Math.abs(boxes[1][0] / boxes[1][1] - 2) < 0.01, 'landscape 2:1');
  assert.ok(Math.abs(boxes[2][0] / boxes[2][1] - 1) < 0.01, 'square');
  assert.ok(boxes.every(([w, h]) => Math.abs(Math.max(w, h) - 842) < 0.1), 'the longest side is an A4 sheet');
  assert.ok(Buffer.from(pdf).includes(Buffer.from(JPEG)), 'the JPEG bytes are in there, untouched');
});

test('the cross-reference table is real: every offset points at its object, and startxref points at the table', () => {
  const pdf = buildPdf([{ jpeg: JPEG, width: 10, height: 20 }, { jpeg: JPEG, width: 20, height: 10 }]);
  const body = text(pdf);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(body)[1]);
  assert.equal(body.slice(startxref, startxref + 5), 'xref\n');
  const table = body.slice(startxref);
  assert.equal(Number(/xref\n0 (\d+)\n/.exec(table)[1]), 9, '1 catalog, 1 pages, 3 objects for each of 2 pages, plus the free entry');
  const entries = [...table.matchAll(/(\d{10}) (\d{5}) ([nf]) \n/g)];
  assert.equal(entries.length, 9);
  assert.equal(entries[0][3], 'f');
  entries.slice(1).forEach((entry, index) => {
    assert.equal(entry[3], 'n');
    assert.equal(body.slice(Number(entry[1]), Number(entry[1]) + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`, `object ${index + 1}`);
  });
  assert.match(body, /\/Size 9 \/Root 1 0 R/);
  for (const match of body.matchAll(/\/Length (\d+)[^>]*>>\nstream\n/g)) {
    const end = match.index + match[0].length + Number(match[1]);
    assert.ok(body.slice(end).startsWith('\nendstream') || body.slice(end).startsWith('endstream'), `stream at ${match.index}`);
  }
});

test('the PDF writer refuses what is not a JPEG, and an empty list', () => {
  assert.throws(() => buildPdf([]), /at least one page/);
  assert.throws(() => buildPdf([{ jpeg: new Uint8Array([1, 2, 3, 4, 5]), width: 1, height: 1 }]), /not a JPEG/);
});

test('pdf.js itself opens the PDF and finds every page, at the shape asked for', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = buildPdf([{ jpeg: JPEG, width: 1500, height: 2000 }, { jpeg: JPEG, width: 2000, height: 1500 }]);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  assert.equal(doc.numPages, 2);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const second = (await doc.getPage(2)).getViewport({ scale: 1 });
  assert.ok(Math.abs(first.width / first.height - 0.75) < 0.01);
  assert.ok(Math.abs(second.width / second.height - 4 / 3) < 0.01);
  await doc.destroy();
});

const fakeEncode = (sizes) => async (index, quality) => {
  const bytes = new Uint8Array(3 + Math.round(sizes[index] * quality));
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
};
const sizeOf = () => ({ width: 100, height: 100 });

test('a scan that fits is saved at the first quality, 0.85', async () => {
  const plan = await planScan({ count: 2, format: 'pdf', encode: fakeEncode([100_000, 100_000]), sizeOf });
  assert.equal(plan.ok, true);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].quality, 0.85);
  assert.equal(plan.files[0].type, 'application/pdf');
});

test('too big at 0.85 steps the quality down until it fits, and the result is under the cap', async () => {
  const plan = await planScan({ count: 3, format: 'pdf', encode: fakeEncode([2_000_000, 2_000_000, 2_000_000]), sizeOf });
  assert.equal(plan.ok, true);
  assert.equal(plan.files[0].quality, 0.65);
  assert.ok(plan.files[0].bytes.length <= LIMIT_BYTES);
});

test('when even the lowest quality does not fit, it says so and says whether separate files would fit: never a silent failure', async () => {
  const many = await planScan({ count: 5, format: 'pdf', encode: fakeEncode(Array(5).fill(5_000_000)), sizeOf });
  assert.equal(many.ok, false);
  assert.equal(many.reason, 'too_large');
  assert.equal(many.pages, 5);
  assert.equal(many.separateWouldFit, true, 'each page alone (5 MB x 0.65 = 3.2 MB) would fit');
  const hopeless = await planScan({ count: 2, format: 'pdf', encode: fakeEncode([30_000_000, 30_000_000]), sizeOf });
  assert.equal(hopeless.ok, false);
  assert.equal(hopeless.separateWouldFit, false);
  const images = await planScan({ count: 2, format: 'images', encode: fakeEncode([100_000, 30_000_000]), sizeOf });
  assert.equal(images.ok, false);
  assert.equal(images.failedPage, 2);
});

test('separate images: one JPEG per page, each at its own best quality, named by page when there are several', async () => {
  const plan = await planScan({ count: 2, format: 'images', encode: fakeEncode([100_000, 5_000_000]), sizeOf });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files.map((file) => [file.suffix, file.type, file.quality]), [[' page 1', 'image/jpeg', 0.85], [' page 2', 'image/jpeg', 0.75]]);
  const single = await planScan({ count: 1, format: 'images', encode: fakeEncode([100_000]), sizeOf });
  assert.equal(single.files[0].suffix, '');
  await assert.rejects(() => planScan({ count: 0, format: 'pdf', encode: fakeEncode([]), sizeOf }), /no pages/);
});

test('the scanner uses a file input with the camera hint, never getUserMedia, and stores nothing', () => {
  const files = ['components/scan/ScanDialog.jsx', 'components/scan/CropOverlay.jsx', 'utils/scan/canvasOps.js', 'utils/scan/imageOps.js', 'utils/scan/pdfWriter.js', 'utils/scan/scanPlan.js'];
  const code = files.map((file) => strip(read(file))).join('\n');
  assert.match(strip(read('components/scan/ScanDialog.jsx')), /type="file" accept="image\/\*" capture="environment"/);
  assert.doesNotMatch(code, /getUserMedia|mediaDevices|enumerateDevices/);
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|createObjectURL|blob:|<img\b|new Image\(/);
  assert.match(strip(read('utils/scan/canvasOps.js')), /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
  assert.match(strip(read('utils/scan/canvasOps.js')), /bitmap\.close\?\.\(\)/, 'the full-size bitmap is closed at once');
});

test('the dialog uploads through the existing upload (no request of its own), checks storage first, frees its canvases, and shows the gallery notice', () => {
  const dialog = strip(read('components/scan/ScanDialog.jsx'));
  assert.match(dialog, /transfers\.enqueue\(files\.map\(\(item\) => \(\{ kind: 'upload', file: item, folder: folder \|\| '' \}\)\)\);\s*onClose\(\);/, 'handed to the tray, and the dialog closes');
  assert.match(dialog, /validateUpload\(item, \{ usage, pendingBytes: pending \}\)/);
  assert.match(dialog, /await getStorage\(\)/);
  assert.doesNotMatch(dialog, /api\.(post|put|patch)|fetch\(/);
  assert.match(dialog, /for \(const page of pagesRef\.current\) releaseCanvas\(page\.work\)/, 'closing frees every page');
  assert.match(dialog, /for \(const canvas of canvases\) releaseCanvas\(canvas\)/);
  assert.match(dialog, /camera app may keep its own copy of the photo in your gallery\. Delete it there after saving\./);
  assert.doesNotMatch(dialog, /no trace|leaves nothing|nothing is kept on this device/i, 'it does not claim the phone keeps nothing');
  assert.match(dialog, /Save fewer pages/);
  assert.match(dialog, /Save as separate images/);
  assert.match(dialog, /MAX_PAGES = 10/);
  for (const words of ['Document mode', 'Rotate left', 'Rotate right', 'PDF \\(all pages in one file\\)', 'Images \\(JPEG\\)']) assert.match(dialog, new RegExp(words));
});

test('Scan is a button on the Files page on every screen size, and the scanner is its own lazy chunk', () => {
  const page = strip(read('pages/FilesPage.jsx'));
  assert.match(page, /const ScanDialog = lazy\(\(\) => import\('\.\.\/components\/scan\/ScanDialog\.jsx'\)\)/);
  assert.match(page, /onClick=\{\(\) => setScanOpen\(true\)\}/);
  assert.doesNotMatch(page, /from '\.\.\/components\/scan\//, 'nothing of the scanner is imported statically');
  const css = strip(read('pages/FilePages.module.css'));
  assert.doesNotMatch(/\.scanButton \{[^}]*\}/.exec(css)[0], /display:\s*none/);
  assert.doesNotMatch(css, /@media[^{]*\{[^}]*\.scanButton[^}]*display:\s*none/);
});

test('the crop box is reachable by keyboard: it and each corner are focusable and take the arrow keys', () => {
  const overlay = strip(read('components/scan/CropOverlay.jsx'));
  assert.match(overlay, /tabIndex=\{0\}/);
  assert.match(overlay, /ArrowLeft/);
  assert.match(overlay, /<button/);
  assert.match(overlay, /Use the arrow keys to move it/);
  assert.match(overlay, /setPointerCapture/);
});
