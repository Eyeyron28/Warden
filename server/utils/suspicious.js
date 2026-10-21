const config = require('../config/suspicious');

function computeFlags(events) {
  const flags = new Map();
  const add = (seq, flag) => {
    const list = flags.get(seq) || [];
    if (!list.includes(flag)) list.push(flag);
    flags.set(seq, list);
  };
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const time = (event) => new Date(event.at).getTime();

  if (config.newCountry.enabled) {
    const seenCountries = new Set();
    let sawLogin = false;
    for (const event of ordered) {
      if (event.type !== 'login') continue;
      if (event.country && sawLogin && !seenCountries.has(event.country)) add(event.seq, 'new_country');
      if (event.country) seenCountries.add(event.country);
      sawLogin = true;
    }
  }

  {
    const { count, windowMs } = config.downloadBurst;
    const downloads = ordered.filter((event) => event.type === 'download');
    let start = 0;
    for (let end = 0; end < downloads.length; end += 1) {
      while (time(downloads[end]) - time(downloads[start]) > windowMs) start += 1;
      if (end - start + 1 >= count) for (let i = start; i <= end; i += 1) add(downloads[i].seq, 'download_burst');
    }
  }

  {
    const { failures, windowMs } = config.failedThenSuccess;
    let recent = [];
    for (const event of ordered) {
      if (event.type === 'login_failed') {
        recent.push(event);
      } else if (event.type === 'login') {
        const inWindow = recent.filter((failure) => time(event) - time(failure) <= windowMs);
        if (inWindow.length >= failures) {
          add(event.seq, 'failed_then_success');
          for (const failure of inWindow) add(failure.seq, 'failed_then_success');
        }
        recent = [];
      }
    }
  }

  if (config.signedOutDeviceActive.enabled) {
    const signedOut = new Set();
    for (const event of ordered) {
      if (event.type === 'device_signed_out' && event.targetId) signedOut.add(String(event.targetId));
      if (event.type === 'login' && event.deviceId && signedOut.has(String(event.deviceId))) {
        add(event.seq, 'signed_out_device_active');
        signedOut.delete(String(event.deviceId));
      }
    }
  }

  for (const event of ordered) {
    if (event.type === 'emergency_session_started') add(event.seq, 'emergency_session');
  }

  return flags;
}

const FLAG_LABELS = Object.freeze({
  emergency_session: 'An emergency contact started a session',
  new_country: 'Sign-in from a new country',
  download_burst: 'Many downloads in a short time',
  failed_then_success: 'Sign-in after failed attempts',
  signed_out_device_active: 'A device you signed out signed in again',
});

module.exports = { computeFlags, FLAG_LABELS };
