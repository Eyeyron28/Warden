/**
 * The Files page shows folders and files as two separate blocks: "Folders" (a grid of tiles) above "Files" (the list or grid).
 * Folders never appear among the file rows. The Folders block exists only when the open folder has subfolders.
 *
 * @param {Array<{ kind: string, key: string }>} items every item of the open folder, folders and files mixed
 */
export function splitIntoBlocks(items) {
  const folders = items.filter((item) => item.kind === 'folder');
  const files = items.filter((item) => item.kind === 'file');
  return {
    folders,
    files,
    showFolders: folders.length > 0,
    // The keys "select all" covers: the files only, so selecting every file never selects a folder.
    selectAllKeys: files.map((item) => item.key),
  };
}
