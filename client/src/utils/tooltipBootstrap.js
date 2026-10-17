// The only part of the tooltips that is in the main bundle: it waits for the first mouse hover or keyboard focus on a control, then
// loads the real thing (utils/tooltip.js) and hands it that first event. Touch never loads it.
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
