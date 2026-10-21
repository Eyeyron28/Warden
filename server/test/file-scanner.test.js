const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanBuffer, describeReasons, severityOf, REASONS, SCANNER_VERSION, SUSPICIOUS_THRESHOLD } = require('../utils/fileScanner');
const S = require('./helpers/riskySamples');

const scan = (name, buffer, type = '') => scanBuffer({ name, type, buffer });
const reasonsOf = (name, buffer, type) => scan(name, buffer, type).reasons.sort();

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

test('a 4 MB file is scanned in under 50 ms (each kind of worst case)', () => {
  const four = 4 * 1024 * 1024;
  const pdfBig = Buffer.concat([S.text('%PDF-1.4\n'), Buffer.alloc(four - 9, 0x41)]);
  const textBig = Buffer.alloc(four, 0x61);
  const zipBig = Buffer.concat([S.docx(), Buffer.alloc(four - 400, 0)]);
  const oleBig = Buffer.concat([S.oleClean(), Buffer.alloc(four - 208, 0x55)]);
  for (const [name, buffer] of [['big.pdf', pdfBig], ['big.txt', textBig], ['big.docx', zipBig], ['big.doc', oleBig], ['big.bin', Buffer.alloc(four, 0x7f)]]) {
    scan(name, buffer);
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

test('docs/QUARANTINE.md: the rules table matches the code, the honest limits are there, and the forbidden words are not', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'QUARANTINE.md'), 'utf8');
  for (const [code, row] of Object.entries(REASONS)) {
    assert.ok(doc.includes(`\`${code}\``), `${code} is described`);
    if (row.weight > 0) assert.match(doc, new RegExp(`\`${code}\` \\| ${row.weight}\\b`), `${code} has weight ${row.weight}`);
  }
  assert.ok(doc.includes(`at or above **${SUSPICIOUS_THRESHOLD}**`));
  for (const needle of ['not an antivirus', 'encrypted archives', 'runs no code', 'before this\nfeature existed were not scanned'.replace('\n', ' ')]) assert.ok(doc.replace(/\s+/g, ' ').includes(needle), needle);
  assert.doesNotMatch(doc, /sandbox|\bAI\b/i);
  const limits = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'KNOWN-LIMITS.md'), 'utf8');
  assert.match(limits, /## Quarantine \(the upload scanner\)/);
  assert.doesNotMatch(limits.slice(limits.indexOf('## Quarantine')), /sandbox/i);
});

test('make-demo-samples writes only harmless files that the rules hold, and never the antivirus test file', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'make-demo-samples.mjs'), 'utf8');
  assert.doesNotMatch(script, /EICAR|X5O!P/);
  assert.doesNotMatch(script, /sandbox|\bAI\b/i);
  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'make-demo-samples.mjs')], { encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
  assert.equal(run.status, 0, run.stderr);
  const folder = path.join(__dirname, '..', '..', 'demo-samples');
  const files = fs.readdirSync(folder);
  assert.ok(files.length >= 3);
  for (const name of files) {
    const buffer = fs.readFileSync(path.join(folder, name));
    assert.ok(!buffer.includes(S.testSignature()), `${name} is not the test file`);
    assert.equal(scan(name, buffer).verdict, 'suspicious', `${name} is held`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8'), /^demo-samples\/$/m);
});

const { isPlainZip } = require('../utils/fileScanner');

test('plain zip: the name ends in .zip (any case), or the bytes are a zip with no sign of a document format - whatever the name says', () => {
  const plain = S.zip([{ name: 'a.txt' }, { name: 'dir/b.txt' }]);
  assert.equal(isPlainZip('archive.zip', Buffer.from('not even bytes of a zip')), true);
  assert.equal(isPlainZip('ARCHIVE.ZIP', plain), true);
  for (const name of ['archive.bin', 'archive', 'archive.txt', 'photo.jpg', 'report.pdf', 'archive.zip.bin']) assert.equal(isPlainZip(name, plain), true, `renamed: ${name}`);
  assert.equal(isPlainZip('empty.bin', Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])), true, 'an empty zip is a zip');
  assert.equal(isPlainZip('broken.bin', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)])), true, 'a zip whose names cannot be read is not shown to be anything else');
});

test('Word, Excel, PowerPoint, OpenDocument, EPUB and jar-like files are NOT plain zips', () => {
  const office = (part) => S.zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: part, data: '<x/>' }]);
  for (const [name, buffer] of [
    ['letter.docx', office('word/document.xml')],
    ['sheet.xlsx', office('xl/workbook.xml')],
    ['deck.pptx', office('ppt/presentation.xml')],
    ['letter.odt', S.zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml' }])],
    ['calc.ods', S.zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' }, { name: 'content.xml' }])],
    ['book.epub', S.zip([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'META-INF/container.xml' }, { name: 'OEBPS/c.xhtml' }])],
    ['tool.jar', S.zip([{ name: 'META-INF/MANIFEST.MF' }, { name: 'A.class' }])],
    ['noext-docx', office('word/document.xml')],
  ]) {
    assert.equal(isPlainZip(name, buffer), false, name);
  }
  assert.equal(isPlainZip('note.txt', Buffer.from('plain text')), false);
  assert.equal(isPlainZip('photo.png', S.png()), false);
});

test('ARCHIVE_UNINSPECTABLE: rar, 7z, tar, gz, tgz, bz2 and xz, by ending or by signature, are held (weight 45)', () => {
  assert.equal(REASONS.ARCHIVE_UNINSPECTABLE.weight, 45);
  assert.equal(REASONS.ARCHIVE_UNINSPECTABLE.text, 'Warden cannot look inside this kind of archive.');
  for (const name of ['a.rar', 'a.7z', 'a.tar', 'a.gz', 'a.tgz', 'a.bz2', 'a.xz', 'A.RAR', 'backup.tar.gz']) {
    const result = scan(name, Buffer.from('words only'));
    assert.deepEqual(result.reasons, ['ARCHIVE_UNINSPECTABLE'], name);
    assert.equal(result.verdict, 'suspicious', name);
  }
  const pad = Buffer.alloc(300, 0x20);
  const tar = Buffer.from(pad);
  tar.write('ustar', 257, 'latin1');
  for (const [label, head] of [['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]], ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ['gzip', [0x1f, 0x8b, 0x08]], ['bzip2', [0x42, 0x5a, 0x68, 0x39]], ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]]]) {
    const result = scan('renamed.bin', Buffer.concat([Buffer.from(head), pad]));
    assert.ok(result.reasons.includes('ARCHIVE_UNINSPECTABLE'), label);
    assert.equal(result.verdict, 'suspicious', label);
  }
  assert.equal(scan('renamed.bin', tar).verdict, 'suspicious', 'tar by its header');
  assert.equal(scan('notes.txt', Buffer.from('a tarball is not a name ending')).verdict, 'clean');
  assert.equal(scan('photo.png', S.png()).verdict, 'clean');
});
