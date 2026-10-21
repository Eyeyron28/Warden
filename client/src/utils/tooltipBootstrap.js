const CONTROL = 'button,a[href],[role=button],[role=menuitem],summary,[data-tip]';
const types = ['pointerover', 'focusin'];
function wake(event) {
  const el = event.target.closest?.(CONTROL);
  if (event.pointerType === 'touch' || !el || (event.type === 'focusin' && !el.matches(':focus-visible'))) return;
  types.forEach((type) => removeEventListener(type, wake, true));
  import('./tooltip.js').then((tip) => {
    tip.start();
    tip.handle(event);
  });
}
types.forEach((type) => addEventListener(type, wake, true));
