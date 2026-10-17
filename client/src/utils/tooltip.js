import './tooltip.css';
import { CONTROL_SELECTOR, createEngine, placeTip, resolveTip, suppressTitle } from './tooltipCore.js';

/**
 * The DOM side of the shared tooltips: ONE floating element on the page, and ONE set of delegated listeners. Loaded lazily by the
 * small bootstrap in the main bundle (utils/tooltipBootstrap.js) the first time a mouse hovers or a keyboard focuses a control.
 */
const ID = 'warden-tooltip';
let box = null;
let described = null; // the control whose aria-describedby this tooltip added
let sticky = null; // the control a tapped (touch) popover belongs to
let started = false;
let mutedAt = null; // where the pointer was when a click hid the tooltip: no new tooltip until it has really moved on

function ensure() {
  if (box && box.isConnected) return box;
  box = document.createElement('div');
  box.id = ID;
  box.setAttribute('role', 'tooltip');
  box.setAttribute('data-testid', 'tooltip');
  box.hidden = true;
  document.body.appendChild(box);
  return box;
}

function describe(el, text) {
  // Only when the tooltip adds something: the same words as the name would be read twice.
  const name = (el.getAttribute('aria-label') || '').trim();
  if (name !== text) {
    el.setAttribute('aria-describedby', ID);
    described = el;
  }
}

function draw(el, text) {
  const tip = ensure();
  tip.textContent = text;
  tip.hidden = false;
  // measured from the corner, so the old position does not squeeze the new text into the room that was left there
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.style.visibility = 'hidden';
  const anchor = el.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  const place = placeTip(anchor, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
  tip.style.left = `${place.left}px`;
  tip.style.top = `${place.top}px`;
  tip.style.visibility = 'visible';
  describe(el, text);
}

function erase() {
  if (box) box.hidden = true;
  if (described) described.removeAttribute('aria-describedby');
  described = null;
}

const engine = createEngine({
  resolve: (el) => resolveTip(el),
  show: (el, text) => draw(el, text),
  hide: () => erase(),
});

const controlOf = (target) => (target instanceof Element ? target.closest(CONTROL_SELECTOR) : null);

/** A disabled control gets no pointer events in some browsers, so its reason is found by where the pointer is. */
let overDisabled = null;
function disabledUnder(x, y) {
  for (const el of document.querySelectorAll('[data-tip]:disabled')) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

/** Hides a tapped (touch) popover. */
export function hideSticky() {
  if (sticky) {
    sticky = null;
    erase();
  }
}

/** Touch: a tap on a status icon shows its words beside it and a second tap hides them. The same floating element as the hover one. */
export function toggleSticky(el, text) {
  start(); // a touch-only visitor never woke the bootstrap, so listen now: a tap elsewhere must close it
  ensure();
  if (sticky === el) {
    hideSticky();
    return;
  }
  engine.escape();
  sticky = el;
  draw(el, text);
}

const stillThere = (event) => mutedAt && Math.hypot(event.clientX - mutedAt.x, event.clientY - mutedAt.y) < 4;

/** Handles one event (also used to replay the event that woke the bootstrap). */
export function handle(event) {
  const type = event.type;
  const el = controlOf(event.target);
  if (type === 'pointerover') {
    if (event.pointerType === 'touch') return;
    if (!el) return;
    suppressTitle(el);
    // a click that re-draws the control under the pointer must not bring the tooltip straight back
    if (stillThere(event)) return;
    mutedAt = null;
    engine.enter(el, event.pointerType || 'mouse');
  } else if (type === 'pointerout') {
    if (event.pointerType === 'touch') return;
    if (el && !el.contains(event.relatedTarget)) engine.leave(el);
  } else if (type === 'focusin') {
    if (!el) return;
    suppressTitle(el);
    engine.focus(el, el.matches(':focus-visible'));
  } else if (type === 'focusout') {
    if (el) engine.blur(el);
  } else if (type === 'pointerdown') {
    engine.press();
    mutedAt = { x: event.clientX, y: event.clientY };
    if (sticky && !(sticky.contains(event.target) || (box && box.contains(event.target)))) hideSticky();
  } else if (type === 'click') {
    engine.press();
    if (event.detail > 0) mutedAt = { x: event.clientX, y: event.clientY };
  } else if (type === 'keydown') {
    if (event.key === 'Escape') {
      // Escape first puts the tooltip away; only the next Escape reaches the dialog or tray behind it.
      const wasShowing = engine.escape() || Boolean(sticky);
      hideSticky();
      if (wasShowing) event.stopPropagation();
    } else if (event.key === 'Enter' || event.key === ' ') engine.press();
  } else if (type === 'pointermove') {
    if (event.pointerType === 'touch') return;
    if (el) return;
    const hit = disabledUnder(event.clientX, event.clientY);
    if (hit && hit !== overDisabled) {
      overDisabled = hit;
      engine.enter(hit, event.pointerType || 'mouse');
    } else if (!hit && overDisabled) {
      engine.leave(overDisabled);
      overDisabled = null;
    }
  } else if (type === 'scroll' || type === 'resize') {
    engine.scroll();
    hideSticky();
  }
}

/** Starts listening, once. */
export function start() {
  if (started) return;
  started = true;
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'pointerdown', 'click', 'keydown', 'pointermove']) document.addEventListener(type, handle, { capture: true, passive: true });
  document.addEventListener('scroll', handle, { capture: true, passive: true });
  window.addEventListener('resize', handle, { passive: true });
}

export { engine };
