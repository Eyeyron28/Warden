const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'none';
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return 'none';
}

function sniffPreviewKind(buffer) {
  if (!Buffer.isBuffer(buffer)) return 'none';
  if (sniffImageType(buffer) !== 'none') return 'image';
  if (buffer.toString('latin1', 0, Math.min(buffer.length, 1024)).includes('%PDF-')) return 'pdf';
  return 'none';
}

module.exports = { IMAGE_TYPES, sniffImageType, sniffPreviewKind };
