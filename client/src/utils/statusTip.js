/**
 * The behaviour of a status tooltip as plain code, so every way of opening it can be tested without a browser:
 *   - mouse: opens after `delay` ms over the icon, closes when the mouse leaves;
 *   - keyboard: opens on focus, closes on blur; Escape closes it (and says it handled the key, so a tray's own Escape does not also run);
 *   - touch: a tap toggles it; a tap anywhere else closes it.
 * `onChange(open)` is called only when the state changes. Timers are injected.
 */
export const TIP_DELAY_MS = 200;

export function createTipController({ onChange, delay = TIP_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let open = false;
  let timer = null;
  const set = (next) => {
    if (next === open) return;
    open = next;
    onChange(open);
  };
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    isOpen: () => open,
    mouseEnter() {
      cancel();
      timer = setTimer(() => {
        timer = null;
        set(true);
      }, delay);
    },
    mouseLeave() {
      cancel();
      set(false);
    },
    focus() {
      cancel();
      set(true);
    },
    blur() {
      cancel();
      set(false);
    },
    /** Returns true when the key was used (the tooltip was open and is now closed). */
    keyDown(key) {
      if (key !== 'Escape') return false;
      cancel(); // a hover that has not shown yet does not show after Escape
      if (!open) return false;
      set(false);
      return true;
    },
    /** A tap on the icon (pointerType 'touch'): toggles. */
    tap() {
      cancel();
      set(!open);
    },
    /** A tap or click somewhere that is not the icon or the tooltip. */
    outside() {
      cancel();
      set(false);
    },
    destroy: cancel,
  };
}

/**
 * Where to put a tooltip: beside the icon, flipped to the other side when it does not fit, then shifted so it stays inside the
 * viewport with `margin` to spare. All numbers are pixels in the viewport. The width never passes the viewport minus margins.
 * @returns {{ left: number, top: number, width: number, side: 'top' | 'bottom' }}
 */
export function placeTip(anchor, tip, viewport, { margin = 8, gap = 8 } = {}) {
  const width = Math.min(tip.width, viewport.width - 2 * margin);
  const height = tip.height;
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const side = roomBelow >= height || roomBelow >= roomAbove ? 'bottom' : 'top';
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  const centered = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.max(margin, Math.min(centered, viewport.width - margin - width));
  return { left, top: Math.max(margin, Math.min(top, viewport.height - margin - height)), width, side };
}
