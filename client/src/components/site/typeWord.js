// Plain labels for the landing heading. The page starts on the first one.
export const TYPE_WORDS = ['documents', 'Valid IDs', 'Photos', 'Contracts', 'Receipts', 'Transcripts', 'Passports', 'Diplomas', 'Certificates'];

const TYPE_MS = 90;
const DELETE_MS = 45;
const HOLD_MS = 1600;
const PAUSE_MS = 350;
const PASSES = 2;

/**
 * Types a word into `el`, holds it, deletes it, types the next. Two full passes through the list, then it settles on the
 * first word and stops (the cursor goes with it). Reduced motion: nothing happens. Every timer is cleared by the returned
 * function and while the tab is hidden.
 */
export function startTypewriter(el, srClass) {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
  // The word stays in the heading as real text for screen readers; the typed copy is hidden from them.
  const real = el.cloneNode(true);
  real.className = srClass;
  el.before(real);
  el.setAttribute('aria-hidden', 'true');
  let word = 0;
  let length = TYPE_WORDS[0].length;
  let phase = 'hold';
  let passes = 0;
  let timer = 0;
  const later = (ms) => {
    timer = setTimeout(tick, ms);
  };
  const show = () => {
    el.textContent = TYPE_WORDS[word].slice(0, length);
  };
  function tick() {
    const current = TYPE_WORDS[word];
    if (phase === 'hold') {
      phase = 'delete';
      tick();
    } else if (phase === 'delete') {
      if (length > 0) {
        length -= 1;
        show();
        later(DELETE_MS);
      } else {
        word = (word + 1) % TYPE_WORDS.length;
        if (word === 0) passes += 1;
        phase = 'type';
        later(PAUSE_MS);
      }
    } else if (length < current.length) {
      length += 1;
      show();
      later(TYPE_MS);
    } else if (word === 0 && passes >= PASSES) {
      el.removeAttribute('data-typing');
    } else {
      phase = 'hold';
      later(HOLD_MS);
    }
  }
  const onVisibility = () => {
    clearTimeout(timer);
    if (!document.hidden) later(PAUSE_MS);
  };
  document.addEventListener('visibilitychange', onVisibility);
  el.setAttribute('data-typing', '');
  later(HOLD_MS);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
