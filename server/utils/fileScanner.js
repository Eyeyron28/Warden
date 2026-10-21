const SCANNER_VERSION = 1;

const SUSPICIOUS_THRESHOLD = 40;

const SEARCH_CAP = 1024 * 1024;

const REASONS = Object.freeze({
  TYPE_MISMATCH: { weight: 30, severity: 'low', text: 'The name says one kind of file, but the content looks like another.' },
  DOUBLE_EXTENSION: { weight: 45, severity: 'medium', text: 'The name ends like a program or script, or hides its real ending behind a second one (for example report.pdf.exe).' },
  PDF_ACTIVE: { weight: 45, severity: 'medium', text: 'This PDF contains active content (scripts, automatic actions or embedded files).' },
  OFFICE_MACRO: { weight: 60, severity: 'high', text: 'This Office file contains macros, small programs that can run when it is opened.' },
  ACTIVE_MARKUP: { weight: 45, severity: 'medium', text: 'This file contains script code that a browser would run.' },
  ARCHIVE_ABUSE: { weight: 50, severity: 'medium', text: 'This archive looks unsafe: too many entries, an unusual size ratio, archives inside it, odd paths, or entries that cannot be inspected.' },
  ARCHIVE_UNINSPECTABLE: { weight: 45, severity: 'medium', text: 'Warden cannot look inside this kind of archive.' },
  PLAIN_ZIP: { weight: 0, severity: 'low', text: 'Zip files go through Export / Import, so every file inside is checked.' },
  EXECUTABLE_CONTENT: { weight: 100, severity: 'high', text: 'This file is a program (executable), whatever its name says.' },
  KNOWN_TEST_SIGNATURE: { weight: 100, severity: 'high', text: 'This file carries the standard antivirus test signature.' },
  SCAN_ERROR: { weight: 0, severity: 'low', text: 'The check could not be completed, so the file was saved without one.' },
});

const BLOCKING = new Set(['KNOWN_TEST_SIGNATURE', 'EXECUTABLE_CONTENT']);

const EXECUTABLE_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'bat', 'cmd', 'com', 'msi', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'ps1', 'lnk', 'jar', 'hta', 'apk']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'zip']);
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'md', 'json', 'log', 'xml', 'html', 'htm', 'xhtml', 'svg']);
const MARKUP_EXTENSIONS = new Set(['svg', 'html', 'htm', 'xhtml', 'xml', 'shtml']);
const ARCHIVE_NAME = /\.(zip|jar|7z|rar|gz|tgz|tar|bz2|xz|cab)$/i;
const UNINSPECTABLE_NAME = /\.(rar|7z|tar|gz|tgz|bz2|xz)$/i;

const EXPECTED = Object.freeze({
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', pdf: 'pdf',
  docx: 'zip', xlsx: 'zip', pptx: 'zip', zip: 'zip', doc: 'ole', xls: 'ole', ppt: 'ole',
});
const DECLARED = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
});
const BINARY_KINDS = new Set(['png', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'ole', 'exe', 'elf', 'macho']);

const TEST_SIGNATURE = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''), 'latin1');

const lower = (value) => String(value || '').toLowerCase();

function searchWindow(buffer) {
  if (buffer.length <= SEARCH_CAP * 2) return buffer;
  return Buffer.concat([buffer.subarray(0, SEARCH_CAP), buffer.subarray(buffer.length - SEARCH_CAP)]);
}

function detectKind(buffer) {
  const b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 5 && b.toString('latin1', 0, Math.min(b.length, 1024)).includes('%PDF-')) return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return 'zip';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1) return 'ole';
  if (isPortableExecutable(b)) return 'exe';
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'elf';
  if (b.length >= 4 && ((b.readUInt32BE(0) === 0xfeedface) || (b.readUInt32BE(0) === 0xfeedfacf) || (b.readUInt32LE(0) === 0xfeedface) || (b.readUInt32LE(0) === 0xfeedfacf))) return 'macho';
  const head = b.subarray(0, Math.min(b.length, 8192));
  return head.includes(0) ? 'other' : 'text';
}

function isPortableExecutable(b) {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const offset = b.readUInt32LE(0x3c);
  return offset >= 0x40 && offset + 4 <= b.length && b[offset] === 0x50 && b[offset + 1] === 0x45 && b[offset + 2] === 0 && b[offset + 3] === 0;
}

function splitName(name) {
  const clean = String(name || '').replace(/[\\/]+/g, '/').split('/').pop();
  const parts = clean.split('.');
  if (parts.length < 2 || (parts.length === 2 && parts[0] === '')) return { base: clean, extensions: [] };
  return { base: parts[0], extensions: parts.slice(1).map((part) => lower(part.trim())) };
}

function isUninspectableArchive(name, buffer) {
  if (UNINSPECTABLE_NAME.test(String(name || '').trim())) return true;
  const b = buffer;
  if (b.length >= 6 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07) return true;
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return true;
  if (b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08) return true;
  if (b.length >= 3 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return true;
  if (b.length >= 6 && b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a && b[5] === 0x00) return true;
  return b.length >= 262 && b.toString('latin1', 257, 262) === 'ustar';
}

function checkName(name) {
  const raw = String(name || '');
  if (/[‪-‮⁦-⁩]/.test(raw)) return true;
  const { extensions } = splitName(raw);
  if (extensions.length === 0) return false;
  const last = extensions[extensions.length - 1];
  if (EXECUTABLE_EXTENSIONS.has(last)) return true;
  return extensions.length >= 2 && extensions.slice(0, -1).some((ext) => EXECUTABLE_EXTENSIONS.has(ext)) && DOCUMENT_EXTENSIONS.has(last);
}

function checkTypeMismatch(name, type, kind) {
  const { extensions } = splitName(name);
  const ext = extensions[extensions.length - 1] || '';
  const expected = EXPECTED[ext];
  if (expected) return kind !== expected;
  if (TEXT_EXTENSIONS.has(ext)) return BINARY_KINDS.has(kind);
  const declared = DECLARED[lower(type)];
  return Boolean(declared) && kind !== declared;
}

function readZipDirectory(buffer) {
  const minEocd = 22;
  const from = buffer.length - minEocd;
  const stop = Math.max(0, buffer.length - minEocd - 0xffff);
  let eocd = -1;
  for (let i = from; i >= stop; i -= 1) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return { zip64: true, entries: [], count: 0 };
  const entries = [];
  let at = offset;
  const limit = Math.min(count, 5000);
  for (let n = 0; n < limit; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(at + 8);
    const compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    if (at + 46 + nameLength > buffer.length) break;
    entries.push({ name: buffer.toString('utf8', at + 46, at + 46 + nameLength), encrypted: (flags & 1) === 1, compressed, uncompressed, zip64: compressed === 0xffffffff || uncompressed === 0xffffffff });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { zip64: false, entries, count };
}

const ZIP_LIMITS = Object.freeze({ maxEntries: 1000, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 100, ratioFloor: 1024 * 1024 });

function checkArchive(directory, archiveLength) {
  if (!directory) return false;
  if (directory.zip64) return true;
  if (directory.count > ZIP_LIMITS.maxEntries) return true;
  let total = 0;
  for (const entry of directory.entries) {
    if (entry.encrypted || entry.zip64) return true;
    if (/^([\\/]|[a-z]:)/i.test(entry.name) || entry.name.split(/[\\/]/).includes('..')) return true;
    if (ARCHIVE_NAME.test(entry.name)) return true;
    total += entry.uncompressed;
    if (entry.uncompressed > ZIP_LIMITS.ratioFloor && entry.uncompressed / Math.max(entry.compressed, 1) > ZIP_LIMITS.maxRatio) return true;
  }
  if (total > ZIP_LIMITS.maxTotalBytes) return true;
  return total > ZIP_LIMITS.ratioFloor && total / Math.max(archiveLength, 1) > ZIP_LIMITS.maxRatio;
}

function checkOfficeZip(directory) {
  if (!directory) return false;
  return directory.entries.some((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name) || /(^|\/)vbaData\.xml$/i.test(entry.name) || /(^|\/)(macrosheets|macros)\//i.test(entry.name));
}

const OLE_MARKERS = ['_VBA_PROJECT', 'AutoOpen', 'Auto_Open', 'AutoExec', 'Document_Open', 'Workbook_Open'];
function checkOleMacro(window) {
  return OLE_MARKERS.some((marker) => window.includes(Buffer.from(marker, 'latin1')) || window.includes(Buffer.from(marker, 'utf16le')));
}

const PDF_MARKERS = ['/JavaScript', '/JS', '/OpenAction', '/AA', '/Launch', '/RichMedia', '/EmbeddedFile'].map((marker) => Buffer.from(marker, 'latin1'));
const isNameChar = (byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2d;
function hasPdfName(window, marker) {
  let at = window.indexOf(marker);
  while (at !== -1) {
    const next = window[at + marker.length];
    if (next === undefined || !isNameChar(next)) return true;
    at = window.indexOf(marker, at + 1);
  }
  return false;
}
const checkPdf = (window) => PDF_MARKERS.some((marker) => hasPdfName(window, marker));

function checkMarkup(window, name, kind) {
  if (kind !== 'text') return false;
  const { extensions } = splitName(name);
  const ext = extensions[extensions.length - 1] || '';
  const text = window.toString('latin1', 0, Math.min(window.length, SEARCH_CAP)).toLowerCase();
  if (text.includes('<script') || text.includes('javascript:')) return true;
  const markup = MARKUP_EXTENSIONS.has(ext) || /<(svg|html)[\s>]/.test(text.slice(0, 4096));
  return markup && /[\s"'/]on[a-z]{3,20}\s*=/.test(text);
}

function scanBuffer({ name, type = '', buffer }) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('scanBuffer needs a Buffer.');
  const found = new Set();
  const kind = detectKind(buffer);
  const window = searchWindow(buffer);

  if (window.includes(TEST_SIGNATURE)) found.add('KNOWN_TEST_SIGNATURE');
  if (kind === 'exe' || kind === 'elf' || kind === 'macho') found.add('EXECUTABLE_CONTENT');
  if (isUninspectableArchive(name, buffer)) found.add('ARCHIVE_UNINSPECTABLE');
  if (checkName(name)) found.add('DOUBLE_EXTENSION');
  if (buffer.length > 0 && checkTypeMismatch(name, type, kind)) found.add('TYPE_MISMATCH');
  if (kind === 'pdf' && checkPdf(window)) found.add('PDF_ACTIVE');
  if (kind === 'zip') {
    const directory = readZipDirectory(buffer);
    if (checkOfficeZip(directory)) found.add('OFFICE_MACRO');
    if (checkArchive(directory, buffer.length)) found.add('ARCHIVE_ABUSE');
  }
  if (kind === 'ole' && checkOleMacro(window)) found.add('OFFICE_MACRO');
  if (checkMarkup(window, name, kind)) found.add('ACTIVE_MARKUP');

  const reasons = [...found];
  const score = Math.min(100, reasons.reduce((sum, code) => sum + REASONS[code].weight, 0));
  const blocked = reasons.some((code) => BLOCKING.has(code));
  const verdict = blocked ? 'blocked' : score >= SUSPICIOUS_THRESHOLD ? 'suspicious' : 'clean';
  return { verdict, reasons, score, version: SCANNER_VERSION };
}

function isPlainZip(name, buffer) {
  if (/\.zip$/i.test(String(name || '').trim())) return true;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || (buffer[2] !== 0x03 && buffer[2] !== 0x05) || (buffer[3] !== 0x04 && buffer[3] !== 0x06)) return false;
  const directory = readZipDirectory(buffer);
  if (!directory || directory.zip64) return true;
  const names = directory.entries.map((entry) => entry.name);
  if (names.includes('[Content_Types].xml')) return false;
  if (names[0] === 'mimetype') return false;
  if (names.some((entry) => entry.startsWith('META-INF/'))) return false;
  return true;
}

function describeReasons(codes) {
  return (Array.isArray(codes) ? codes : [])
    .filter((code) => Object.prototype.hasOwnProperty.call(REASONS, code))
    .map((code) => ({ code, text: REASONS[code].text, severity: REASONS[code].severity }));
}

function severityOf(codes) {
  const order = ['low', 'medium', 'high'];
  return (Array.isArray(codes) ? codes : []).reduce((worst, code) => {
    const severity = REASONS[code]?.severity || 'low';
    return order.indexOf(severity) > order.indexOf(worst) ? severity : worst;
  }, 'low');
}

module.exports = { scanBuffer, isPlainZip, describeReasons, severityOf, REASONS, SCANNER_VERSION, SUSPICIOUS_THRESHOLD, SEARCH_CAP, ZIP_LIMITS };
