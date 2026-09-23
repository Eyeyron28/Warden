const { detectLanIp } = require('./lanIp');

/**
 * Determines the PC's LAN-reachable IP address for a device physically
 * elsewhere on the network (a phone, another computer) to call directly.
 *
 * detectLanIp() (utils/lanIp.js, os.networkInterfaces()-based) is the
 * primary answer now - it re-detects fresh on every call, so this stays
 * correct across network changes with no manual editing. LAN_IP is kept
 * as an explicit manual override for the rare case auto-detection picks
 * the wrong interface (e.g. multiple real NICs) - set it in .env and it
 * always wins over auto-detection.
 *
 * Shared by pairing.controller.js (building apiBase, the backend's own
 * address, for the phone to POST back to) and shares.controller.js
 * (building the network share link, at the frontend's port) - both need
 * the same LAN IP, just combined with a different port/path afterward,
 * so the IP-resolution logic itself lives here once rather than twice.
 *
 * Returns null if no LAN IP could be determined - callers are expected
 * to fail loudly (a clear 500, not a silently broken localhost link)
 * rather than falling back to something that only works on this machine.
 */
function resolveLanIp() {
  if (process.env.LAN_IP) {
    return process.env.LAN_IP;
  }

  return detectLanIp()?.ip ?? null;
}

module.exports = { resolveLanIp };
