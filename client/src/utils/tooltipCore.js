export const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], summary, [data-tip]';
export const OPEN_MS = 400;
export const SWITCH_MS = 300;
export const MAX_WIDTH = 240;

export function hasVisibleText(el, doc = el.ownerDocument) {
  const walker = doc.createTreeWalker(el, 4 );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const box = parent.getBoundingClientRect();
    const style = doc.defaultView.getComputedStyle(parent);
    if (box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && style.display !== 'none') return true;
  }
  return false;
}

export function resolveTip(el, { visibleText = hasVisibleText } = {}) {
  const data = (el.getAttribute('data-tip') || '').trim();
  const aria = (el.getAttribute('aria-label') || '').trim();
  const title = (el.getAttribute('title') || '').trim();
  const text = data || aria || title;
  if (!text) return '';
  if (!data && visibleText(el)) return '';
  return text;
}

export function suppressTitle(el, { visibleText = hasVisibleText } = {}) {
  const title = el.getAttribute('title');
  if (title === null) return false;
  const text = title.trim();
  if (text && !el.getAttribute('data-tip')) el.setAttribute('data-tip', text);
  if (text && !el.getAttribute('aria-label') && !visibleText(el)) el.setAttribute('aria-label', text);
  el.removeAttribute('title');
  return true;
}

export function placeTip(anchor, tip, viewport, { margin = 8, gap = 8 } = {}) {
  const width = Math.min(tip.width, MAX_WIDTH, viewport.width - 2 * margin);
  const height = tip.height;
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const side = roomBelow >= height || roomBelow >= roomAbove ? 'bottom' : 'top';
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  const centered = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.max(margin, Math.min(centered, viewport.width - margin - width));
  return { left, top: Math.max(margin, Math.min(top, viewport.height - margin - height)), width, side };
}

export function createEngine({ resolve, show, hide, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, openMs = OPEN_MS, switchMs = SWITCH_MS }) {
  let current = null;
  let timer = null;
  let hiddenAt = -Infinity;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const close = () => {
    cancel();
    if (!current) return false;
    const was = current;
    current = null;
    hiddenAt = now();
    hide(was);
    return true;
  };
  const open = (el) => {
    const text = resolve(el);
    if (!text) {
      close();
      return false;
    }
    if (current !== el) {
      const previous = current;
      current = el;
      if (previous) hide(previous);
      show(el, text);
    }
    return true;
  };
  return {
    current: () => current,
    enter(el, pointerType = 'mouse') {
      if (pointerType === 'touch') return;
      cancel();
      if (current === el) return;
      if (current !== null || now() - hiddenAt <= switchMs) {
        open(el);
        return;
      }
      timer = setTimer(() => {
        timer = null;
        open(el);
      }, openMs);
    },
    leave(el) {
      cancel();
      if (current === el) close();
    },
    focus(el, visible) {
      if (!visible) return;
      cancel();
      open(el);
    },
    blur(el) {
      cancel();
      if (current === el) close();
    },
    press: close,
    scroll: close,
    resize: close,
    escape: close,
    destroy: cancel,
  };
}
