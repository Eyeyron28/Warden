import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PUSH_BYTES, PAGE_SIZE, classifyError, runSync, withRetry } from './phoneSync.js';

// ---------- a fake account and a fake phone ----------

const LIMIT = 4.5 * 1024 * 1024; // the host's request / response body cap
const noSleep = async () => {};
const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

function makeServer({ count = 0, size = 1000, pageLimit = 7 } = {}) {
  const docs = new Map(); // id -> { meta, bytes }
  let seq = 0;
  const server = {
    docs,
    folders: ['Taxes', 'Taxes/2024'],
    log: { pages: 0, fetches: [], pushes: [], maxResponseBytes: 0 },
    // faults, set by a test
    failFetchAfter: null,
    revokeAfterFetches: null,
    lostPushResponses: 0,
    add(name, bytes, extra = {}) {
      seq += 1;
      const id = String(seq).padStart(24, '0');
      docs.set(id, {
        meta: { id, filename: name, folder: 'root', checksum: `sum-${id}`, iv: `iv-${id}`, authTag: 'tag', mimeType: 'text/plain', expiryDate: null, deletedAt: null, clientId: null, ...extra },
        bytes,
      });
      return id;
    },
    page({ cursor, limit }) {
      server.log.pages += 1;
      const ids = [...docs.keys()].sort().filter((id) => !cursor || id > cursor);
      const take = ids.slice(0, Math.min(limit, pageLimit));
      const items = take.map((id) => ({ ...docs.get(id).meta, size: docs.get(id).bytes.byteLength }));
      server.log.maxResponseBytes = Math.max(server.log.maxResponseBytes, JSON.stringify(items).length);
      return { items, nextCursor: take.length < ids.length ? take[take.length - 1] : null };
    },
    fetchContent(id) {
      if (server.revokeAfterFetches !== null && server.log.fetches.length >= server.revokeAfterFetches) throw httpError(401, {});
      if (server.failFetchAfter !== null && server.log.fetches.length >= server.failFetchAfter) throw networkError();
      const doc = docs.get(id);
      if (!doc || doc.meta.deletedAt) throw httpError(404, {});
      server.log.fetches.push(id);
      server.log.maxResponseBytes = Math.max(server.log.maxResponseBytes, doc.bytes.byteLength);
      return doc.bytes.slice(0);
    },
    pushDocument(doc) {
      const existing = [...docs.values()].find((d) => d.meta.clientId === doc.clientId);
      let id;
      if (existing) id = existing.meta.id;
      else {
        id = server.add(doc.filename, doc.encryptedBlob, { clientId: doc.clientId, checksum: doc.checksum, iv: doc.iv, folder: doc.folder });
        server.log.pushes.push(id);
      }
      if (server.lostPushResponses > 0) {
        server.lostPushResponses -= 1;
        throw networkError();
      }
      return { id };
    },
  };
  for (let i = 0; i < count; i += 1) server.add(`file-${String(i).padStart(2, '0')}.bin`, new Uint8Array(size).fill(i + 1).buffer);
  return server;
}

function makePhone(initial = []) {
  const docs = new Map(initial.map((d) => [String(d.id), d]));
  const folders = new Map();
  return {
    docs,
    folders,
    store: {
      getDocs: async () => [...docs.values()],
      putDoc: async (doc) => void docs.set(String(doc.id), doc),
      deleteDoc: async (id) => void docs.delete(String(id)),
      remapDoc: async (localId, doc) => {
        docs.delete(String(localId));
        docs.set(String(doc.id), doc);
      },
      getFolders: async () => [...folders.values()],
      putFolder: async (record) => void folders.set(record.name, record),
      deleteFolder: async (name) => void folders.delete(name),
    },
  };
}

const wire = (server, overrides = {}) => ({
  listDocumentPage: async (args) => server.page(args),
  listFolders: async () => server.folders,
  fetchContent: async (id) => server.fetchContent(id),
  pushDocument: async (doc) => server.pushDocument(doc),
  pushFolder: async (name) => void server.folders.push(name),
  ...overrides,
});

const sync = (server, phone, extra = {}) => runSync({ api: wire(server), store: phone.store, sleep: noSleep, ...extra });

// ---------- tests ----------

test('20 files of about 1 MB reach an empty phone through pages and per-file fetches, and no response is over the limit', async () => {
  const server = makeServer({ count: 20, size: 1024 * 1024 });
  const phone = makePhone();
  const progress = [];
  const result = await sync(server, phone, { onProgress: (p) => progress.push(p) });

  assert.equal(result.status, 'done');
  assert.equal(result.pulled, 20);
  assert.equal(phone.docs.size, 20);
  assert.ok(server.log.pages >= 3, 'metadata arrived in several pages (7 per page here)');
  assert.equal(server.log.fetches.length, 20, 'one request per document');
  assert.ok(server.log.maxResponseBytes <= LIMIT, `largest response ${server.log.maxResponseBytes} is under ${LIMIT}`);
  for (const doc of phone.docs.values()) assert.equal(doc.encryptedBlob.byteLength, 1024 * 1024);
  assert.deepEqual([...phone.folders.keys()].sort(), ['Taxes', 'Taxes/2024']);
  const downloads = progress.filter((p) => p.phase === 'downloading');
  assert.equal(downloads.at(-1).done, 20);
  assert.equal(downloads.at(-1).total, 20);
  assert.ok(PAGE_SIZE <= 200);
});

test('a 4 MiB file is the largest that can be fetched or pushed, and fits under the host limit with room to spare', () => {
  assert.equal(MAX_PUSH_BYTES, 4 * 1024 * 1024);
  assert.ok(MAX_PUSH_BYTES + 64 * 1024 < LIMIT, 'file plus multipart envelope stays under 4.5 MB');
  // base64 inside JSON (the old way) would not have fit
  assert.ok(Math.ceil((MAX_PUSH_BYTES * 4) / 3) > LIMIT);
});

test('RESUME: an interruption keeps what was saved, and the next sync fetches only the rest', async () => {
  const server = makeServer({ count: 12, size: 2000 });
  const phone = makePhone();
  server.failFetchAfter = 5; // the connection drops after 5 documents
  const first = await sync(server, phone);
  assert.equal(first.status, 'offline');
  assert.match(first.message, /could not be reached/);
  assert.equal(first.pulled, 5);
  assert.equal(phone.docs.size, 5);

  server.failFetchAfter = null;
  server.log.fetches.length = 0;
  const second = await sync(server, phone);
  assert.equal(second.status, 'done');
  assert.equal(second.pulled, 7, 'only the missing seven');
  assert.equal(server.log.fetches.length, 7);
  assert.equal(phone.docs.size, 12);
  assert.equal((await sync(server, phone)).pulled, 0, 'and a third run has nothing to do');
});

test('a flaky request is retried and the sync carries on', async () => {
  const server = makeServer({ count: 3 });
  const phone = makePhone();
  let calls = 0;
  const api = wire(server, {
    fetchContent: async (id) => {
      calls += 1;
      if (calls === 2) throw httpError(503, {});
      return server.fetchContent(id);
    },
  });
  const slept = [];
  const result = await runSync({ api, store: phone.store, sleep: async (ms) => void slept.push(ms) });
  assert.equal(result.status, 'done');
  assert.equal(result.pulled, 3);
  assert.equal(slept.length, 1, 'one pause before the retry');
});

test('OFFLINE from the start: a clear state, nothing changed on the phone', async () => {
  const server = makeServer({ count: 3 });
  const phone = makePhone([{ id: 'x1', filename: 'kept.txt', folder: 'root', syncStatus: 'synced', iv: 'a', checksum: 'b', encryptedBlob: new ArrayBuffer(1) }]);
  const api = wire(server, { listDocumentPage: async () => { throw networkError(); } });
  const result = await runSync({ api, store: phone.store, sleep: noSleep });
  assert.equal(result.status, 'offline');
  assert.equal(phone.docs.size, 1, 'local files untouched, so nothing is lost by being offline');
});

test('TRASH and RESTORE propagate: a trashed file leaves the phone on the next pull, and a restored one comes back', async () => {
  const server = makeServer({ count: 4 });
  const phone = makePhone();
  await sync(server, phone);
  const [first, second] = [...server.docs.keys()];

  server.docs.get(first).meta.deletedAt = new Date().toISOString();
  const afterTrash = await sync(server, phone);
  assert.equal(afterTrash.removed, 1);
  assert.equal(phone.docs.has(first), false);
  assert.equal(phone.docs.size, 3);

  server.docs.get(first).meta.deletedAt = null; // restored
  server.log.fetches.length = 0;
  const afterRestore = await sync(server, phone);
  assert.equal(afterRestore.pulled, 1);
  assert.deepEqual(server.log.fetches, [first]);
  assert.equal(phone.docs.has(first), true);
  assert.equal(phone.docs.has(second), true);
});

test('a phone days behind catches up: removed files go, renamed files update, new files arrive, and nothing is fetched twice', async () => {
  const server = makeServer({ count: 6 });
  const phone = makePhone();
  await sync(server, phone);
  const ids = [...server.docs.keys()];

  server.docs.delete(ids[0]); // purged from Trash for good
  server.docs.get(ids[1]).meta.filename = 'renamed.bin';
  server.docs.get(ids[1]).meta.folder = 'Taxes';
  server.add('new-a.bin', new Uint8Array(10).buffer);
  server.add('new-b.bin', new Uint8Array(10).buffer);

  server.log.fetches.length = 0;
  const result = await sync(server, phone);
  assert.equal(result.removed, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.pulled, 2);
  assert.equal(server.log.fetches.length, 2, 'only the two new files were downloaded');
  assert.equal(phone.docs.get(ids[1]).filename, 'renamed.bin');
  assert.equal(phone.docs.get(ids[1]).folder, 'Taxes');
  assert.equal(phone.docs.has(ids[0]), false);
  assert.equal(phone.docs.size, 7);
});

test('PUSH: a file added offline is uploaded once, one document per request, and takes its canonical id', async () => {
  const server = makeServer({ count: 1 });
  const phone = makePhone([{ id: 'local-uuid-1', filename: 'added-offline.txt', folder: 'root', syncStatus: 'pending', iv: 'iv1', authTag: 't', checksum: 'c1', mimeType: 'text/plain', encryptedBlob: new Uint8Array(500).buffer }]);
  phone.folders.set('NewEmpty', { name: 'NewEmpty', syncStatus: 'pending' });
  const result = await sync(server, phone);
  assert.equal(result.pushed, 1);
  assert.equal(phone.docs.has('local-uuid-1'), false);
  const pushedId = server.log.pushes[0];
  assert.equal(phone.docs.get(pushedId).syncStatus, 'synced');
  assert.equal(server.docs.get(pushedId).meta.clientId, 'local-uuid-1');
  assert.ok(server.folders.includes('NewEmpty'));
  assert.equal(phone.folders.get('NewEmpty').syncStatus, 'synced');
});

test('PUSH is safe to repeat: a lost response does not create a second copy, and a later sync recognises its own upload', async () => {
  const server = makeServer({ count: 0 });
  const mk = () => makePhone([{ id: 'u-1', filename: 'once.txt', folder: 'root', syncStatus: 'pending', iv: 'iv', authTag: 't', checksum: 'c', encryptedBlob: new Uint8Array(40).buffer }]);

  // the response is lost twice; the retry (same clientId) finds the document the first attempt made
  let phone = mk();
  server.lostPushResponses = 2;
  const result = await sync(server, phone);
  assert.equal(result.status, 'done');
  assert.equal(server.docs.size, 1, 'one copy on the server');
  assert.equal(result.pushed, 1);

  // the app is closed right after the upload and the answer never arrives: next sync sees its own clientId in the listing
  const server2 = makeServer({ count: 0 });
  phone = mk();
  server2.lostPushResponses = 99; // every retry is lost too
  const interrupted = await sync(server2, phone);
  assert.equal(interrupted.status, 'offline');
  assert.equal(phone.docs.get('u-1').syncStatus, 'pending');
  assert.equal(server2.docs.size, 1);
  server2.lostPushResponses = 0;
  server2.log.fetches.length = 0;
  const recovered = await sync(server2, phone);
  assert.equal(server2.docs.size, 1, 'still one copy');
  assert.equal(server2.log.fetches.length, 0, 'it did not download its own upload');
  assert.equal(phone.docs.size, 1);
  assert.equal([...phone.docs.values()][0].syncStatus, 'synced');
  assert.equal(recovered.status, 'done');
});

test('a file too large to push, or a full account, is reported and the rest carries on', async () => {
  const server = makeServer({ count: 0 });
  const big = { id: 'big', filename: 'big.bin', folder: 'root', syncStatus: 'pending', iv: 'i', authTag: 't', checksum: 'c', encryptedBlob: { byteLength: MAX_PUSH_BYTES + 1 } };
  const ok = { id: 'ok', filename: 'ok.txt', folder: 'root', syncStatus: 'pending', iv: 'i', authTag: 't', checksum: 'c', encryptedBlob: new Uint8Array(5).buffer };
  const phone = makePhone([big, ok]);
  const result = await sync(server, phone);
  assert.equal(result.status, 'partial');
  assert.equal(result.pushed, 1);
  assert.match(result.failures[0].reason, /Larger than the 4 MB/);

  const full = makePhone([{ ...ok, id: 'a' }, { ...ok, id: 'b', filename: 'b.txt' }]);
  const api = wire(server, { pushDocument: async () => { throw httpError(413, { error: { code: 'STORAGE_QUOTA' } }); } });
  const quota = await runSync({ api, store: full.store, sleep: noSleep });
  assert.equal(quota.pushed, 0);
  assert.equal(quota.failures.length, 2);
  assert.match(quota.failures[0].reason, /storage is full/);
});

test('REVOKED mid-sync: a 401 stops everything at once with a clear message, and keeps what is on the phone', async () => {
  const server = makeServer({ count: 10 });
  const phone = makePhone();
  server.revokeAfterFetches = 4;
  const result = await sync(server, phone);
  assert.equal(result.status, 'revoked');
  assert.match(result.message, /no longer paired|removed/i);
  assert.equal(phone.docs.size, 4, 'no wiping on a 401; the owner chooses');
  assert.equal(server.log.fetches.length, 4, 'no further requests after the 401');

  const listing401 = await runSync({ api: wire(server, { listDocumentPage: async () => { throw httpError(401, {}); } }), store: phone.store, sleep: noSleep });
  assert.equal(listing401.status, 'revoked');
});

test('the old endpoints answer 410: the phone says the app is out of date', async () => {
  const server = makeServer({ count: 1 });
  const api = wire(server, { listDocumentPage: async () => { throw httpError(410, { error: { message: 'This version of Warden on your phone is out of date.' } }); } });
  const result = await runSync({ api, store: makePhone().store, sleep: noSleep });
  assert.equal(result.status, 'outdated');
  assert.match(result.message, /out of date/);
});

test('cancelling stops between documents and the next sync resumes', async () => {
  const server = makeServer({ count: 8 });
  const phone = makePhone();
  const controller = new AbortController();
  const result = await sync(server, phone, {
    signal: controller.signal,
    onProgress: (p) => { if (p.phase === 'downloading' && p.done === 3) controller.abort(); },
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(phone.docs.size >= 3 && phone.docs.size < 8);
  const rest = await sync(server, phone);
  assert.equal(rest.status, 'done');
  assert.equal(phone.docs.size, 8);
});

test('TWO PHONES syncing at the same time do not disturb each other or the account', async () => {
  const server = makeServer({ count: 9, size: 300 });
  const a = makePhone([{ id: 'a-local', filename: 'from-a.txt', folder: 'root', syncStatus: 'pending', iv: 'iv-a', authTag: 't', checksum: 'ca', encryptedBlob: new Uint8Array(20).buffer }]);
  const b = makePhone([{ id: 'b-local', filename: 'from-b.txt', folder: 'root', syncStatus: 'pending', iv: 'iv-b', authTag: 't', checksum: 'cb', encryptedBlob: new Uint8Array(20).buffer }]);
  const [ra, rb] = await Promise.all([sync(server, a), sync(server, b)]);
  assert.equal(ra.status, 'done');
  assert.equal(rb.status, 'done');
  assert.equal(server.docs.size, 11, 'nine originals plus one from each phone, no duplicates');
  // a second round brings each phone the other's file
  await Promise.all([sync(server, a), sync(server, b)]);
  for (const phone of [a, b]) {
    assert.equal(phone.docs.size, 11);
    const names = [...phone.docs.values()].map((d) => d.filename);
    assert.ok(names.includes('from-a.txt') && names.includes('from-b.txt'));
    assert.ok([...phone.docs.values()].every((d) => d.syncStatus === 'synced'));
  }
  assert.deepEqual([...a.docs.keys()].sort(), [...b.docs.keys()].sort(), 'both phones hold the same documents under the same ids');
});

test('error classes: what each status means to the phone', () => {
  assert.equal(classifyError(networkError()).kind, 'offline');
  assert.equal(classifyError(httpError(401, {})).kind, 'revoked');
  assert.equal(classifyError(httpError(410, {})).kind, 'outdated');
  assert.equal(classifyError(httpError(413, { error: { code: 'STORAGE_QUOTA' } })).kind, 'quota');
  assert.equal(classifyError(httpError(413, {})).kind, 'too-large');
  assert.equal(classifyError(httpError(404, {})).kind, 'missing');
  assert.equal(classifyError(httpError(429, {})).retryable, true);
  assert.equal(classifyError(httpError(500, {})).retryable, true);
  assert.equal(classifyError(httpError(400, {})).retryable, false);
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ERR_CANCELED' })).kind, 'cancelled');
});

test('withRetry gives up after three tries and never retries a refusal', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw networkError(); }, { sleep: noSleep }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw httpError(401, {}); }, { sleep: noSleep }));
  assert.equal(calls, 1);
});
