/**
 * The look of a folder: one colour and one icon, each chosen from a fixed list the SERVER owns. The client draws them
 * (colours are theme tokens, `--folder-<id>` in client/src/styles/tokens.css, with a value for dark and one for light;
 * icons are drawn from the client's own icon set). Anything outside these lists is refused, so a folder can never carry
 * markup, a script, a URL or a colour string of someone's choosing.
 *
 * A folder with no colour and no icon (null) keeps the default look, which is every folder made before this existed.
 */

const FOLDER_COLORS = Object.freeze(['rose', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'gray']);
const FOLDER_ICONS = Object.freeze(['folder', 'id-card', 'heart', 'home', 'graduation-cap', 'receipt', 'briefcase', 'plane', 'car', 'shield', 'camera', 'book']);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validates the optional `color` and `icon` of a request body. Each is absent (left as it was), null or '' (back to the
 * default look) or one of the allowed ids.
 * @returns {{ set: object, unset: object }} fields to $set and to $unset on the Folder record
 */
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
