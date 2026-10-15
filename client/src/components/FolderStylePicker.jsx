import { useId } from 'react';

import FolderGlyph from './FolderGlyph.jsx';
import { COLOR_LABELS, FOLDER_COLORS, FOLDER_ICONS, ICON_LABELS, folderColorVar } from '../utils/folderStyle.js';
import styles from './FolderStylePicker.module.css';

/**
 * Colour and icon for a folder: two groups of real radio buttons (arrow keys and touch work as for any radio group). The first
 * choice in each group is "none", which keeps the default look. `value` is { color, icon } with null for none.
 */
function FolderStylePicker({ value, onChange, disabled = false }) {
  const name = useId();
  const color = value?.color ?? null;
  const icon = value?.icon ?? null;
  const set = (next) => onChange({ color, icon, ...next });

  return (
    <div className={styles.picker}>
      <fieldset className={styles.group} disabled={disabled}>
        <legend className={styles.legend}>Colour</legend>
        <div className={styles.options}>
          <label className={styles.swatch} title="Default">
            <input type="radio" name={`${name}-color`} checked={color === null} onChange={() => set({ color: null })} aria-label="Default colour" />
            <span className={`${styles.dot} ${styles.dotNone}`} aria-hidden="true" />
          </label>
          {FOLDER_COLORS.map((id) => (
            <label key={id} className={styles.swatch} title={COLOR_LABELS[id]}>
              <input type="radio" name={`${name}-color`} checked={color === id} onChange={() => set({ color: id })} aria-label={COLOR_LABELS[id]} />
              <span className={styles.dot} style={{ background: folderColorVar(id) }} aria-hidden="true" />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group} disabled={disabled}>
        <legend className={styles.legend}>Icon</legend>
        <div className={styles.options}>
          <label className={styles.glyph} title="Default">
            <input type="radio" name={`${name}-icon`} checked={icon === null} onChange={() => set({ icon: null })} aria-label="Default icon" />
            <span className={styles.glyphBox}>
              <FolderGlyph icon="folder" color={color} size={20} weight="regular" />
            </span>
          </label>
          {FOLDER_ICONS.filter((id) => id !== 'folder').map((id) => (
            <label key={id} className={styles.glyph} title={ICON_LABELS[id]}>
              <input type="radio" name={`${name}-icon`} checked={icon === id} onChange={() => set({ icon: id })} aria-label={ICON_LABELS[id]} />
              <span className={styles.glyphBox}>
                <FolderGlyph icon={id} color={color} size={20} weight="regular" />
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export default FolderStylePicker;
