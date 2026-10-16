import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SealRing } from './TransferTrayView.jsx';
import { createTipController, placeTip } from '../utils/statusTip.js';
import styles from './TransferTray.module.css';

/**
 * A tray row's status icon that explains itself. It is a button (so the keyboard reaches it) whose accessible name is the
 * explanation; the same words show as a tooltip:
 *   - hover: after about 200 ms, hidden when the mouse leaves;
 *   - keyboard focus: at once; Escape hides it (and the tray's own Escape does not also run);
 *   - touch: a tap toggles a popover beside the icon, a tap anywhere else closes it.
 * role="tooltip" with aria-describedby; focus is never moved; the box stays inside the viewport (flipped or shifted) and at most as wide
 * as the screen minus margins, so it fits at 360 px. `forceOpen` draws it open and inline, for rendering one state on its own.
 */
function StatusRing({ ring, percent, tip, forceOpen = false }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const button = useRef(null);
  const box = useRef(null);
  const control = useRef(null);
  const pointer = useRef('mouse');
  if (control.current === null) control.current = createTipController({ onChange: setOpen });

  useEffect(() => () => control.current.destroy(), []);

  const shown = open || forceOpen;

  // Measure the box once it exists, then put it beside the icon inside the viewport.
  useLayoutEffect(() => {
    if (!open || !button.current || !box.current) {
      setPlace(null);
      return;
    }
    const anchor = button.current.getBoundingClientRect();
    const size = box.current.getBoundingClientRect();
    setPlace(placeTip(anchor, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, tip]);

  // A tap (or click) anywhere else closes the popover; so does a resize.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (button.current?.contains(event.target) || box.current?.contains(event.target)) return;
      control.current.outside();
    };
    const close = () => control.current.outside();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const tooltip = shown && (
    <span
      id={id}
      ref={box}
      role="tooltip"
      className={styles.statusTip}
      data-testid="status-tip"
      style={forceOpen || typeof document === 'undefined' ? { position: 'static' } : place ? { left: place.left, top: place.top, width: place.width } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      {tip}
    </span>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.statusButton}
        aria-label={tip}
        aria-describedby={shown ? id : undefined}
        data-testid="status-icon"
        onPointerDown={(event) => {
          pointer.current = event.pointerType || 'mouse';
        }}
        onPointerEnter={(event) => {
          pointer.current = event.pointerType || 'mouse';
        }}
        onMouseEnter={() => {
          if (pointer.current !== 'touch') control.current.mouseEnter();
        }}
        onMouseLeave={() => {
          if (pointer.current !== 'touch') control.current.mouseLeave();
        }}
        onFocus={() => {
          // (a tap focuses the button too: for touch the tap itself toggles, so focus must not open it first)
          if (pointer.current !== 'touch') control.current.focus();
        }}
        onBlur={() => control.current.blur()}
        onClick={() => {
          if (pointer.current === 'touch') control.current.tap();
        }}
        onKeyDown={(event) => {
          pointer.current = 'key';
          if (control.current.keyDown(event.key)) {
            event.preventDefault();
            event.stopPropagation(); // the tray's own Escape (minimize) is for when no tooltip is open
          }
        }}
      >
        <SealRing ring={ring} percent={percent} />
      </button>
      {tooltip && (forceOpen || typeof document === 'undefined' ? tooltip : createPortal(tooltip, document.body))}
    </>
  );
}

export default StatusRing;
