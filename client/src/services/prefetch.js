import { getToken } from './session.js';
import { getMe } from './authService.js';
import { wasEmergencyTab } from './emergencyMode.js';
import { listDocuments, listExpiringDocuments, listFolderChildren, listFolders, listRecent } from './documentsService.js';
import { getFrequentFiles, getOverview } from './insightsService.js';
import { getEmergencyStatus } from './emergencyService.js';
import { listAllShares } from './sharesService.js';
import { listTrash } from './trashService.js';

/**
 * Starts the requests the first screen needs the moment the app starts - in PARALLEL with the check of the stored session
 * (GET /auth/me) instead of after it. Before this, the page's own requests were only sent once that check had come back
 * and the page had rendered: one full round trip, and then all the rest.
 *
 * It asks for nothing the page would not ask for anyway, goes through the same cache (services/dataCache.js, so the page
 * shares these very requests), and never throws: a session the server refuses is dealt with by the usual 401 handling.
 * Not done in an Emergency Access tab (its session has its own, read-only screens).
 */
const STATUS = () => getEmergencyStatus({ maxAgeMs: 30000 });
const FIRST_SCREEN = {
  '/files': () => [listDocuments(), listFolders(), listFolderChildren(''), listExpiringDocuments(), getFrequentFiles(), STATUS()],
  '/overview': () => [getOverview(), listExpiringDocuments(), STATUS()],
  '/shared': () => [listAllShares(), STATUS()],
  '/trash': () => [listTrash(), STATUS()],
  // Starred is read from the same list My files loads (the stars ride along with it): nothing new is asked.
  '/starred': () => [listDocuments(), STATUS()],
  '/recent': () => [listRecent(), STATUS()],
};

// Every signed-in page: the session check itself (GET /auth/me) also starts now instead of after the page has rendered.
const APP_PATHS = new Set(['/files', '/photos', '/starred', '/recent', '/shared', '/trash', '/export', '/overview', '/devices', '/account', '/emergency-access', '/quarantine']);

export function prefetchFirstScreen(pathname) {
  if (!getToken() || wasEmergencyTab()) return;
  if (APP_PATHS.has(pathname)) getMe().catch(() => {});
  const start = FIRST_SCREEN[pathname];
  if (!start) return;
  for (const request of start()) request.catch(() => {});
}
