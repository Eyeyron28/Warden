import { readZipDirectory } from './zipNames.js';

/**
 * What a file REALLY is, decided from its bytes against a short allowlist -
 * never from the stored filename or a declared type (both are chosen by
 * whoever uploaded the file). The preview viewer builds its own Blob typed
 * from PREVIEW_MIME below, so the answer here is the only thing that ever
 * decides how bytes are shown.
 *
 * kinds:
 *   image | pdf | docx | audio | video | text   - can be previewed
 *   markup   - HTML / SVG / XML: never rendered, download only
 *   none     - anything else (including .xlsx and .pptx): "No preview available"
 */

/** The only content types a preview Blob can ever carry. */
export const PREVIEW_MIME = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
});

// The upload cap is 4MB; a legacy file above it is "too large to preview".
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
// A .docx is a ZIP: refuse one that claims to inflate to more than this.
export const MAX_DOCX_UNCOMPRESSED = 64 * 1024 * 1024;

const startsWith = (bytes, signature, offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

function sniffText(bytes) {
  const sample = bytes.subarray(0, 64 * 1024);
  let controls = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const byte = sample[i];
    if (byte === 0) return 'none';
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) controls += 1;
  }
  if (sample.length > 0 && controls / sample.length > 0.02) return 'none';
  try {
    // `stream` lets the sample end in the middle of a multi-byte character.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
  } catch {
    return 'none';
  }
  const head = new TextDecoder('utf-8').decode(sample.subarray(0, 4096)).replace(/^﻿/, '').toLowerCase();
  // A file that IS a web page or an SVG starts like one (or plainly contains <html / <svg).
  // Text that merely mentions a tag, such as a markdown note about <script>, is still
  // just text: it is shown as characters and nothing in it can run.
  if (/^\s*<(\?xml|!doctype|html|svg|script|head|body)/.test(head)) return 'markup';
  if (/<(svg|html)[\s>/]|<!doctype html/.test(head)) return 'markup';
  return 'text';
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ kind: 'image'|'pdf'|'docx'|'audio'|'video'|'text'|'markup'|'none', mime: string|null, note?: string }}
 */
export function sniffPreviewType(bytes) {
  if (!(bytes instanceof Uint8Array)) return { kind: 'none', mime: null };
  if (bytes.length === 0) return { kind: 'text', mime: null };

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: PREVIEW_MIME.png };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: PREVIEW_MIME.jpeg };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { kind: 'image', mime: PREVIEW_MIME.gif };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { kind: 'image', mime: PREVIEW_MIME.webp };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    return { kind: 'audio', mime: PREVIEW_MIME.wav };
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return { kind: 'pdf', mime: PREVIEW_MIME.pdf };

  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) {
    return { kind: 'audio', mime: PREVIEW_MIME.mp3 };
  }
  if (ascii(bytes, 0, 4) === 'OggS') return { kind: 'audio', mime: PREVIEW_MIME.ogg };
  if (ascii(bytes, 0, 4) === 'fLaC') return { kind: 'audio', mime: PREVIEW_MIME.flac };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mime: PREVIEW_MIME.webm };
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    return /^M4[AB] $/.test(brand) ? { kind: 'audio', mime: PREVIEW_MIME.m4a } : { kind: 'video', mime: PREVIEW_MIME.mp4 };
  }

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = readZipDirectory(bytes);
    if (zip && zip.names.includes('word/document.xml') && zip.names.includes('[Content_Types].xml')) {
      if (zip.entryCount > 2000 || zip.totalUncompressed > MAX_DOCX_UNCOMPRESSED) {
        return { kind: 'none', mime: null, note: 'This document is too complex to preview safely.' };
      }
      return { kind: 'docx', mime: null };
    }
    return { kind: 'none', mime: null };
  }

  const text = sniffText(bytes);
  return { kind: text, mime: null };
}
