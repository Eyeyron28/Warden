import { readZipDirectory } from './zipNames.js';

/**
 * File names in the browser: a mirror of server/utils/fileNames.js (a test
 * keeps the two identical), used where the browser itself names a download -
 * share links, whose names and bytes the server never sees - and as a last
 * sanitising step before anything is saved.
 */

const MAX_DOWNLOAD_NAME = 120;
const MAX_EXTENSION = 16;
const FORBIDDEN_IN_DOWNLOAD = '/\\:*?"<>|';
const isControl = (code) => code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f);
const isBidiOverride = (code) => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

/** { base: 'report.final', ext: 'docx' } for "report.final.docx". A leading dot (".env") or a non-extension tail has no extension. */
export function splitName(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return { base: text, ext: '' };
  const ext = text.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return { base: text, ext: '' };
  return { base: text.slice(0, dot), ext };
}

export function sanitizeDownloadName(name, max = MAX_DOWNLOAD_NAME) {
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
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'M4V ']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/** The extension the BYTES call for (never the name or a claimed type), or null when unknown. */
export function sniffExtension(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4) return null;
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
    const zip = readZipDirectory(b);
    return zip && zip.names.includes('word/document.xml') && zip.names.includes('[Content_Types].xml') ? 'docx' : null;
  }
  return null;
}

/** Adds `.ext` only when the name has no extension and one is known. */
export function withSniffedExtension(name, ext) {
  if (!ext || splitName(name).ext) return name;
  return `${name}.${ext}`;
}

/** The name a download should carry: sanitised, with a missing extension recovered from the bytes. */
export function downloadName(storedName, bytes) {
  const clean = sanitizeDownloadName(storedName);
  return sanitizeDownloadName(withSniffedExtension(clean, sniffExtension(bytes)));
}

/**
 * The file name in a Content-Disposition header. RFC 5987 `filename*=` (the real,
 * possibly non-ASCII name) wins over the quoted ASCII fallback, whichever comes first.
 */
export function filenameFromDisposition(header, fallback = 'document') {
  const text = String(header ?? '');
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the quoted name
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(text) || /filename\s*=\s*([^;]+)/i.exec(text);
  return quoted ? quoted[1].trim() : fallback;
}

/**
 * Rename: the original extension stays unless the person deliberately types a
 * different one. A new name with no extension gets the old one back; ending the
 * new name with a dot ("notes.") is the deliberate way to remove it.
 */
export function keepExtension(oldName, newName) {
  const typed = String(newName ?? '').trim();
  if (typed === '') return '';
  const old = splitName(oldName);
  if (typed.endsWith('.') && typed.length > 1) return typed.slice(0, -1).trimEnd();
  const typedExt = splitName(typed).ext;
  if (!old.ext || (typedExt && /[A-Za-z]/.test(typedExt))) return typed;
  return `${typed}.${old.ext}`;
}
