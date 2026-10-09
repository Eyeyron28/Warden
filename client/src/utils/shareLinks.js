/**
 * Builds the "send this share link through an app" targets.
 *
 * The share link is https://<host>/shared/<id>#k=<key>. The part after # is the
 * decryption key. It is only ever put into the destination the person picked
 * (their own chat or mail app) - never into a request to Warden's server, a log,
 * or any analytics. Every value is passed through encodeURIComponent exactly once,
 * and every target is checked against an allowlist of schemes before use.
 */

export const SHARE_SUBJECT = 'A document shared with you on Warden';
export const SHARE_INTRO = 'I shared a document with you on Warden:';

/** The only schemes a share target may use. */
export const ALLOWED_SCHEMES = Object.freeze(['https:', 'viber:', 'fb-messenger:']);

const PATH_RE = /^\/shared\/[A-Za-z0-9_-]{8,128}$/;

/**
 * Whether `link` looks like one of our share links: an https URL (http only for
 * localhost during development) on /shared/<id>, with nothing but an optional
 * #k=<key> fragment after it and no query string.
 */
export function isShareLink(link) {
  if (typeof link !== 'string' || link.length > 2048) return false;
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname));
  if (!secure || url.username || url.password || url.search) return false;
  if (!PATH_RE.test(url.pathname)) return false;
  return url.hash === '' || /^#k=[A-Za-z0-9_-]+$/.test(url.hash);
}

function requireShareLink(link) {
  if (!isShareLink(link)) throw new Error('Not a Warden share link.');
  return link;
}

/** The generic message every app gets: no file name, no purpose, no owner. */
export function shareMessage(link) {
  return `${SHARE_INTRO} ${requireShareLink(link)}`;
}

/** True when `href` uses one of the allowed schemes (and nothing else). */
export function isAllowedShareHref(href) {
  if (typeof href !== 'string' || /[\s\u0000-\u001f]/.test(href)) return false;
  try {
    return ALLOWED_SCHEMES.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

const enc = encodeURIComponent;

/** A single plausible email address, or null. */
function cleanRecipient(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  return /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]+$/.test(trimmed) ? trimmed : null;
}

/**
 * @param {{ link: string, recipientEmail?: string, mobile?: boolean }} input
 * @returns {Array<{ id: string, label: string, href: string, mode: 'link' | 'app' | 'copy-open', note?: string }>}
 *   mode 'link': a normal new-tab https link. 'app': a custom-scheme link that may
 *   not be handled (the UI then copies the link and says so). 'copy-open': copy the
 *   link first, then open the site (Messenger on a computer).
 */
export function buildShareTargets({ link, recipientEmail, mobile = false }) {
  requireShareLink(link);
  const message = shareMessage(link);
  const to = cleanRecipient(recipientEmail);

  const targets = [
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${enc(message)}`, mode: 'link' },
    { id: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${enc(link)}&text=${enc(SHARE_INTRO)}`, mode: 'link' },
    { id: 'viber', label: 'Viber', href: `viber://forward?text=${enc(message)}`, mode: 'app', note: 'Viber app not detected — link copied instead' },
    {
      id: 'gmail',
      label: 'Gmail',
      href: `https://mail.google.com/mail/?view=cm&fs=1${to ? `&to=${enc(to)}` : ''}&su=${enc(SHARE_SUBJECT)}&body=${enc(message)}`,
      mode: 'link',
    },
    mobile
      ? { id: 'messenger', label: 'Messenger', href: `fb-messenger://share/?link=${enc(link)}`, mode: 'app', note: 'Messenger app not detected — link copied instead' }
      : { id: 'messenger', label: 'Messenger', href: 'https://www.messenger.com/', mode: 'copy-open', note: 'Link copied — paste it in a chat' },
  ];

  for (const target of targets) {
    if (!isAllowedShareHref(target.href)) throw new Error(`Blocked share target: ${target.id}`);
  }
  return targets;
}

/** What the native share sheet gets (the link goes in `url`, not duplicated in `text`). */
export function nativeSharePayload(link) {
  requireShareLink(link);
  return { title: 'Warden', text: SHARE_INTRO, url: link };
}

/** A phone or tablet, by user agent (iPadOS reports as a Mac with a touch screen). */
export function isMobileDevice(userAgent = '', maxTouchPoints = 0) {
  return /Android|iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

/**
 * Copies text: the async clipboard API where it is available, otherwise a hidden
 * textarea and execCommand (older mobile browsers, non-secure contexts).
 * @returns {Promise<boolean>} whether the text was copied
 */
export async function copyText(text, env = globalThis) {
  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea route
  }
  try {
    const doc = env.document;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length); // iOS
    const done = doc.execCommand('copy');
    doc.body.removeChild(area);
    return Boolean(done);
  } catch {
    return false;
  }
}

/** The error-correction level and quiet zone the QR is drawn with (M, 4 modules). */
export const QR_OPTIONS = Object.freeze({ errorCorrectionLevel: 'M', margin: 4, width: 512 });

/** What the QR encodes: exactly the link that Copy copies. */
export function qrPayload(link) {
  return requireShareLink(link);
}
