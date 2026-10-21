import { useRef } from 'react';

import { applyHandle } from '../../utils/scan/imageOps.js';
import styles from './ScanDialog.module.css';

const CORNERS = [
  { id: 'nw', label: 'top left' },
  { id: 'ne', label: 'top right' },
  { id: 'sw', label: 'bottom left' },
  { id: 'se', label: 'bottom right' },
];
const STEP = 0.01;
const BIG_STEP = 0.05;

function CropOverlay({ crop, onChange }) {
  const area = useRef(null);
  const drag = useRef(null);

  const begin = (handle) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, crop };
  };
  const move = (event) => {
    const start = drag.current;
    if (!start || !area.current) return;
    const box = area.current.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    onChange(applyHandle(start.crop, start.handle, (event.clientX - start.x) / box.width, (event.clientY - start.y) / box.height));
  };
  const end = () => {
    drag.current = null;
  };
  const key = (handle) => (event) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(applyHandle(crop, handle, delta[0], delta[1]));
  };
  const pointer = (handle) => ({ onPointerDown: begin(handle), onPointerMove: move, onPointerUp: end, onPointerCancel: end });

  return (
    <div ref={area} className={styles.cropArea}>
      <div
        className={styles.cropBox}
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
        role="group"
        tabIndex={0}
        aria-label="Crop area. Use the arrow keys to move it."
        onKeyDown={key('move')}
        {...pointer('move')}
      >
        {CORNERS.map((corner) => (
          <button
            key={corner.id}
            type="button"
            className={`${styles.cropHandle} ${styles[`handle_${corner.id}`]}`}
            aria-label={`Crop corner, ${corner.label}. Use the arrow keys to move it.`}
            onKeyDown={key(corner.id)}
            {...pointer(corner.id)}
          />
        ))}
      </div>
    </div>
  );
}

export default CropOverlay;
