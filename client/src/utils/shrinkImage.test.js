import test from 'node:test';
import assert from 'node:assert/strict';

import { CANNOT_DECODE, CANNOT_FIT, CANNOT_SAVE, shrinkToJpeg } from './shrinkImage.js';

const LIMIT = 4 * 1024 * 1024;
const photo = (size = LIMIT + 1000, name = 'IMG_1234.PNG', type = 'image/png') => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

function fakeBrowser({ bitmap = { width: 4000, height: 3000 }, optionsRejected = false, decodeFails = false, blobSizes = [100], canvasLog = [] } = {}) {
  let call = 0;
  const closed = [];
  globalThis.createImageBitmap = async (file, options) => {
    if (decodeFails || (optionsRejected && options)) throw new TypeError('not supported');
    return { ...bitmap, close: () => closed.push(true) };
  };
  globalThis.document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) {} }),
        toBlob(callback) {
          canvasLog.push([canvas.width, canvas.height]);
          const size = blobSizes[Math.min(call, blobSizes.length - 1)];
          call += 1;
          callback(size === null ? null : new Blob([new Uint8Array(size)], { type: 'image/jpeg' }));
        },
      };
      return canvas;
    },
  };
  return { closed };
}

test('a browser that rejects the orientation option still reads the photo, and the result is a smaller .jpg', async () => {
  fakeBrowser({ optionsRejected: true });
  const result = await shrinkToJpeg(photo(), LIMIT);
  assert.equal(result.ok, true);
  assert.equal(result.file.name, 'IMG_1234.jpg');
  assert.equal(result.file.type, 'image/jpeg');
  assert.ok(result.file.size < LIMIT);
});

test('a photo the browser cannot read (HEIC, for example) gets the plain Photos-app message', async () => {
  fakeBrowser({ decodeFails: true });
  const result = await shrinkToJpeg(photo(LIMIT + 1, 'IMG_1.HEIC', 'image/heic'), LIMIT);
  assert.deepEqual(result, { ok: false, message: CANNOT_DECODE });
  assert.match(CANNOT_DECODE, /Open it in your Photos app and export it as JPEG, then try again\./);
});

test('nothing is ever drawn larger than 4096 px on its long side, even for a 48 MP photo', async () => {
  const canvasLog = [];
  fakeBrowser({ bitmap: { width: 8000, height: 6000 }, canvasLog });
  const result = await shrinkToJpeg(photo(), LIMIT);
  assert.equal(result.ok, true);
  assert.ok(canvasLog.every(([w, h]) => Math.max(w, h) <= 4096), JSON.stringify(canvasLog));
});

test('the steps keep going until a result fits, and say so when none does', async () => {
  const canvasLog = [];
  fakeBrowser({ blobSizes: [LIMIT, LIMIT, LIMIT, 3 * 1024 * 1024], canvasLog });
  const fits = await shrinkToJpeg(photo(), LIMIT);
  assert.equal(fits.ok, true);
  assert.equal(canvasLog.length, 4, 'four tries, the fourth fits');
  fakeBrowser({ blobSizes: [LIMIT * 2] });
  assert.deepEqual(await shrinkToJpeg(photo(), LIMIT), { ok: false, message: CANNOT_FIT });
});

test('a browser that cannot encode says so, and a result bigger than the original is never offered', async () => {
  fakeBrowser({ blobSizes: [null] });
  assert.deepEqual(await shrinkToJpeg(photo(), LIMIT), { ok: false, message: CANNOT_SAVE });
  fakeBrowser({ blobSizes: [3 * 1024 * 1024] });
  const small = photo(2 * 1024 * 1024);
  assert.deepEqual(await shrinkToJpeg(small, LIMIT), { ok: false, message: CANNOT_FIT });
});

test('the picture is released afterwards, and very large inputs are refused with a plain message', async () => {
  const { closed } = fakeBrowser();
  await shrinkToJpeg(photo(), LIMIT);
  assert.equal(closed.length, 1);
  const huge = await shrinkToJpeg(photo(61 * 1024 * 1024), LIMIT);
  assert.deepEqual(huge, { ok: false, message: 'This image is too large to shrink here.' });
  fakeBrowser({ bitmap: { width: 12000, height: 9000 } });
  assert.equal((await shrinkToJpeg(photo(), LIMIT)).message, 'This image has too many pixels to shrink here.');
});
