import { formatBytes } from './listing.js';

/**
 * What the storage meter draws, from the server's usage numbers
 * (`GET /api/documents/storage`). The two segments (vault files, Trash) are
 * shares of the quota, so together they are the used percentage.
 */
export function describeUsage(usage) {
  const quota = usage.quotaBytes > 0 ? usage.quotaBytes : 1;
  const pct = (bytes) => Math.min(100, Math.max(0, (bytes / quota) * 100));
  const usedPercent = pct(usage.usedBytes);
  const filesPercent = pct(usage.fileBytes);
  const trashPercent = Math.min(100 - filesPercent, pct(usage.trashBytes));
  return {
    usedPercent,
    filesPercent,
    trashPercent,
    full: usage.usedBytes >= quota,
    nearlyFull: usedPercent >= 90,
    summary: `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used: ${formatBytes(usage.fileBytes)} in files, ${formatBytes(usage.trashBytes)} in Trash`,
  };
}

/**
 * The upload pre-check: would these files fit in what is left? Returns an error
 * message, or null when they fit. The server checks again regardless.
 */
export function uploadFitsMessage(usage, totalBytes) {
  if (!usage || totalBytes <= usage.availableBytes) return null;
  return (
    `Not enough storage: this needs ${formatBytes(totalBytes)} but only ${formatBytes(usage.availableBytes)} of your ` +
    `${formatBytes(usage.quotaBytes)} is free. Delete files and empty Trash to make room.`
  );
}
