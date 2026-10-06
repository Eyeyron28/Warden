/**
 * Site-wide constants for the public pages. The one place to change the
 * contact address or project details shown across the landing site.
 */

// Where the Contact form's mailto: link is addressed. The form has no
// backend - it opens the visitor's own mail app with the message filled in.
export const CONTACT_EMAIL = 'wardenadmin.noreply@gmail.com';

export const SITE_NAME = 'Warden';

export const PROJECT = {
  school: 'PHINMA University of Pangasinan',
  program: 'BSIT 3',
  course: 'COMSEC',
  group: 'Group 7',
};

// Must match the server's own cap (server/routes/documents.routes.js).
export const MAX_FILE_SIZE_MB = 4;
