/**
 * Drive-style folder paths are just Document.folder strings with "/" as
 * the path separator (e.g. "Taxes/2024") - there's no separate nested
 * Folder collection tracking parent/child relationships server-side, only
 * the flat Folder model (see server/models/Folder.js) for folders with
 * zero documents in them yet. Every helper here works by splitting/
 * joining that same string client-side, matching how the backend already
 * stores it - no backend change was needed for nested folders at all.
 */

export const FOLDER_ROOT = 'root';

/** "root" (the schema default for uncategorized documents) and "" both
 *  mean "the top level" - normalize both to "" so the path math below
 *  never has to special-case the string "root". */
export function normalizeFolderPath(folder) {
  if (!folder || folder === FOLDER_ROOT) return '';
  return folder;
}

export function splitPath(path) {
  return path ? path.split('/').filter(Boolean) : [];
}

export function joinPath(segments) {
  return segments.filter(Boolean).join('/');
}

/**
 * Distinct immediate child segment names of `currentPath` among `paths`
 * (already-normalized folder path strings) - e.g. given
 * ["PC", "PC/Projects", "PC/Projects/2024", "Taxes"] at currentPath ""
 * this returns ["PC", "Taxes"]; at currentPath "PC" it returns
 * ["Projects"]. A deeper path like "PC/Projects/2024" implies its
 * ancestors "PC" and "PC/Projects" as tree nodes even if neither has its
 * own document or Folder record - the whole tree is derived from
 * splitting, never stored as its own structure.
 */
export function getImmediateChildren(paths, currentPath) {
  const prefix = currentPath ? `${currentPath}/` : '';
  const children = new Set();
  for (const path of paths) {
    if (!path || path === currentPath) continue;
    if (currentPath && !path.startsWith(prefix)) continue;
    const remainder = currentPath ? path.slice(prefix.length) : path;
    const [nextSegment] = remainder.split('/');
    if (nextSegment) children.add(nextSegment);
  }
  return [...children].sort((a, b) => a.localeCompare(b));
}

/**
 * Relative folder portion of a webkitdirectory file's relative path, e.g.
 * "Taxes/2024/receipt.pdf" -> "Taxes/2024". A file with no directory
 * component (shouldn't happen from a real folder picker) returns "" so
 * callers can combine it with wherever the upload was started from via
 * combineFolderPath, rather than hardcoding "root" here.
 */
export function relativeDirFromPath(relativePath) {
  const lastSlash = relativePath.lastIndexOf('/');
  return lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
}

/**
 * Prefixes a relative folder (e.g. from a folder upload) with wherever
 * the upload was started from, returning undefined for "the top level" so
 * callers can pass this straight to uploadDocument and let the schema's
 * "root" default apply, matching every other "no folder" case.
 */
export function combineFolderPath(currentPath, relativeFolder) {
  const segments = [...splitPath(currentPath), ...splitPath(relativeFolder)];
  return segments.length > 0 ? joinPath(segments) : undefined;
}

/**
 * Whether `currentPath` still resolves to something real - either a
 * document filed at or below it, or an explicit (possibly empty) Folder
 * record at or below it. Used to bounce back to the root view if the
 * folder someone is looking at was emptied out from under them (its last
 * document moved or deleted elsewhere), matching how the old flat folder
 * filter used to fall back to "All" in the same situation.
 */
export function pathStillExists(currentPath, documentFolders, folderNames) {
  if (!currentPath) return true;
  const prefix = `${currentPath}/`;
  const matches = (path) => path === currentPath || path.startsWith(prefix);
  return documentFolders.some(matches) || folderNames.some(matches);
}
