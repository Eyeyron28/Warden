import { getToken } from './session.js';
import { getMe } from './authService.js';
import { wasEmergencyTab } from './emergencyMode.js';
import { listDocuments, listExpiringDocuments, listFolderChildren, listFolders, listRecent } from './documentsService.js';
import { getFrequentFiles, getOverview } from './insightsService.js';
import { getEmergencyStatus } from './emergencyService.js';
import { listAllShares } from './sharesService.js';
import { listTrash } from './trashService.js';

const STATUS = () => getEmergencyStatus({ maxAgeMs: 30000 });
const FIRST_SCREEN = {
  '/files': () => [listDocuments(), listFolders(), listFolderChildren(''), listExpiringDocuments(), getFrequentFiles(), STATUS()],
  '/overview': () => [getOverview(), listExpiringDocuments(), STATUS()],
  '/shared': () => [listAllShares(), STATUS()],
  '/trash': () => [listTrash(), STATUS()],
  '/starred': () => [listDocuments(), STATUS()],
  '/recent': () => [listRecent(), STATUS()],
};

const APP_PATHS = new Set(['/files', '/photos', '/starred', '/recent', '/shared', '/trash', '/export', '/overview', '/devices', '/account', '/emergency-access', '/quarantine']);

export function prefetchFirstScreen(pathname) {
  if (!getToken() || wasEmergencyTab()) return;
  if (APP_PATHS.has(pathname)) getMe().catch(() => {});
  const start = FIRST_SCREEN[pathname];
  if (!start) return;
  for (const request of start()) request.catch(() => {});
}
