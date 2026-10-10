const net = require('net');

/**
 * The ONE place a client address becomes a rate-limit key. Every limiter and every failure budget that counts by
 * address goes through here.
 *
 * IPv4 is kept as it is. An IPv6 address is reduced to its /64 prefix, because one subscriber normally holds a whole
 * /64 (or far more) and can rotate through its 2^64 addresses; counting each address separately would hand that
 * person a fresh budget on every request. An IPv4-mapped IPv6 address (::ffff:203.0.113.9) is the IPv4 address.
 *
 * Returns a string that is only ever used as a key, never shown or logged as an address.
 */
function ipKey(ip) {
  if (typeof ip !== 'string' || ip.trim() === '') return 'unknown';
  let address = ip.trim();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  if (net.isIPv4(address)) return address;
  if (!net.isIPv6(address)) return `raw:${address.slice(0, 64).toLowerCase()}`;

  const groups = expandIPv6(address);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  return `${groups.slice(0, 4).map((group) => group.toString(16).padStart(4, '0')).join(':')}::/64`;
}

/** Eight 16-bit groups of a valid IPv6 address. */
function expandIPv6(address) {
  let text = address.toLowerCase();
  // A dotted IPv4 tail (::ffff:1.2.3.4) is two more groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - first.length - last.length;
  const all = rest === undefined ? first : [...first, ...Array(Math.max(0, missing)).fill('0'), ...last];
  return all.map((group) => parseInt(group, 16));
}

module.exports = { ipKey };
