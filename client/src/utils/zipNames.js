export const MAX_ZIP_ENTRIES = 5000;

export function readZipDirectory(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entryCount > MAX_ZIP_ENTRIES) return { names: [], entryCount, totalUncompressed: Infinity };

  const names = [];
  let totalUncompressed = 0;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    totalUncompressed += uncompressed;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names, entryCount, totalUncompressed };
}

export function readZipEntries(bytes, maxEntries = MAX_ZIP_ENTRIES) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || offset === 0xffffffff) return { entries: [], entryCount: Infinity };
  if (entryCount > maxEntries) return { entries: [], entryCount };

  const entries = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      compressedSize,
      uncompressedSize,
      encrypted: (flags & 1) === 1,
      zip64: compressedSize === 0xffffffff || uncompressedSize === 0xffffffff,
      method,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, entryCount };
}
