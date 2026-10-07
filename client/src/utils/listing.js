/** Sort choices offered in the toolbar of every file view. */
export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'size-desc', label: 'Largest' },
  { value: 'size-asc', label: 'Smallest' },
];

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const time = (value) => (value ? new Date(value).getTime() : 0);

/**
 * Folders first (always), then files. `items` are `{ kind, name, size, modified }`
 * with `kind` 'folder' or anything else for files. "Newest" keeps the order
 * the server sent (newest first) with expiring documents lifted to the top,
 * exactly as the list always behaved.
 */
export function sortItems(items, sortKey) {
  const folders = items.filter((item) => item.kind === 'folder');
  const files = items.filter((item) => item.kind !== 'folder');
  const folderOrder = sortKey === 'name-desc' ? (a, b) => byName(b, a) : byName;
  let sortedFiles;
  switch (sortKey) {
    case 'oldest':
      sortedFiles = [...files].sort((a, b) => time(a.modified) - time(b.modified));
      break;
    case 'name-asc':
      sortedFiles = [...files].sort(byName);
      break;
    case 'name-desc':
      sortedFiles = [...files].sort((a, b) => byName(b, a));
      break;
    case 'size-desc':
      sortedFiles = [...files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      break;
    case 'size-asc':
      sortedFiles = [...files].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
      break;
    default:
      sortedFiles = withUrgency(files);
  }
  return [...[...folders].sort(folderOrder), ...sortedFiles];
}

// Newest first, then expired/expiring-soon documents lifted to the top.
function withUrgency(files) {
  const newest = [...files].sort((a, b) => time(b.modified) - time(a.modified));
  const rank = { expired: 0, expiring_soon: 1 };
  const urgent = newest
    .filter((item) => item.document && rank[item.document.expiryStatus] !== undefined)
    .sort(
      (a, b) =>
        rank[a.document.expiryStatus] - rank[b.document.expiryStatus] ||
        a.document.daysUntilExpiry - b.document.daysUntilExpiry
    );
  const rest = newest.filter((item) => !urgent.includes(item));
  return [...urgent, ...rest];
}

/**
 * Groups photos (newest first) under their month, e.g. "October 2026",
 * keeping the order they came in.
 * @template {{ createdAt: string }} T
 * @param {T[]} photos
 * @param {string} [locale]
 * @returns {Array<{ key: string, label: string, items: T[] }>}
 */
export function groupByMonth(photos, locale) {
  const groups = [];
  const index = new Map();
  for (const photo of photos) {
    const date = new Date(photo.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!index.has(key)) {
      const group = {
        key,
        label: date.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
        items: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).items.push(photo);
  }
  return groups;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
