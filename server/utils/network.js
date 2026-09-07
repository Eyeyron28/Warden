/**
 * Determines the PC's LAN-reachable IP address for a device physically
 * elsewhere on the network (a phone, another computer) to call directly.
 * There's no reliable way for a Node process to know its own LAN IP from
 * inside a request handler alone: a machine can have several network
 * interfaces (Wi-Fi, Ethernet, VPN, a Docker bridge...) and guessing
 * which one another device on the same network can actually reach is
 * exactly that - a guess.
 *
 * LAN_IP is the explicit, correct answer (see .env.example) and always
 * wins if set. Absent that, req.socket.localAddress is a best-effort
 * fallback - it only produces something useful if this request itself
 * happened to arrive via the LAN IP already, since a request to
 * localhost/127.0.0.1 makes the socket's local address equally useless
 * to another device.
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
function resolveLanIp(req) {
  if (process.env.LAN_IP) {
    return process.env.LAN_IP;
  }

  const socketAddress = req.socket.localAddress?.replace('::ffff:', '');
  if (socketAddress && socketAddress !== '127.0.0.1' && socketAddress !== '::1') {
    return socketAddress;
  }

  return null;
}

module.exports = { resolveLanIp };
