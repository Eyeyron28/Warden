import styles from './FileTypeIcon.module.css';

const KINDS = {
  pdf: { label: 'PDF', exts: ['pdf'] },
  doc: { label: 'DOC', exts: ['doc', 'docx', 'odt', 'rtf', 'pages'] },
  xls: { label: 'XLS', exts: ['xls', 'xlsx', 'ods', 'csv', 'numbers'] },
  img: { label: 'IMG', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'svg', 'tif', 'tiff'] },
  zip: { label: 'ZIP', exts: ['zip', 'rar', '7z', 'tar', 'gz'] },
  txt: { label: 'TXT', exts: ['txt', 'md', 'log', 'json', 'xml'] },
};

/** Picks the icon kind from the filename's extension; 'file' when unknown. */
export function fileKindOf(filename = '') {
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
  const found = Object.entries(KINDS).find(([, kind]) => kind.exts.includes(ext));
  return found ? found[0] : 'file';
}

/**
 * A sheet of paper with a folded corner and the extension printed on it,
 * drawn inline (1.5px stroke, currentColor) so it follows the theme.
 * Decorative: the filename is always shown next to it, so it is hidden from
 * assistive tech.
 */
function FileTypeIcon({ filename, size = 32 }) {
  const kind = fileKindOf(filename);
  const dot = (filename || '').lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toUpperCase();
  const label = (KINDS[kind]?.label ?? ext.slice(0, 4)) || 'FILE';

  return (
    <svg
      className={styles.icon}
      width={size}
      height={(size * 40) / 32}
      viewBox="0 0 32 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      <path d="M6 2.75h13l8.25 8.25v24.25a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z" />
      <path d="M19 2.75V9a2 2 0 0 0 2 2h6.25" />
      <text
        x="16"
        y="29"
        textAnchor="middle"
        className={styles.label}
        stroke="none"
        fill="currentColor"
      >
        {label}
      </text>
    </svg>
  );
}

export default FileTypeIcon;
