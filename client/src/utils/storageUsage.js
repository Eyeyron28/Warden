import { formatBytes } from './listing.js';

export function uploadFitsMessage(usage, totalBytes) {
  if (!usage || totalBytes <= usage.availableBytes) return null;
  const needs = formatBytes(totalBytes);
  const todo = 'Delete files or empty Trash to make room, then try again.';
  if (usage.availableBytes < 50 * 1024) return `Your storage is full. This needs ${needs}. ${todo}`;
  return `Not enough storage: this needs ${needs} but only ${formatBytes(usage.availableBytes)} is free. ${todo}`;
}
