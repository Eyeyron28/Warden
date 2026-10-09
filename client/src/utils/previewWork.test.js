import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIEW_CONCURRENCY,
  PREVIEW_MAX_BYTES,
  failedPreviews,
  isPreviewCandidate,
  previewKindOfBytes,
  previewOne,
  reasonLabel,
  runPreviews,
  summarizePreviews,
} from './previewWork.js';

const enc = (text) => new TextEncoder().encode(text);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);
const GIF = enc('GIF89a-and-some-more');
const WEBP = Uint8Array.from([...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBPVP8 ')]);
const PDF = enc('%PDF-1.7\n%âãÏÓ\n');
const SVG = enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
const HEIC = Uint8Array.from([0, 0, 0, 24, ...enc('ftypheic'), 0, 0, 0, 0, ...enc('mif1heic')]);
const TEXT = enc('just some text, not a picture');

test('what is previewed is decided by the BYTES, never the name', () => {
  assert.equal(previewKindOfBytes(PNG), 'image');
  assert.equal(previewKindOfBytes(JPEG), 'image');
  assert.equal(previewKindOfBytes(GIF), 'image');
  assert.equal(previewKindOfBytes(WEBP), 'image');
  assert.equal(previewKindOfBytes(PDF), 'pdf');
  for (const none of [SVG, HEIC, TEXT, new Uint8Array(0), enc('PK\u0003\u0004...')]) assert.equal(previewKindOfBytes(none), 'none');
});

test('candidates: no preview yet, no earlier failure, within 4 MB, and not known to be something else', () => {
  const base = { id: 'a', filename: 'mod12', hasThumb: false, thumbFailed: false, size: 1000, previewKind: null };
  assert.equal(isPreviewCandidate(base), true, 'an extensionless name with an unknown kind is tried: the bytes decide');
  assert.equal(isPreviewCandidate({ ...base, filename: 'photo.png', previewKind: 'image' }), true);
  assert.equal(isPreviewCandidate({ ...base, previewKind: 'pdf' }), true);
  assert.equal(isPreviewCandidate({ ...base, hasThumb: true }), false);
  assert.equal(isPreviewCandidate({ ...base, thumbFailed: true }), false, 'a recorded failure is not retried');
  assert.equal(isPreviewCandidate({ ...base, previewKind: 'none' }), false, 'bytes already said: not an image or PDF');
  assert.equal(isPreviewCandidate({ ...base, filename: 'logo.svg', previewKind: 'none' }), false);
  assert.equal(isPreviewCandidate({ ...base, size: PREVIEW_MAX_BYTES + 1 }), false);
  assert.equal(isPreviewCandidate({ ...base, size: null }), true);
  assert.equal(isPreviewCandidate(null), false);
  // the name never decides: a ".png" whose kind is 'none' is out, and a nameless 'pdf' is in
  assert.equal(isPreviewCandidate({ ...base, filename: 'pretty.png', previewKind: 'none' }), false);
  assert.equal(isPreviewCandidate({ ...base, filename: 'noext', previewKind: 'pdf' }), true);
  assert.deepEqual(failedPreviews([base, { ...base, id: 'b', thumbFailed: true }, { ...base, id: 'c', thumbFailed: true, hasThumb: true }]).map((d) => d.id), ['b']);
});

function deps(bytesById, { draw, upload, failures } = {}) {
  const recorded = failures || [];
  return {
    recorded,
    fetchBytes: async (id) => {
      if (!(id in bytesById)) throw Object.assign(new Error('nope'), { response: { status: 500 } });
      return { bytes: bytesById[id] };
    },
    drawThumbnail: draw || (async () => ({ blob: new Blob(['thumb']) })),
    uploadThumbnail: upload || (async () => ({})),
    recordFailure: async (id, reason, kind) => recorded.push({ id, reason, kind }),
  };
}

test('an extensionless PDF gets a thumbnail; the kind passed to the drawing step comes from the bytes', async () => {
  const seen = [];
  const d = deps({ 1: PDF }, { draw: async (blob, kind) => { seen.push(kind); return { blob }; } });
  const out = await previewOne({ id: 1, filename: 'mod12' }, d);
  assert.deepEqual(out, { id: 1, status: 'done' });
  assert.deepEqual(seen, ['pdf']);
  assert.deepEqual(d.recorded, []);
});

test('HEIC and SVG are skipped with a reason and recorded as "not an image or PDF"; text too', async () => {
  const d = deps({ 1: HEIC, 2: SVG, 3: TEXT });
  for (const id of [1, 2, 3]) {
    const out = await previewOne({ id, filename: `f${id}.bin` }, d);
    assert.deepEqual([out.status, out.reason, out.recorded], ['failed', 'unsupported-type', true]);
  }
  assert.deepEqual(d.recorded.map((r) => [r.reason, r.kind]), [['unsupported-type', 'none'], ['unsupported-type', 'none'], ['unsupported-type', 'none']]);
  assert.match(reasonLabel('unsupported-type'), /image or PDF/);
});

test('a corrupt PNG is recorded as failed (with the reason) and is not a candidate on the next run', async () => {
  const d = deps({ 1: PNG }, { draw: async () => ({ reason: 'decode-failed' }) });
  const out = await previewOne({ id: 1, filename: 'bad.png' }, d);
  assert.deepEqual([out.status, out.reason], ['failed', 'decode-failed']);
  assert.deepEqual(d.recorded, [{ id: 1, reason: 'decode-failed', kind: 'image' }]);
  // what the list says afterwards (the server stored thumbFailed): it is no longer worth trying
  assert.equal(isPreviewCandidate({ id: 1, hasThumb: false, thumbFailed: true, thumbFailReason: 'decode-failed', size: 10, previewKind: 'image' }), false);
});

test('other failures: too large, too big a result, a refused upload, a fetch that fails', async () => {
  const big = new Uint8Array(PREVIEW_MAX_BYTES + 1);
  big.set(PNG);
  assert.equal((await previewOne({ id: 1 }, deps({ 1: big }))).reason, 'too-large');
  assert.equal((await previewOne({ id: 1 }, deps({ 1: PNG }, { draw: async () => ({ reason: 'too-big-result' }) }))).reason, 'too-big-result');
  assert.equal((await previewOne({ id: 1 }, deps({ 1: PNG }, { upload: async () => { throw Object.assign(new Error('x'), { response: { status: 400 } }); } }))).reason, 'too-big-result');
  const fetchFail = await previewOne({ id: 9 }, deps({}));
  assert.deepEqual([fetchFail.reason, fetchFail.recorded], ['download-failed', false], 'a fetch failure is not recorded: it is tried again next time');
  assert.match(reasonLabel('timeout'), /too long/);
  assert.match(reasonLabel('anything else'), /could not be made/);
});

test('when the session ends the whole run stops instead of marking every file as failed', async () => {
  const d = deps({});
  d.fetchBytes = async () => { throw Object.assign(new Error('401'), { response: { status: 401 } }); };
  const queue = Array.from({ length: 6 }, (_, i) => ({ id: i }));
  const out = await runPreviews(queue, d);
  assert.equal(out.done, 0);
  assert.deepEqual(out.failures, [], 'nothing was recorded as a failed preview');
  assert.deepEqual(d.recorded, []);
});

test('two at a time, and Pause takes effect between files without losing the rest', async () => {
  let active = 0;
  let maxActive = 0;
  const bytes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, PNG]));
  const d = deps(bytes, {
    draw: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { blob: new Blob(['t']) };
    },
  });
  const queue = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  let paused = false;
  let finished = 0;
  const first = await runPreviews(queue, d, { shouldPause: () => paused, onResult: () => { finished += 1; if (finished === 3) paused = true; } });
  assert.equal(PREVIEW_CONCURRENCY, 2);
  assert.equal(maxActive, 2);
  assert.equal(first.finished, false, 'stopped before the end');
  assert.ok(first.done >= 3 && first.done < 10);
  // resume with what is left
  const left = queue.filter((doc) => doc.id >= first.done);
  paused = false;
  const second = await runPreviews(left, d, {});
  assert.equal(second.finished, true);
  assert.equal(first.done + second.done, 10);
});

test('the summary reads "12 done, 2 could not be previewed"', () => {
  assert.equal(summarizePreviews(12, 2), '12 done, 2 could not be previewed');
  assert.equal(summarizePreviews(5, 0), '5 done');
  assert.equal(summarizePreviews(0, 1), '0 done, 1 could not be previewed');
});
