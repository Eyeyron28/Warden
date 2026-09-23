const os = require('os');

// Adapter names to skip: virtualization/tunnel adapters that carry a
// real, non-internal IPv4 address but aren't the physical network a
// phone or another device on the LAN could ever actually reach.
const SKIP_ADAPTER_PATTERN = /virtualbox|vmware|vethernet|wsl|hyper-v|loopback/i;

// 192.168.56.0/24 is VirtualBox's default host-only network range. On
// this machine it shows up on an adapter literally named "Ethernet 3" -
// not anything matching SKIP_ADAPTER_PATTERN - so it's excluded by
// address range too, not just by adapter name, in case a VirtualBox
// host-only adapter is ever renamed or not obviously labeled.
const VIRTUALBOX_HOST_ONLY_PREFIX = '192.168.56.';

/**
 * Auto-detects this machine's LAN-reachable IPv4 address - the one a
 * phone or another device on the same network could actually use to
 * reach this PC. Re-scans os.networkInterfaces() on every call rather
 * than caching a value once at startup, so it stays correct even if the
 * network changes (Wi-Fi to hotspot, a new venue) without a server
 * restart - the whole point of this module existing is to never need a
 * hand-edited IP again.
 *
 * Skips: internal/loopback addresses, IPv6, VirtualBox's host-only
 * range/adapter, and other common virtual adapters (VMware, Windows'
 * vEthernet, WSL, Hyper-V) that have a real IPv4 address but nothing
 * outside this machine can actually reach.
 *
 * @returns {{ ip: string, adapter: string } | null}
 */
function detectLanIp() {
  const interfaces = os.networkInterfaces();

  for (const [adapter, addresses] of Object.entries(interfaces)) {
    if (SKIP_ADAPTER_PATTERN.test(adapter)) continue;

    for (const addr of addresses || []) {
      if (addr.internal) continue;
      // Node has returned the family as either the string 'IPv4' or the
      // number 4 across different versions - checking both keeps this
      // correct regardless of which Node runs it.
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.address.startsWith(VIRTUALBOX_HOST_ONLY_PREFIX)) continue;

      return { ip: addr.address, adapter };
    }
  }

  return null;
}

module.exports = { detectLanIp };
