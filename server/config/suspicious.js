module.exports = Object.freeze({
  newCountry: { enabled: true },

  downloadBurst: { count: 10, windowMs: 5 * 60 * 1000 },

  failedThenSuccess: { failures: 3, windowMs: 15 * 60 * 1000 },

  signedOutDeviceActive: { enabled: true },

  bannerLookbackMs: 7 * 24 * 60 * 60 * 1000,
});
