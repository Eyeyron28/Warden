const FOLDER_COLORS = Object.freeze(['rose', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'gray']);
const FOLDER_ICONS = Object.freeze(['folder', 'id-card', 'heart', 'home', 'graduation-cap', 'receipt', 'briefcase', 'plane', 'car', 'shield', 'camera', 'book']);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function parseFolderStyle({ color, icon } = {}) {
  const set = {};
  const unset = {};
  const read = (name, value, allowed) => {
    if (value === undefined) return;
    if (value === null || value === '') {
      unset[name] = 1;
      return;
    }
    if (typeof value !== 'string' || value.length > 32 || !allowed.includes(value)) {
      throw invalid(`${name === 'color' ? 'Colour' : 'Icon'} must be one of: ${allowed.join(', ')}.`);
    }
    set[name] = value;
  };
  read('color', color, FOLDER_COLORS);
  read('icon', icon, FOLDER_ICONS);
  return { set, unset };
}

const hasStyleFields = (body) => body && (body.color !== undefined || body.icon !== undefined);

module.exports = { FOLDER_COLORS, FOLDER_ICONS, parseFolderStyle, hasStyleFields };
