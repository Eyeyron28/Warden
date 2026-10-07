/**
 * File names: what we store, what we put in a download, and how a missing
 * extension is recovered. The browser has a mirror of the pure parts
 * (client/src/utils/fileNames.js); a test keeps the two in step.
 *
 * Rules:
 *  - The STORED name is whatever the owner chose (minus control characters and
 *    path separators); nothing here ever rewrites it.
 *  - A DOWNLOAD name is sanitised (no separators, control or bidi characters,
 *    quotes, Windows-reserved characters, trailing dots/spaces; length limited
 *    with the extension kept) and, only when the stored name has no extension
 *    AND the bytes are unmistakably a known type, gets that type's extension.
 *    An unknown type never gets one.
 */

const MAX_STORED_NAME = 255;
const MAX_DOWNLOAD_NAME = 120;
const MAX_EXTENSION = 16;

const FORBIDDEN_IN_DOWNLOAD = '/\\:*?"<>|';
const isControl = (code) => code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f);
const isBidiOverride = (code) => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

/** The name as stored: no control characters and no path separators. */
function cleanStoredName(name) {
  let out = '';
  for (const char of String(name ?? '')) {
    const code = char.codePointAt(0);
    out += isControl(code) || isBidiOverride(code) || char === '/' || char === '\\' ? '_' : char;
  }
  out = out.trim();
  if ([...out].length > MAX_STORED_NAME) {
    // Cut the base name, never the extension (a plain slice would drop ".pdf" from a long name).
    const { base, ext } = splitName(out);
    const suffix = ext && ext.length <= MAX_EXTENSION ? `.${ext}` : '';
    out = [...(suffix ? base : out)].slice(0, MAX_STORED_NAME - suffix.length).join('').trimEnd() + suffix;
  }
  return out || 'file';
}

/** Splits "report.final.docx" into { base: 'report.final', ext: 'docx' }. A leading dot (".env") or a non-extension tail is not an extension. */
function splitName(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return { base: text, ext: '' };
  const ext = text.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return { base: text, ext: '' };
  return { base: text.slice(0, dot), ext };
}

function sanitizeDownloadName(name, max = MAX_DOWNLOAD_NAME) {
  let out = '';
  for (const char of String(name ?? '')) {
    const code = char.codePointAt(0);
    out += isControl(code) || isBidiOverride(code) || FORBIDDEN_IN_DOWNLOAD.includes(char) ? '_' : char;
  }
  out = out.replace(/^\s+/, '').replace(/[\s.]+$/, '');
  if (out === '' || /^\.+$/.test(out)) return 'file';
  if ([...out].length > max) {
    const { base, ext } = splitName(out);
    const suffix = ext && ext.length <= MAX_EXTENSION ? `.${ext}` : '';
    out = [...(suffix ? base : out)].slice(0, max - suffix.length).join('').replace(/[\s.]+$/, '') + suffix;
  }
  return out;
}

const startsWith = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (b, from, to) => b.toString('latin1', from, to);

/** Minimal ZIP central-directory name list (no inflating), for telling .docx apart. */
function zipNames(buffer) {
  if (buffer.length < 22) return [];
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < Math.min(count, 5000); n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return [];
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extra = buffer.readUInt16LE(offset + 30);
    const comment = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extra + comment;
  }
  return names;
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'M4V ']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * The extension (without the dot) the BYTES call for, or null when they are not
 * unmistakably one of the types below. Never from the name or a claimed type.
 */
function sniffExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const b = buffer;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (ascii(b, 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'wav';
  if (ascii(b, 0, Math.min(b.length, 1024)).includes('%PDF-')) return 'pdf';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'mp3';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return ascii(b, 0, Math.min(b.length, 64)).includes('webm') ? 'webm' : null;
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    if (brand === 'qt  ') return 'mov';
    if (HEIC_BRANDS.has(brand)) return 'heic';
    return MP4_BRANDS.has(brand) ? 'mp4' : null;
  }
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipNames(b);
    return names.includes('word/document.xml') && names.includes('[Content_Types].xml') ? 'docx' : null;
  }
  return null;
}

/** Adds `.ext` only when the name has no extension and one is known. */
function withSniffedExtension(name, ext) {
  if (!ext || splitName(name).ext) return name;
  return `${name}.${ext}`;
}

/** The name a download should carry. */
function downloadName(storedName, buffer) {
  const clean = sanitizeDownloadName(storedName);
  return sanitizeDownloadName(withSniffedExtension(clean, sniffExtension(buffer)));
}

/** A Content-Disposition value: quoted ASCII fallback plus RFC 5987 filename*= for the real name. */
function contentDisposition(name) {
  const safe = sanitizeDownloadName(name);
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  MAX_STORED_NAME,
  MAX_DOWNLOAD_NAME,
  cleanStoredName,
  splitName,
  sanitizeDownloadName,
  sniffExtension,
  withSniffedExtension,
  downloadName,
  contentDisposition,
};
