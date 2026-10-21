import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (element) => element.getClientRects().length > 0;

export function useFocusTrap(ref, active = true, { initialFocus, opener = 'mount' } = {}) {
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = typeof document === 'undefined' ? null : document.activeElement;

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (!container) return undefined;

    const previous = opener === 'activation' ? document.activeElement : openerRef.current;
    const focusables = () => [...container.querySelectorAll(FOCUSABLE)].filter(visible);

    const first = initialFocus?.() ?? focusables()[0];
    // eslint-disable-next-line no-empty
    if (container.contains(document.activeElement) && document.activeElement !== container) {
    } else if (first) first.focus();
    else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
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

export function isTopDialog(element) {
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  return dialogs.length > 0 && dialogs[dialogs.length - 1] === element;
}
