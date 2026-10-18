/** Gives the control of every label marked data-required an aria-required, so the "*" is not the only signal. */
export function markRequiredControls(root = document) {
  for (const label of root.querySelectorAll('label[data-required]')) {
    const control = label.control;
    if (control && control.getAttribute('aria-required') !== 'true') control.setAttribute('aria-required', 'true');
  }
}

export function watchRequiredControls() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const run = () => {
    queued = false;
    markRequiredControls(document);
  };
  new MutationObserver(() => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(run);
    }
  }).observe(document.body, { childList: true, subtree: true });
  run();
}
