import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './DropdownMenu.module.css';

const ITEMS = '[role="menuitem"]:not([disabled])';

function MenuPanel({ placement, onClose, returnFocus, label, align, children }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.maxHeight = '';
    const rect = node.getBoundingClientRect();
    setBox(placement({ width: rect.width, height: node.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [placement]);

  useEffect(() => {
    if (!box) return;
    ref.current?.querySelector(ITEMS)?.focus();
  }, [box === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const onViewportChange = (event) => {
      if (event?.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const close = (restore) => {
    onClose();
    if (restore) requestAnimationFrame(() => returnFocus?.focus?.());
  };

  const onKeyDown = (event) => {
    const items = [...ref.current.querySelectorAll(ITEMS)];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={styles.panel}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      data-align={align}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={
        box
          ? { left: box.left, top: box.top, maxHeight: box.maxHeight, visibility: 'visible' }
          : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      {typeof children === 'function' ? children({ close: () => close(true) }) : children}
    </div>,
    document.body
  );
}

export default MenuPanel;
