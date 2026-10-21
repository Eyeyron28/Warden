export const PHOTOS_VIEW_KEY = 'warden.photosView';

const browserStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function readPhotosView(storage = browserStorage()) {
  try {
    return storage?.getItem(PHOTOS_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function writePhotosView(view, storage = browserStorage()) {
  try {
    storage?.setItem(PHOTOS_VIEW_KEY, view === 'grid' ? 'grid' : 'list');
  } catch {
  }
}
