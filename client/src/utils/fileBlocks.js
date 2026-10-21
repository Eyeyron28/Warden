export function splitIntoBlocks(items) {
  const folders = items.filter((item) => item.kind === 'folder');
  const files = items.filter((item) => item.kind === 'file');
  return {
    folders,
    files,
    showFolders: folders.length > 0,
    selectAllKeys: files.map((item) => item.key),
  };
}
