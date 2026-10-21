export const FOLDER_ROOT = 'root';

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

export function relativeDirFromPath(relativePath) {
  const lastSlash = relativePath.lastIndexOf('/');
  return lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
}

export function combineFolderPath(currentPath, relativeFolder) {
  const segments = [...splitPath(currentPath), ...splitPath(relativeFolder)];
  return segments.length > 0 ? joinPath(segments) : undefined;
}

export function pathStillExists(currentPath, documentFolders, folderNames) {
  if (!currentPath) return true;
  const prefix = `${currentPath}/`;
  const matches = (path) => path === currentPath || path.startsWith(prefix);
  return documentFolders.some(matches) || folderNames.some(matches);
}
