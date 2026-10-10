/**
 * Deny-by-default guard for Emergency Access sessions (security model: utils/emergency/config.js).
 *
 * An emergency session (req.emergency, set by requireSession) is READ-ONLY and may call ONLY the routes listed
 * here: validate the session, log out, list folders and files (already narrowed to the scope), and preview or
 * download a file inside the scope. EVERYTHING else answers 403: uploads, renames, moves, deletes, Trash,
 * shares, export/import, the account, settings, devices, the activity log, Overview, health, and emergency setup.
 *
 * The check lives in requireSession (the one place every signed-in route goes through), so a route added later is
 * refused for an emergency session unless somebody adds it to this list on purpose. The test
 * test/emergency-allowlist.test.js walks the real router stack and fails if a registered route is neither listed
 * here nor refused.
 */

const ID = '[0-9a-f]{24}';

const ALLOWLIST = Object.freeze([
  { method: 'GET', path: /^\/api\/auth\/me$/, note: 'session validation' },
  { method: 'POST', path: /^\/api\/auth\/logout$/, note: 'log out' },
  { method: 'GET', path: /^\/api\/documents$/, note: 'list files in scope' },
  { method: 'GET', path: /^\/api\/documents\/folders$/, note: 'folder list in scope' },
  { method: 'GET', path: /^\/api\/documents\/folders\/children$/, note: 'folder children in scope' },
  { method: 'GET', path: new RegExp(`^/api/documents/${ID}/view$`), note: 'preview / download a file in scope' },
  { method: 'GET', path: new RegExp(`^/api/documents/${ID}/thumbnail$`), note: 'small preview of a file in scope' },
]);

/** 'GET /api/documents/abc/view' -> the allowlist entry, or null. HEAD counts as GET. */
function matchAllowlist(method, fullPath) {
  const verb = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
  const path = String(fullPath || '').replace(/\/+$/, '') || '/';
  return ALLOWLIST.find((entry) => entry.method === verb && entry.path.test(path)) || null;
}

function forbidden() {
  const error = new Error('This is read-only emergency access. That action is not available.');
  error.status = 403;
  error.code = 'EMERGENCY_READ_ONLY';
  return error;
}

/** Throws a 403 unless this request is on the allowlist. Call only for emergency sessions. */
function assertEmergencyAllowed(req) {
  const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
  if (!matchAllowlist(req.method, fullPath)) throw forbidden();
}

module.exports = { ALLOWLIST, matchAllowlist, assertEmergencyAllowed };
