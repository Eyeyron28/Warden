/**
 * Site-wide constants for the public pages. The one place to change the
 * contact address or project details shown across the landing site.
 */

// Where the Contact form's mailto: link is addressed. The form has no
// backend - it opens the visitor's own mail app with the message filled in.
export const CONTACT_EMAIL = 'wardenvaultapp@gmail.com';

export const SITE_NAME = 'Warden';

export const PROJECT = {
  school: 'PHINMA University of Pangasinan',
  program: 'BSIT 3',
  course: 'COMSEC',
  group: 'Group 7',
};

// The version of the Privacy policy shown on the privacy page and recorded with a new account's consent. Keep it equal to
// PRIVACY_POLICY_VERSION in server/utils/policyVersion.js (a test checks), and change both only when the page's text changes.
export const PRIVACY_POLICY = { version: '2026-10-15.2', date: '15 October 2026' };

// The project's source code (the repository this app is built from).
export const REPO_URL = 'https://github.com/Eyeyron28/Warden';

// Must match the server's own cap (server/routes/documents.routes.js).
export const MAX_FILE_SIZE_MB = 4;
