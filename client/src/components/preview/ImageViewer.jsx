import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowsIn, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';

import styles from './Preview.module.css';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * An image with zoom and pan: wheel, +/- buttons, + - 0 keys, double-click,
 * pinch, and drag to pan once zoomed. The picture is shown from an object URL
 * over a Blob whose type came from the byte sniffing (an allowlisted image
 * type), revoked when this goes away.
 */
function ImageViewer({ bytes, mime, name, onFail }) {
  const [url, setUrl] = useState(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const stageRef = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(objectUrl);
    setView({ scale: 1, x: 0, y: 0 });
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, mime]);

  // Zoom keeping the point under (cx, cy) - measured from the stage centre - still.
  const zoomAt = useCallback((factor, cx = 0, cy = 0) => {
    setView((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      if (scale === MIN_SCALE) return { scale, x: 0, y: 0 };
      const ratio = scale / current.scale;
      const stage = stageRef.current?.getBoundingClientRect();
      const limitX = ((stage?.width ?? 800) * scale) / 2;
      const limitY = ((stage?.height ?? 600) * scale) / 2;
      return {
        scale,
        x: clamp(cx - (cx - current.x) * ratio, -limitX, limitX),
        y: clamp(cy - (cy - current.y) * ratio, -limitY, limitY),
      };
    });
  }, []);

  const centreOf = (event) => {
    const rect = stageRef.current.getBoundingClientRect();
    return { cx: event.clientX - rect.left - rect.width / 2, cy: event.clientY - rect.top - rect.height / 2 };
  };

  // Wheel needs a non-passive listener to stop the page scrolling behind it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const { cx, cy } = centreOf(event);
      zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      if (event.key === '+' || event.key === '=') zoomAt(1.25);
      else if (event.key === '-' || event.key === '_') zoomAt(1 / 1.25);
      else if (event.key === '0') setView({ scale: 1, x: 0, y: 0 });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomAt]);

  const onPointerDown = (event) => {
    stageRef.current.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { startView: view, startPoint: { x: event.clientX, y: event.clientY }, startDistance: null };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.startDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (event) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    if (!start) return;
    if (pointers.current.size === 2 && start.startDistance) {
      const [a, b] = [...pointers.current.values()];
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / start.startDistance;
      const scale = clamp(start.startView.scale * factor, MIN_SCALE, MAX_SCALE);
      setView((current) => (scale === MIN_SCALE ? { scale, x: 0, y: 0 } : { ...current, scale }));
    } else if (pointers.current.size === 1 && start.startView.scale > 1) {
      const rect = stageRef.current.getBoundingClientRect();
      const limitX = (rect.width * start.startView.scale) / 2;
      const limitY = (rect.height * start.startView.scale) / 2;
      setView({
        scale: start.startView.scale,
        x: clamp(start.startView.x + event.clientX - start.startPoint.x, -limitX, limitX),
        y: clamp(start.startView.y + event.clientY - start.startPoint.y, -limitY, limitY),
      });
    }
  };

  const onPointerUp = (event) => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  };

  const zoomed = view.scale > 1;
  return (
    <div className={styles.imageWrap}>
      <div
        ref={stageRef}
        className={`${styles.imageStage} ${zoomed ? styles.grab : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const { cx, cy } = centreOf(event);
          if (zoomed) setView({ scale: 1, x: 0, y: 0 });
          else zoomAt(2.5, cx, cy);
        }}
      >
        {url && (
          <img
            src={url}
            alt={name}
            className={styles.image}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onError={onFail}
          />
        )}
      </div>
      <div className={styles.zoomBar} role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomAt(1 / 1.25)} disabled={view.scale <= MIN_SCALE} aria-label="Zoom out">
          <MagnifyingGlassMinus size={18} />
        </button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoomAt(1.25)} disabled={view.scale >= MAX_SCALE} aria-label="Zoom in">
          <MagnifyingGlassPlus size={18} />
        </button>
        <button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })} disabled={!zoomed} aria-label="Fit to screen">
          <ArrowsIn size={18} />
        </button>
      </div>
    </div>
  );
}

export default ImageViewer;
