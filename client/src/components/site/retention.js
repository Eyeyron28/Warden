// How long each kind of data is kept. Every row has to match the code: utils/trash.js, utils/auditConfig.js,
// utils/sessionStore.js, utils/otpConfig.js, utils/trustedDevice.js, utils/shareLimits.js, utils/legacyCleanup.js.
export const RETENTION = [
  { what: 'Your files, folders and file details', how: 'Until you delete them or delete your account.' },
  { what: 'Trash', how: '30 days, still encrypted, then removed with the previews.' },
  { what: 'Activity log', how: '30 days by default. The person who runs this Warden can set a different number of days.' },
  { what: 'Sign-in sessions', how: 'They end after 30 minutes without activity, and after 12 hours at most.' },
  { what: 'Sign-up code (before an account exists)', how: 'A few minutes, then it is deleted. No account is made until you enter it.' },
  { what: 'Emailed login, reset and deletion codes', how: 'A few minutes, and deleted once used or expired.' },
  { what: 'Trusted browsers', how: '30 days, or until you remove them.' },
  { what: 'Share links and their encrypted copies', how: 'At most 30 days, or until the download limit is reached or you stop sharing.' },
  { what: 'Accounts from the old sign-up that were never verified', how: '24 hours, then the daily clean-up removes them if they hold no files. The current sign-up makes no account until the code is entered.' },
  { what: 'Request counters and the daily mail count', how: 'Counts only, kept from minutes up to about two days.' },
  { what: 'Your agreement (new accounts)', how: 'Kept with your account, and deleted with it.' },
  { what: 'Server logs', how: 'Kept by the hosting provider under its own log settings. They hold error text, a request number and security events as counts and short hashes, never email addresses.' },
  { what: 'Everything, when you delete your account', how: 'Removed immediately.' },
];
