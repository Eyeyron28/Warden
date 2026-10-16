// Run with: cd server && npm test
//
// Quarantine's scanner (utils/fileScanner.js): every rule, on synthetic buffers built in code (test/helpers/riskySamples.js).
// No file is committed, nothing is real malware, and the standard antivirus test string is assembled at run time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanBuffer, describeReasons, severityOf, REASONS, SCANNER_VERSION, SUSPICIOUS_THRESHOLD } = require('../utils/fileScanner');
const S = require('./helpers/riskySamples');

const scan = (name, buffer, type = '') => scanBuffer({ name, type, buffer });
const reasonsOf = (name, buffer, type) => scan(name, buffer, type).reasons.sort();

// ---------- clean files stay clean ----------

test('ordinary files are clean: a plain PDF, PNG, JPEG, DOCX without macros, TXT, CSV, a clean SVG, an old Office file without macros', () => {
  for (const [name, buffer, type] of [
    ['form.pdf', S.plainPdf(), 'application/pdf'],
    ['photo.png', S.png(), 'image/png'],
    ['photo.jpg', S.jpeg(), 'image/jpeg'],
    ['letter.docx', S.docx(), ''],
    ['notes.txt', S.text('Remember the milk.\nOnce upon a time.\n'), 'text/plain'],
    ['table.csv', S.text('a,b\n1,2\n'), 'text/csv'],
    ['logo.svg', S.svgClean(), ''],
    ['old.doc', S.oleClean(), ''],
    ['empty.txt', Buffer.alloc(0), ''],
    ['no-extension', S.text('just words'), ''],
  ]) {
    const result = scan(name, buffer, type);
    assert.equal(result.verdict, 'clean', `${name}: ${result.reasons}`);
    assert.deepEqual(result.reasons, [], name);
    assert.equal(result.score, 0, name);
    assert.equal(result.version, SCANNER_VERSION);
  }
});

test('the plain words "on", "once" and a PDF name like /JSON or /Author are not mistaken for active content', () => {
  assert.equal(scan('prose.txt', S.text('onclick = nothing. once = twice. on=1')).verdict, 'clean');
  assert.equal(scan('a.pdf', S.pdfWith('/JSONData 3 0 R /AAPL 1 0 R')).verdict, 'clean');
});

// ---------- each check ----------

test('TYPE_MISMATCH: the name says one thing and the bytes another (alone this is below the threshold: a note, not a hold)', () => {
  const result = scan('holiday.jpg', S.plainPdf());
  assert.deepEqual(result.reasons, ['TYPE_MISMATCH']);
  assert.equal(result.verdict, 'clean');
  assert.equal(result.score, REASONS.TYPE_MISMATCH.weight);
  assert.ok(result.score < SUSPICIOUS_THRESHOLD);
  assert.deepEqual(reasonsOf('x.pdf', S.text('not really a pdf')), ['TYPE_MISMATCH']);
  assert.deepEqual(reasonsOf('x.txt', S.png()), ['TYPE_MISMATCH']);
  assert.deepEqual(reasonsOf('a.png', S.png(), 'application/pdf'), [], 'the extension decides, then the claimed type');
  assert.deepEqual(reasonsOf('noext', S.jpeg(), 'image/png'), ['TYPE_MISMATCH'], 'a claimed image type that the bytes contradict');
});

test('DOUBLE_EXTENSION: report.pdf.exe, invoice.docx.js, any executable or script ending, and a hidden right-to-left override', () => {
  for (const name of ['report.pdf.exe', 'invoice.docx.js', 'setup.exe', 'run.bat', 'x.cmd', 'a.com', 'a.msi', 'a.scr', 'a.dll', 'a.jse', 'a.vbs', 'a.vbe', 'a.wsf', 'a.ps1', 'a.lnk', 'a.jar', 'a.hta', 'a.apk', 'UPPER.EXE', 'trailing.pdf.exe', 'report.exe.txt']) {
    const result = scan(name, S.text('harmless words'));
    assert.ok(result.reasons.includes('DOUBLE_EXTENSION'), name);
    assert.equal(result.verdict, 'suspicious', name);
  }
  assert.ok(scan('invoice\u202Efdp.exe', S.text('x')).reasons.includes('DOUBLE_EXTENSION'));
  assert.ok(scan('cod\u202Etxt.js', S.text('x')).reasons.includes('DOUBLE_EXTENSION'));
  for (const name of ['report.pdf', 'archive.tar.gz', 'my.photo.final.jpg', '.env', 'v1.2.notes.txt', 'run.executive.txt']) assert.ok(!scan(name, S.text('x')).reasons.includes('DOUBLE_EXTENSION'), name);
});

test('PDF_ACTIVE: /JavaScript, /JS, /OpenAction, /AA, /Launch, /RichMedia and /EmbeddedFile each hold a PDF', () => {
  for (const marker of ['/JavaScript', '/JS (app.alert(1))', '/OpenAction 5 0 R', '/AA << >>', '/Launch', '/RichMedia', '/EmbeddedFile']) {
    const result = scan('form.pdf', S.pdfWith(marker), 'application/pdf');
    assert.deepEqual(result.reasons, ['PDF_ACTIVE'], marker);
    assert.equal(result.verdict, 'suspicious', marker);
  }
  // active content near the end of a large PDF is still seen (the end of the file is searched too)
  const big = Buffer.concat([S.text('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024, 0x20), S.text('<< /OpenAction 1 0 R >>\n%%EOF')]);
  assert.deepEqual(scan('big.pdf', big).reasons, ['PDF_ACTIVE']);
});

test('OFFICE_MACRO: an OOXML zip with vbaProject.bin or macro parts, and an old OLE file with VBA streams or auto-open markers', () => {
  assert.deepEqual(reasonsOf('m.docm', S.docm()), ['OFFICE_MACRO']);
  assert.deepEqual(reasonsOf('m.docx', S.docm()), ['OFFICE_MACRO'], 'whatever the extension says');
  assert.deepEqual(reasonsOf('x.xlsm', S.zip([{ name: '[Content_Types].xml' }, { name: 'xl/macrosheets/sheet1.xml' }])), ['OFFICE_MACRO']);
  assert.equal(scan('m.docm', S.docm()).verdict, 'suspicious');
  assert.deepEqual(reasonsOf('old.doc', S.oleMacro()), ['OFFICE_MACRO']);
  assert.deepEqual(reasonsOf('old.xls', Buffer.concat([S.oleClean(), S.text('Auto_Open')])), ['OFFICE_MACRO']);
  assert.equal(scan('letter.docx', S.docx()).verdict, 'clean');
});

test('ACTIVE_MARKUP: <script, javascript: URLs and on*= handlers in SVG, HTML and text', () => {
  assert.deepEqual(reasonsOf('a.svg', S.svgScript()), ['ACTIVE_MARKUP']);
  assert.deepEqual(reasonsOf('a.svg', S.svgHandler()), ['ACTIVE_MARKUP']);
  assert.deepEqual(reasonsOf('page.html', S.htmlJsUrl()), ['ACTIVE_MARKUP']);
  assert.deepEqual(reasonsOf('page.html', S.text('<img src=x onerror = "alert(1)">')), ['ACTIVE_MARKUP']);
  assert.deepEqual(reasonsOf('snippet.txt', S.text('use <SCRIPT>x</SCRIPT> here')), ['ACTIVE_MARKUP'], 'case does not matter');
  assert.equal(scan('a.svg', S.svgScript()).verdict, 'suspicious');
});

test('ARCHIVE_ABUSE: too many entries, a huge declared ratio, nested archives, ../ and absolute paths, encrypted entries', () => {
  const many = S.zip(Array.from({ length: 1001 }, (_, n) => ({ name: `f${n}.txt` })));
  assert.deepEqual(reasonsOf('many.zip', many), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('bomb.zip', S.zip([{ name: 'big.bin', compressedSize: 1000, size: 500 * 1024 * 1024 }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('nest.zip', S.zip([{ name: 'inner.zip' }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('trav.zip', S.zip([{ name: '../outside.txt' }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('trav.zip', S.zip([{ name: 'a/../../outside.txt' }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('abs.zip', S.zip([{ name: '/etc/passwd' }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('abs.zip', S.zip([{ name: 'C:\\Windows\\x.txt' }])), ['ARCHIVE_ABUSE']);
  assert.deepEqual(reasonsOf('enc.zip', S.zip([{ name: 'secret.txt', flags: 1 }])), ['ARCHIVE_ABUSE']);
  assert.equal(scan('enc.zip', S.zip([{ name: 'secret.txt', flags: 1 }])).verdict, 'suspicious');
  assert.equal(scan('fine.zip', S.zip([{ name: 'docs/a.txt' }, { name: 'docs/b.txt' }])).verdict, 'clean');
});

test('KNOWN_TEST_SIGNATURE and a program in disguise are BLOCKED; a program\'s own name alone is only suspicious', () => {
  const signature = scan('eicar.txt', S.testSignature());
  assert.equal(signature.verdict, 'blocked');
  assert.deepEqual(signature.reasons, ['KNOWN_TEST_SIGNATURE']);
  assert.equal(scan('inside.txt', Buffer.concat([S.text('hello '), S.testSignature(), S.text(' bye')])).verdict, 'blocked', 'found anywhere, not only at the start');
  assert.equal(scan('x.docx', Buffer.concat([S.docx(), S.testSignature()])).verdict, 'blocked');

  const exe = scan('report.pdf', S.fakeProgram());
  assert.equal(exe.verdict, 'blocked');
  assert.ok(exe.reasons.includes('EXECUTABLE_CONTENT') && exe.reasons.includes('TYPE_MISMATCH'));
  assert.equal(scan('photo.png', S.fakeElf()).verdict, 'blocked');
  assert.equal(scan('setup.exe', S.fakeProgram()).verdict, 'blocked');
  // "MZ" text without a real header is not a program
  assert.equal(scan('letters.txt', S.text('MZ is a pair of letters')).verdict, 'clean');
  assert.equal(scan('note.exe', S.text('MZ plain words, not a program')).verdict, 'suspicious');
});

test('a PDF form with JavaScript is suspicious, not blocked: a false positive is recoverable', () => {
  const result = scan('tax-form.pdf', S.pdfWith('/AA << /JavaScript 1 0 R >>'));
  assert.equal(result.verdict, 'suspicious');
  assert.notEqual(result.verdict, 'blocked');
});

test('the score is the sum of the weights, capped at 100; the threshold is documented and used', () => {
  assert.equal(SUSPICIOUS_THRESHOLD, 40);
  const both = scan('report.pdf.exe', S.pdfWith('/JavaScript'));
  assert.deepEqual(both.reasons.sort(), ['DOUBLE_EXTENSION', 'PDF_ACTIVE', 'TYPE_MISMATCH'].sort().filter((c) => both.reasons.includes(c)));
  assert.equal(both.score, Math.min(100, both.reasons.reduce((sum, code) => sum + REASONS[code].weight, 0)));
  assert.ok(both.score <= 100);
});

test('every reason has a weight, a severity and a plain sentence, and none of the UI words that are not to be used', () => {
  for (const [code, row] of Object.entries(REASONS)) {
    assert.ok(Number.isFinite(row.weight) && row.weight >= 0, code);
    assert.ok(['low', 'medium', 'high'].includes(row.severity), code);
    assert.ok(row.text.length > 20 && /[.]$/.test(row.text), code);
    assert.doesNotMatch(row.text, /sandbox|\bAI\b/i, code);
  }
  assert.deepEqual(describeReasons(['PDF_ACTIVE', 'NOT_A_CODE']).map((r) => r.code), ['PDF_ACTIVE']);
  assert.equal(severityOf(['TYPE_MISMATCH', 'OFFICE_MACRO']), 'high');
  assert.equal(severityOf(['PDF_ACTIVE']), 'medium');
  assert.equal(severityOf([]), 'low');
});

// ---------- limits and safety ----------

test('a 4 MB file is scanned in under 50 ms (each kind of worst case)', () => {
  const four = 4 * 1024 * 1024;
  const pdfBig = Buffer.concat([S.text('%PDF-1.4\n'), Buffer.alloc(four - 9, 0x41)]);
  const textBig = Buffer.alloc(four, 0x61);
  const zipBig = Buffer.concat([S.docx(), Buffer.alloc(four - 400, 0)]);
  const oleBig = Buffer.concat([S.oleClean(), Buffer.alloc(four - 208, 0x55)]);
  for (const [name, buffer] of [['big.pdf', pdfBig], ['big.txt', textBig], ['big.docx', zipBig], ['big.doc', oleBig], ['big.bin', Buffer.alloc(four, 0x7f)]]) {
    scan(name, buffer); // warm
    const started = process.hrtime.bigint();
    scan(name, buffer);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
  }
});

test('the scanner only reads the bytes: no network, no file system, no child process, no decompression, no code run', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'fileScanner.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /require\((['"])(fs|net|http|https|child_process|dns|zlib|vm|worker_threads|node:[a-z_]+)\1\)/);
  assert.doesNotMatch(source, /\b(eval|Function)\s*\(|inflate|gunzip|unzip|fetch\(/);
  const require_ = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(require_, [], 'no dependency at all');
});

test('no file of the project holds the antivirus test string whole (Windows Defender and GitHub would flag it)', () => {
  const needle = ['X5O!P%@AP[4\\PZX54', '(P^)7CC)7}$EICAR'].join('');
  const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'client', 'src'), path.join(__dirname, '..', '..', 'client', 'scripts'), path.join(__dirname, '..', '..', 'docs')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs|md|json|txt|html)$/.test(entry.name)) assert.ok(!fs.readFileSync(full, 'utf8').includes(needle), full);
    }
  };
  roots.forEach((root) => fs.existsSync(root) && walk(root));
});

test('a buffer that is not a Buffer is an error for the caller to handle (the upload path then saves the file unchecked)', () => {
  assert.throws(() => scanBuffer({ name: 'a.txt', buffer: 'not a buffer' }), /needs a Buffer/);
});
