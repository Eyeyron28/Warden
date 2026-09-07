// 560px matches the breakpoint the rest of the app's responsive CSS
// already uses (VaultShell, UploadForm, DocumentRow, etc. - see their
// .module.css files), so "narrow viewport" here means the same thing it
// means everywhere else in the UI.
const MOBILE_BREAKPOINT_PX = 560;

/**
 * True only when BOTH a narrow viewport AND a coarse (touch) pointer are
 * present. Either signal alone is a false-positive magnet: a desktop
 * window resized narrow has no touch pointer, and a touch laptop can be
 * wide. Requiring both is what lets this distinguish "an actual phone"
 * from "a desktop browser someone made narrow."
 */
export function isPhoneDevice() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;

  const narrowViewport = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  const coarsePointer =
    window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  return narrowViewport && coarsePointer;
}
