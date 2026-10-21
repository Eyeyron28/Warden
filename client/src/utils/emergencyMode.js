export const EMERGENCY_ROUTES = Object.freeze(['/files']);

export function emergencyRedirect(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  return EMERGENCY_ROUTES.includes(path) ? null : '/files';
}

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

export const EMERGENCY_NAV = Object.freeze([{ to: '/files', label: 'Files' }]);

export const EMERGENCY_MENU = Object.freeze(['Open / Preview', 'Download']);

export const UNAVAILABLE_MESSAGE = 'This item isn’t available.';

export function isUnavailable(error) {
  const status = error?.response?.status ?? error?.status;
  return status === 403 || status === 404;
}

export const ENDED_MESSAGE = 'Emergency access ended';

export function sessionBannerText(endsAt, formatTime) {
  const when = endsAt ? formatTime(endsAt) : '';
  return when ? `Emergency access: read-only. This session ends at ${when}.` : 'Emergency access: read-only.';
}
