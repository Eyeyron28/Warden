/**
 * The address the pairing QR points at: the server's validated public origin
 * when it has one (production), otherwise this page's own origin (development).
 * Never an address detected from the network, and never taken from a link.
 */
export function pairingOrigin(appUrl, pageOrigin = window.location.origin) {
  return appUrl || pageOrigin;
}

export function pairingUrl(appUrl, token, pageOrigin) {
  return `${pairingOrigin(appUrl, pageOrigin)}/pair/${token}`;
}
