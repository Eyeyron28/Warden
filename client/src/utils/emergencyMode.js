/**
 * Emergency mode: what the contact's read-only vault shows, as data, so one place decides it and a test can read it.
 *
 * An emergency session may ask the server for very little (the server refuses everything else with 403), and the
 * screen hides the controls that would only produce errors. Hiding is a courtesy: the server is the boundary.
 */

/** The only signed-in route in emergency mode. */
export const EMERGENCY_ROUTES = Object.freeze(['/files']);

/** '/trash' -> '/files' (any other client route goes to Files); null when the path is allowed as it is. */
export function emergencyRedirect(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  return EMERGENCY_ROUTES.includes(path) ? null : '/files';
}

/** Every write or account control, and whether emergency mode shows it. All false: that is the point. */
export const EMERGENCY_CONTROLS = Object.freeze({
  upload: false,
  newFolder: false,
  rename: false,
  move: false,
  delete: false,
  restore: false,
  share: false,
  bulkSelect: false,
  dragAndDrop: false,
  frequentlyUsed: false,
  expiryBanner: false,
  expiryEdit: false,
  overview: false,
  trash: false,
  photos: false,
  export: false,
  devices: false,
  account: false,
  emergencySetup: false,
  searchOutsideScope: false,
  lockVault: false,
  storageMeter: false,
});

/** The sidebar in emergency mode. */
export const EMERGENCY_NAV = Object.freeze([{ to: '/files', label: 'Files' }]);

/** Row and context menus keep only these. */
export const EMERGENCY_MENU = Object.freeze(['Open / Preview', 'Download']);

export const UNAVAILABLE_MESSAGE = 'This item isn’t available.';

/** A 403 or 404 from the server is an ordinary "not available" state, never a broken page. */
export function isUnavailable(error) {
  const status = error?.response?.status ?? error?.status;
  return status === 403 || status === 404;
}

export const ENDED_MESSAGE = 'Emergency access ended';

/** "Emergency access: read-only. This session ends at 3:45 PM." (in the visitor's own clock; the page says so) */
export function sessionBannerText(endsAt, formatTime) {
  const when = endsAt ? formatTime(endsAt) : '';
  return when ? `Emergency access: read-only. This session ends at ${when}.` : 'Emergency access: read-only.';
}
