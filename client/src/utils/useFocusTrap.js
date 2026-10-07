import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (element) => element.getClientRects().length > 0;

/**
 * Keeps keyboard focus inside `ref` while `active`: focus moves in when it
 * turns on, Tab / Shift+Tab wrap at the ends, and when it turns off (or the
 * component unmounts) focus goes back to whatever had it before - the card
 * or button that opened the dialog.
 */
export function useFocusTrap(ref, active = true, { initialFocus, opener = 'mount' } = {}) {
  // Whatever had focus when this first rendered: the card or button that opened it.
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = typeof document === 'undefined' ? null : document.activeElement;

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (!container) return undefined;

    // 'mount': what had focus when the component first rendered (dialogs that mount
    // when opened). 'activation': what has focus right now (a drawer that is always mounted).
    const previous = opener === 'activation' ? document.activeElement : openerRef.current;
    const focusables = () => [...container.querySelectorAll(FOCUSABLE)].filter(visible);

    const first = initialFocus?.() ?? focusables()[0];
    // Something inside (an autoFocus field) already has focus: leave it there.
    if (container.contains(document.activeElement) && document.activeElement !== container) {
      // keep
    } else if (first) first.focus();
    else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      // A dialog opened on top of this one (Rename, Share...) owns the keyboard.
      const owner = document.activeElement?.closest?.('[aria-modal="true"]');
      if (owner && owner !== container) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === head || !container.contains(document.activeElement))) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (document.activeElement === tail || !container.contains(document.activeElement))) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** True when `element` is the front-most open dialog (so Esc and arrows belong to it). */
export function isTopDialog(element) {
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  return dialogs.length > 0 && dialogs[dialogs.length - 1] === element;
}
