/**
 * A small PDF writer, in plain code (no library): one JPEG per page, embedded as it is (DCTDecode), each page as large as the
 * picture's shape (the longest side is 842 points, an A4 sheet's), with a real cross-reference table.
 *
 *   1 Catalog, 2 Pages, then for page i (from 0): 3+3i the Page, 4+3i its content stream, 5+3i the image.
 *
 * @param {Array<{ jpeg: Uint8Array, width: number, height: number }>} pages
 * @returns {Uint8Array}
 */
const encoder = new TextEncoder();
const LONG_SIDE = 842;

const isJpeg = (bytes) => bytes instanceof Uint8Array && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const points = (value) => Number(value.toFixed(2)).toString();

export function buildPdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('A PDF needs at least one page.');
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const begin = (number) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // a comment of high bytes: tells tools this file is binary

  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + 3 * index} 0 R`).join(' ')}] >>\nendobj\n`);

  pages.forEach((page, index) => {
    if (!isJpeg(page.jpeg)) throw new Error('A page is not a JPEG image.');
    const scale = LONG_SIDE / Math.max(page.width, page.height);
    const width = points(page.width * scale);
    const height = points(page.height * scale);
    const pageObject = 3 + 3 * index;
    const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;

    begin(pageObject);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${pageObject + 2} 0 R >> >> /Contents ${pageObject + 1} 0 R >>\nendobj\n`);
    begin(pageObject + 1);
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    begin(pageObject + 2);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
    );
    push(page.jpeg);
    push('\nendstream\nendobj\n');
  });

  const count = 3 + 3 * pages.length;
  const xrefAt = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let number = 1; number < count; number += 1) push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
