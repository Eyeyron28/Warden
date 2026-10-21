import './tooltip.css';
import { CONTROL_SELECTOR, createEngine, placeTip, resolveTip, suppressTitle } from './tooltipCore.js';

const ID = 'warden-tooltip';
let box = null;
let described = null;
let sticky = null;
let started = false;
let mutedAt = null;

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

let overDisabled = null;
function disabledUnder(x, y) {
  for (const el of document.querySelectorAll('[data-tip]:disabled')) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

export function hideSticky() {
  if (sticky) {
    sticky = null;
    erase();
  }
}

export function toggleSticky(el, text) {
  start();
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

export function handle(event) {
  const type = event.type;
  const el = controlOf(event.target);
  if (type === 'pointerover') {
    if (event.pointerType === 'touch') return;
    if (!el) return;
    suppressTitle(el);
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

export function start() {
  if (started) return;
  started = true;
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'pointerdown', 'click', 'keydown', 'pointermove']) document.addEventListener(type, handle, { capture: true, passive: true });
  document.addEventListener('scroll', handle, { capture: true, passive: true });
  window.addEventListener('resize', handle, { passive: true });
}

export { engine };
