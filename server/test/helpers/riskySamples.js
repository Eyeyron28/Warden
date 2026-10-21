const zlib = require('node:zlib');

const text = (value) => Buffer.from(value, 'utf8');
const crc = (buffer) => zlib.crc32(buffer) >>> 0;

function zip(entries, { entryCount } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? 'x', 'utf8');
    const compressedSize = entry.compressedSize ?? data.length;
    const size = entry.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt32LE(crc(data), 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryCount ?? entries.length, 8);
  eocd.writeUInt16LE(entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const plainPdf = () => text('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const pdfWith = (marker) => text(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${marker} >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

function png() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF', 'latin1'), Buffer.alloc(30, 9), Buffer.from([0xff, 0xd9])]);
const docx = () => zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w/>' }]);
const docm = () => zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w/>' }, { name: 'word/vbaProject.bin', data: 'binary-ish' }]);
const oleClean = () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(200, 7)]);
const oleMacro = () => Buffer.concat([oleClean(), Buffer.from('_VBA_PROJECT', 'utf16le'), Buffer.from('Document_Open', 'latin1')]);
const svgScript = () => text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="5" height="5"/></svg>');
const svgHandler = () => text('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5" onload="x()"/></svg>');
const svgClean = () => text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const htmlJsUrl = () => text('<a href="javascript:alert(1)">go</a>');
const fakeProgram = () => {
  const b = Buffer.alloc(256, 0);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  return b;
};
const fakeElf = () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);
const testSignature = () => text(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''));

module.exports = { text, zip, plainPdf, pdfWith, png, jpeg, docx, docm, oleClean, oleMacro, svgScript, svgHandler, svgClean, htmlJsUrl, fakeProgram, fakeElf, testSignature };
