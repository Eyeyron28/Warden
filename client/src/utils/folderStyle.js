export const FOLDER_COLORS = ['rose', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'gray'];
export const FOLDER_ICONS = ['folder', 'id-card', 'heart', 'home', 'graduation-cap', 'receipt', 'briefcase', 'plane', 'car', 'shield', 'camera', 'book'];

export const COLOR_LABELS = { rose: 'Rose', orange: 'Orange', amber: 'Amber', green: 'Green', teal: 'Teal', blue: 'Blue', violet: 'Violet', gray: 'Gray' };
export const ICON_LABELS = {
  folder: 'Folder', 'id-card': 'ID card', heart: 'Heart', home: 'Home', 'graduation-cap': 'School', receipt: 'Receipt',
  briefcase: 'Work', plane: 'Travel', car: 'Car', shield: 'Shield', camera: 'Camera', book: 'Book',
};

export const folderColorVar = (id) => (FOLDER_COLORS.includes(id) ? `var(--folder-${id})` : undefined);
