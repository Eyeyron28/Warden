/**
 * The logic of the shared tooltips, as plain functions so every rule can be tested without a browser. The DOM side
 * (utils/tooltip.js) only wires events to this; both load lazily, the first time a mouse hovers or a keyboard focuses a control.
 *
 * What gets a tooltip: buttons, links, role="button" and menu items, and anything that opts in with data-tip.
 *   - The words: data-tip, else aria-label, else the title attribute.
 *   - A control with visible text of its own (a "Cancel" button) shows nothing unless it has a data-tip. Decided at hover time.
 *   - The browser's own title tooltip is moved out of the way (title -> data-tip) so only one ever shows.
 *   - Mouse and pen only; touch is ignored here (the visible label, or the tap popover of the tray's status icons, is used).
 */
export const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], summary, [data-tip]';
export const OPEN_MS = 400;
export const SWITCH_MS = 300;
export const MAX_WIDTH = 240;

/** True when the element shows text of its own: a text node whose box is on screen (the screen-reader-only trick is not "visible"). */
export function hasVisibleText(el, doc = el.ownerDocument) {
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
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

/** The tooltip words for a control, or '' when it should show none. */
export function resolveTip(el, { visibleText = hasVisibleText } = {}) {
  const data = (el.getAttribute('data-tip') || '').trim();
  const aria = (el.getAttribute('aria-label') || '').trim();
  const title = (el.getAttribute('title') || '').trim();
  const text = data || aria || title;
  if (!text) return '';
  if (!data && visibleText(el)) return ''; // it already says what it is
  return text;
}

/**
 * Moves a control's title into data-tip so the browser's own tooltip cannot also appear. A control with no aria-label and no text of
 * its own keeps its accessible name by getting the title as an aria-label.
 */
export function suppressTitle(el, { visibleText = hasVisibleText } = {}) {
  const title = el.getAttribute('title');
  if (title === null) return false;
  const text = title.trim();
  if (text && !el.getAttribute('data-tip')) el.setAttribute('data-tip', text);
  if (text && !el.getAttribute('aria-label') && !visibleText(el)) el.setAttribute('aria-label', text);
  el.removeAttribute('title');
  return true;
}

/**
 * Where to put a tooltip: below the control, flipped above when there is no room, shifted so it stays at least `margin` px inside
 * the viewport, never wider than MAX_WIDTH or the screen minus margins. All numbers are viewport pixels.
 * @returns {{ left: number, top: number, width: number, side: 'top' | 'bottom' }}
 */
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

/**
 * The timing rules, with the clock and the way of showing injected.
 *   enter(el, pointerType): after OPEN_MS of rest; at once when a tooltip is showing or one was hiding less than SWITCH_MS ago.
 *   leave(el), press(), escape(), scroll(), resize(): hide.   focus(el, visible): at once, only for keyboard focus.   blur(el): hide.
 * `resolve(el)` gives the words ('' = none); `show(el, text)` and `hide(el)` do the drawing.
 */
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
    /** Returns true when a tooltip was showing (and is now hidden). */
    escape: close,
    destroy: cancel,
  };
}
