import { useId } from 'react';

import styles from './Watermark.module.css';

/**
 * A tiled, diagonal, semi-transparent text watermark laid over its (position: relative) parent. SVG only:
 * drawn text, pointer-events none, hidden from screen readers (the purpose is also printed in the page header).
 * It discourages reuse; it cannot stop a screenshot.
 */
function Watermark({ text }) {
  const patternId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!text) return null;
  const fontSize = 16;
  const tileWidth = Math.max(260, Math.round([...text].length * fontSize * 0.7) + 80);
  const tileHeight = 120;
  return (
    <svg className={styles.overlay} aria-hidden="true" focusable="false" data-testid="watermark">
      <defs>
        <pattern id={patternId} width={tileWidth} height={tileHeight} patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <text x="0" y={tileHeight / 2} className={styles.text} fontSize={fontSize}>
            {text}
          </text>
          <text x={tileWidth / 2} y={tileHeight} className={styles.text} fontSize={fontSize}>
            {text}
          </text>
          <text x={-tileWidth / 2} y={tileHeight} className={styles.text} fontSize={fontSize}>
            {text}
          </text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

export default Watermark;
