// Run with: cd server && npm test
//
// File names across every path: what is stored, what is listed, what a download
// is called, and that the bytes survive. Table-driven over real sample files for
// every common type (test/helpers/samples.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const db = require('./helpers/fakeDb');
const { SAMPLES, NAMES } = require('./helpers/samples');
const names = require('../utils/fileNames');
const { sniffImageType } = require('../utils/sniff');

const world = db.createWorld();
const ALICE = db.oid();
const DEK = crypto.randomBytes(32);

function runPipeline(rows, pipeline) {
  let current = rows;
  for (const stage of pipeline) {
    if (stage.$match) current = current.filter((r) => db.matches(r, stage.$match));
    else if (stage.$sort) current = [...current].sort((a, b) => b.createdAt - a.createdAt);
    else if (stage.$project) {
      current = current.map((r) => {
        const out = { _id: r._id };
        for (const [field, spec] of Object.entries(stage.$project)) out[field] = spec === 1 ? r[field] : r.encryptedBlob.length;
        return out;
      });
    } else if (stage.$group) {
      current = [{ _id: null, bytes: current.reduce((n, r) => n + r.encryptedBlob.length, 0), count: current.length }];
    }
  }
  return current;
}
db.installModels(world, {
  Document: {
    aggregate: (pipeline) => {
      const q = { session: () => q, then: (ok, bad) => Promise.resolve(runPipeline(world.tables.documents, pipeline)).then(ok, bad) };
      return q;
    },
  },
});
db.installRateLimit();
db.installMailer(world);

const folders = require('../utils/folders');
folders.runInTransaction = async (fn) => fn(null);
folders.ensureFolderPath = async () => '';

const trash = require('../utils/trash');
const D = require('../controllers/documents.controller');
const T = require('../controllers/trash.controller');
const { call } = db;
const as = (extra = {}) => ({ userId: ALICE, dek: DEK, ...extra });
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Reads the filename a Content-Disposition header carries (filename*= preferred).
function nameFromDisposition(header) {
  const star = /filename\*=UTF-8''([^;]+)/.exec(header);
  if (star) return decodeURIComponent(star[1]);
  return /filename="([^"]*)"/.exec(header)[1];
}

test('the extension recovered from the bytes follows the bytes, for every type', () => {
  for (const sample of SAMPLES) {
    assert.equal(names.sniffExtension(sample.bytes), sample.sniff, `.${sample.ext} sample`);
  }
});

test('a name that already has an extension is never changed by a download, whatever the bytes are', () => {
  for (const sample of SAMPLES) {
    for (const name of [`file.${sample.ext}`, `FILE.${sample.ext.toUpperCase()}`, 'wrong-name.dat']) {
      assert.equal(names.downloadName(name, sample.bytes), name, `${name} with ${sample.ext} bytes`);
    }
  }
});

test('a name with NO extension gains one only when the bytes are unmistakably a known type', () => {
  for (const sample of SAMPLES) {
    const expected = sample.sniff ? `mod12.${sample.sniff}` : 'mod12';
    assert.equal(names.downloadName('mod12', sample.bytes), expected, `mod12 holding ${sample.ext} bytes`);
  }
  // An unknown type never gets one, including empty and tiny files.
  assert.equal(names.downloadName('notes', Buffer.from('hello')), 'notes');
  assert.equal(names.downloadName('empty', Buffer.alloc(0)), 'empty');
  assert.equal(names.downloadName('.env', Buffer.from('A=1\n')), '.env');
});

test('download names are sanitised and length-limited with the extension kept', () => {
  const clean = (name) => names.sanitizeDownloadName(name);
  for (const { name, expectDownload, long, hostile } of NAMES) {
    const out = clean(name);
    assert.doesNotMatch(out, /[\\/:*?"<>|\u0000-\u001f\u007f]/, `${JSON.stringify(name)} -> ${JSON.stringify(out)}`);
    assert.ok([...out].length <= 120);
    assert.equal(out, out.trim());
    assert.doesNotMatch(out, /[ .]$/);
    if (expectDownload) assert.equal(out, expectDownload);
    if (long) assert.ok(out.endsWith('.pdf'), 'the extension survives truncation');
    if (hostile) assert.doesNotMatch(out, /["/\\]/);
  }
  assert.equal(clean('.env'), '.env', 'a dotfile keeps its leading dot');
  assert.equal(clean('Résumé 履歴.pdf'), 'Résumé 履歴.pdf');
  assert.equal(clean('..'), 'file');
  assert.equal(clean('   '), 'file');
  assert.equal(clean('a‮b.pdf'), 'a_b.pdf', 'bidi override characters are removed');
  assert.equal(clean('line\r\nbreak.txt'), 'line__break.txt');
});

test('Content-Disposition carries an ASCII fallback and RFC 5987 filename*', () => {
  const header = names.contentDisposition('Résumé 履歴.pdf');
  assert.match(header, /^attachment; filename="R_sum_ __\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%E5%B1%A5%E6%AD%B4\.pdf$/);
  assert.equal(nameFromDisposition(header), 'Résumé 履歴.pdf');
  for (const { name } of NAMES) {
    const value = names.contentDisposition(name);
    const fallback = /filename="([^"]*)"/.exec(value)[1];
    assert.match(fallback, /^[\x20-\x7e]*$/, 'ASCII only');
    assert.doesNotMatch(fallback, /["\\/]/);
    assert.equal(nameFromDisposition(value), names.sanitizeDownloadName(name));
    assert.doesNotMatch(value, /[\r\n]/, 'no header injection');
  }
  assert.match(names.contentDisposition("it's (a) test.pdf"), /filename\*=UTF-8''it%27s%20%28a%29%20test\.pdf/);
});

test('Photos follows the bytes, never the name', () => {
  for (const sample of SAMPLES) {
    for (const name of [`photo.${sample.ext}`, 'looks-like.png', 'noext']) {
      const type = sniffImageType(Buffer.concat([sample.bytes, Buffer.alloc(16)]));
      assert.equal(type !== 'none', sample.photo, `${name} holding ${sample.ext} bytes`);
    }
  }
});

test('stored names drop control characters and path separators but keep everything else', () => {
  assert.equal(names.cleanStoredName('Résumé 履歴.pdf'), 'Résumé 履歴.pdf');
  assert.equal(names.cleanStoredName('a/b\\c.pdf'), 'a_b_c.pdf');
  assert.equal(names.cleanStoredName('x\u0000y\r\n.txt'), 'x_y__.txt');
  assert.equal(names.cleanStoredName('  '), 'file');
  assert.equal(names.cleanStoredName('a"b.txt'), 'a"b.txt', 'a quote is a legal character in a stored name');
  assert.equal(names.cleanStoredName('x'.repeat(400)).length, 255);
  const long = names.cleanStoredName(`${'y'.repeat(400)}.pdf`);
  assert.equal(long.length, 255);
  assert.ok(long.endsWith('.pdf'), 'a very long name keeps its extension when it is shortened');
});

test('every sample, under every kind of name, survives upload, listing, download, trash and restore byte for byte', async () => {
  let n = 0;
  for (const sample of SAMPLES) {
    for (const entry of NAMES) {
      n += 1;
      const name = entry.name.endsWith('.pdf') || entry.name.endsWith('.docx') || entry.name === '.env' || entry.name === 'noextension'
        ? entry.name.replace(/\.(pdf|docx|JPG)$/i, `.${sample.ext}`)
        : entry.name;
      for (const table of Object.keys(world.tables)) world.tables[table] = [];
      const upload = await call(D.createDocument, as({ body: {}, files: { file: [{ buffer: sample.bytes, originalname: name, mimetype: 'application/octet-stream' }] } }));
      assert.equal(upload.error, null, `${sample.ext} / ${entry.note}: upload`);
      const id = String(upload.json.id);
      const stored = world.tables.documents[0].filename;
      assert.equal(stored, names.cleanStoredName(name), `${sample.ext} / ${entry.note}: stored name`);

      const list = await call(D.listDocuments, as());
      assert.equal(list.json[0].filename, stored, 'listed name equals stored name');

      const check = async (label) => {
        const served = await call(D.viewDocument, as({ params: { id } }));
        assert.equal(served.error, null, label);
        assert.equal(sha(served.body), sha(sample.bytes), `${sample.ext} / ${entry.note}: bytes identical (${label})`);
        assert.equal(served.headers['content-type'], 'application/octet-stream');
        assert.equal(served.headers['x-content-type-options'], 'nosniff');
        assert.equal(nameFromDisposition(served.headers['content-disposition']), names.downloadName(stored, sample.bytes));
        assert.match(served.headers['content-disposition'], /^attachment;/);
        return served;
      };
      await check('download');
      await call(D.deleteDocument, as({ params: { id } }));
      await call(T.restoreItem, as({ body: { kind: 'file', id } }));
      assert.equal(world.tables.documents[0].filename, stored, 'trash and restore keep the name');
      await check('after trash and restore');
    }
  }
  assert.ok(n >= SAMPLES.length * NAMES.length);
});

test('a PDF stored without an extension downloads as .pdf and the stored name is untouched', async () => {
  for (const table of Object.keys(world.tables)) world.tables[table] = [];
  const pdf = SAMPLES.find((s) => s.ext === 'pdf').bytes;
  const upload = await call(D.createDocument, as({ body: {}, files: { file: [{ buffer: pdf, originalname: 'mod12', mimetype: 'application/pdf' }] } }));
  const served = await call(D.viewDocument, as({ params: { id: String(upload.json.id) } }));
  assert.equal(nameFromDisposition(served.headers['content-disposition']), 'mod12.pdf');
  assert.equal(world.tables.documents[0].filename, 'mod12', 'the stored name is not rewritten');
  world.tables.documents[0].save = async () => {}; // the fake rows are plain objects
  const renamed = await call(D.updateDocument, as({ params: { id: String(upload.json.id) }, body: { filename: 'Module 12' } }));
  assert.equal(renamed.json.filename, 'Module 12');
  assert.equal(nameFromDisposition((await call(D.viewDocument, as({ params: { id: String(upload.json.id) } }))).headers['content-disposition']), 'Module 12.pdf');
});

test('uploads are parsed as UTF-8 so non-ASCII names do not turn into mojibake', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'documents.routes.js'), 'utf8');
  assert.match(routes, /defParamCharset:\s*'utf8'/);
});

test('every place that names a download goes through the shared rules', () => {
  const root = path.join(__dirname, '..');
  const docs = fs.readFileSync(path.join(root, 'controllers', 'documents.controller.js'), 'utf8');
  assert.match(docs, /contentDisposition\(downloadName\(document\.filename, plaintext\)\)/);
  assert.doesNotMatch(docs, /filename\*=UTF-8''\$\{encodeURIComponent\(document\.filename\)\}/, 'no unsanitised header left');
  for (const file of ['controllers/sync.controller.js', 'controllers/backup.controller.js', 'controllers/documents.controller.js']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /cleanStoredName\(/, file);
  }
});

test('phone sync: every sample pushed from a paired phone keeps its name and downloads like any other file', async () => {
  const sync = require('../controllers/sync.controller');
  const { encryptFile } = require('../utils/crypto');
  for (const table of Object.keys(world.tables)) world.tables[table] = [];
  let count = 0;
  for (const sample of SAMPLES) {
    for (const name of [`phone.${sample.ext}`, 'phone-noext']) {
      const sealed = encryptFile(sample.bytes, DEK); // the phone encrypts under the vault key itself
      const pushed = await call(sync.pushDocuments, {
        userId: ALICE,
        body: {
          newDocuments: [{ localId: `l${count}`, filename: name, folder: '', encryptedBlob: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, checksum: sha(sample.bytes), mimeType: 'application/octet-stream' }],
        },
      });
      assert.equal(pushed.error, null, `${sample.ext}: push`);
      const id = String(pushed.json.idMap[0].id);
      assert.equal(world.tables.documents.find((d) => String(d._id) === id).filename, names.cleanStoredName(name), 'stored name from the phone');
      const served = await call(D.viewDocument, as({ params: { id } }));
      assert.equal(sha(served.body), sha(sample.bytes), `${sample.ext}: bytes from the phone are identical`);
      const expected = name === 'phone-noext' ? (sample.sniff ? `phone-noext.${sample.sniff}` : 'phone-noext') : name;
      assert.equal(nameFromDisposition(served.headers['content-disposition']), expected);
      count += 1;
    }
  }
  assert.ok(count >= SAMPLES.length * 2);
});
