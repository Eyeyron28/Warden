// Small REAL sample files, generated in memory (nothing is committed as a binary).
// Each entry says what its bytes are (`sniff`: the extension utils/fileNames.js
// should recover, or null when the bytes are not unmistakably a known type) and
// whether Photos should treat it as an image (`photo`).
const zlib = require('node:zlib');

const text = (value) => Buffer.from(value, 'utf8');

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function pdf() {
  const body = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  return text(body);
}
const ole = () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(56, 7)]);
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp', 'latin1'), Buffer.from(brand, 'latin1'), Buffer.alloc(24, 1)]);
const riff = (tag, pad = 24) => Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([40, 0, 0, 0]), Buffer.from(tag, 'latin1'), Buffer.alloc(pad, 3)]);
const OFFICE_CT = '<Types/>';

/** [{ ext, bytes, sniff: expected extension | null, photo: boolean }] */
const SAMPLES = [
  // documents
  { ext: 'pdf', bytes: pdf(), sniff: 'pdf' },
  { ext: 'doc', bytes: ole(), sniff: null },
  { ext: 'docx', bytes: zip({ '[Content_Types].xml': OFFICE_CT, 'word/document.xml': '<w/>' }), sniff: 'docx' },
  { ext: 'rtf', bytes: text('{\\rtf1\\ansi Hello}'), sniff: null },
  { ext: 'odt', bytes: zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<c/>' }), sniff: null },
  { ext: 'txt', bytes: text('plain text\nsecond line\n'), sniff: null },
  { ext: 'md', bytes: text('# Heading\n\nSome *markdown*.\n'), sniff: null },
  { ext: 'csv', bytes: text('a,b,c\n1,2,3\n'), sniff: null },
  // spreadsheets and slides
  { ext: 'xls', bytes: ole(), sniff: null },
  { ext: 'xlsx', bytes: zip({ '[Content_Types].xml': OFFICE_CT, 'xl/workbook.xml': '<w/>' }), sniff: null },
  { ext: 'ods', bytes: zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<c/>' }), sniff: null },
  { ext: 'ppt', bytes: ole(), sniff: null },
  { ext: 'pptx', bytes: zip({ '[Content_Types].xml': OFFICE_CT, 'ppt/presentation.xml': '<p/>' }), sniff: null },
  { ext: 'odp', bytes: zip({ mimetype: 'application/vnd.oasis.opendocument.presentation', 'content.xml': '<c/>' }), sniff: null },
  // images
  { ext: 'png', bytes: png(), sniff: 'png', photo: true },
  { ext: 'jpg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF', 'latin1'), Buffer.alloc(30, 9), Buffer.from([0xff, 0xd9])]), sniff: 'jpg', photo: true },
  { ext: 'jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(30, 5), Buffer.from([0xff, 0xd9])]), sniff: 'jpg', photo: true },
  { ext: 'gif', bytes: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.from([0x3b])]), sniff: 'gif', photo: true },
  { ext: 'webp', bytes: riff('WEBP'), sniff: 'webp', photo: true },
  { ext: 'bmp', bytes: Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(60, 0)]), sniff: null },
  { ext: 'svg', bytes: text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), sniff: null },
  { ext: 'heic', bytes: ftyp('heic'), sniff: 'heic' },
  { ext: 'ico', bytes: Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]), Buffer.alloc(40, 2)]), sniff: null },
  // audio and video
  { ext: 'mp3', bytes: Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(30, 4)]), sniff: 'mp3' },
  { ext: 'wav', bytes: riff('WAVEfmt '), sniff: 'wav' },
  { ext: 'm4a', bytes: ftyp('M4A '), sniff: 'm4a' },
  { ext: 'mp4', bytes: ftyp('isom'), sniff: 'mp4' },
  { ext: 'webm', bytes: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(24, 6)]), sniff: 'webm' },
  { ext: 'mov', bytes: ftyp('qt  '), sniff: 'mov' },
  // archives and other
  { ext: 'zip', bytes: zip({ 'a.txt': 'hello' }), sniff: null },
  { ext: '7z', bytes: Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), Buffer.alloc(30, 8)]), sniff: null },
  { ext: 'rar', bytes: Buffer.concat([Buffer.from('Rar!', 'latin1'), Buffer.from([0x1a, 0x07, 0x00]), Buffer.alloc(30, 8)]), sniff: null },
  { ext: 'json', bytes: text('{"a":1,"b":[1,2,3]}'), sniff: null },
  { ext: 'xml', bytes: text('<?xml version="1.0"?><root><a>1</a></root>'), sniff: null },
  { ext: 'html', bytes: text('<!doctype html><html><body><script>window.__pwned=1</script>hi</body></html>'), sniff: null },
  { ext: 'js', bytes: text('console.log("hello");\n'), sniff: null },
  { ext: 'exe', bytes: Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(62, 0), Buffer.from('This is a harmless dummy, not a program.', 'latin1')]), sniff: null },
].map((sample) => ({ photo: false, ...sample }));

/** Names that exercise the naming rules. `expectDownload` is the expected download name (null = same as the input). */
const NAMES = [
  { name: 'report.final.v2.docx', note: 'several dots' },
  { name: 'PHOTO.JPG', note: 'uppercase extension' },
  { name: 'Résumé 履歴.pdf', note: 'non-ASCII' },
  { name: `${'x'.repeat(300)}.pdf`, note: 'very long', long: true },
  { name: '.env', note: 'leading dot' },
  { name: 'trailing.pdf   ', note: 'trailing spaces', expectDownload: 'trailing.pdf' },
  { name: 'a"b\\c/d..pdf', note: 'quotes and path separators', hostile: true },
  { name: 'noextension', note: 'no extension at all' },
];

module.exports = { SAMPLES, NAMES };
