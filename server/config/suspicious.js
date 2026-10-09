/**
 * Every threshold the "suspicious activity" flags use, in one place. The rules themselves are in
 * utils/suspicious.js; they are computed from the audit events when the timeline is read, so
 * changing a number here changes what is flagged without touching stored data.
 */
module.exports = Object.freeze({
  // A `login` from a country this account has not logged in from before (needs at least one earlier login).
  newCountry: { enabled: true },

  // This many `download` events inside the window.
  downloadBurst: { count: 10, windowMs: 5 * 60 * 1000 },

  // A successful `login` that follows at least this many `login_failed` events inside the window,
  // with no success in between.
  failedThenSuccess: { failures: 3, windowMs: 15 * 60 * 1000 },

  // A `login` from a device that the owner had signed out (the first sign-in after being signed out).
  signedOutDeviceActive: { enabled: true },

  // The banner on the Devices & activity page counts flagged events from this long ago.
  bannerLookbackMs: 7 * 24 * 60 * 60 * 1000,
});
