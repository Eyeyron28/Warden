export const TYPE_WORDS = ['documents', 'Valid IDs', 'Photos', 'Contracts', 'Receipts', 'Transcripts', 'Passports', 'Diplomas', 'Certificates'];

const TYPE_MS = 90;
const DELETE_MS = 45;
const HOLD_MS = 1600;
const PAUSE_MS = 350;
const PASSES = 2;

export function startTypewriter(el, srClass) {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
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
