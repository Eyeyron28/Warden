/**
 * Every email Warden sends is built here, and nowhere else.
 *
 * `renderEmail` turns structured input into { subject, html, text }. Callers pass
 * those to sendEmail, which sends them as multipart/alternative (plain text plus
 * HTML). The named builders at the bottom (`templates.*`) are the only emails that
 * exist; a controller never writes its own wording or markup.
 *
 * The HTML is built for email clients, not browsers:
 *   - table layout, 600px wide at most, every style inline (the one <style> block
 *     only adds dark-mode and small-screen refinements; mail that strips it still
 *     reads correctly);
 *   - system fonts, no JavaScript, no remote images, no tracking pixels: nothing in
 *     a message loads from another site;
 *   - a dark header band with the text wordmark, a light card below it, and
 *     color-scheme meta tags so Gmail's dark mode keeps it readable;
 *   - a hidden preheader line (the inbox preview text);
 *   - a code is shown ALONE in one highlighted box as a single unbroken string
 *     (double-click selects it, copy gives exactly the digits).
 *
 * Safety: every interpolated value is HTML-escaped; subjects are fixed strings (no
 * user text, no code); bodies never contain share keys (#k=), reset tokens, other
 * people's addresses, file names or share purposes. Links go only to the app's own
 * public address (PUBLIC_APP_URL) and never carry a token.
 *
 * These are transactional messages (the person just did something, or someone did
 * something to their account), so there is deliberately no unsubscribe link.
 */

const BRAND = Object.freeze({
  accent: '#d45ebb',
  dark: '#130c11',
  card: '#ffffff',
  ink: '#1c1420',
  muted: '#5e5160',
  tint: '#fbeaf7',
  line: '#e8dce6',
  page: '#f4eff3',
});

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

const FOOTER_AUTOMATED = 'This is an automated message from Warden. Please do not reply.';
const FOOTER_PROJECT = 'Warden — a capstone project, PHINMA University of Pangasinan';

const NEVER_SHARE = 'Never share this code with anyone — Warden will never ask for it by phone, chat or email.';
const IGNORE_IF_NOT_YOU =
  "If you didn't request this, ignore this email; your account is safe. Consider changing your password if you keep receiving these.";

/** Escapes text for HTML (element content and double-quoted attributes). */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** A plain-text value: no control characters, so nothing can forge extra lines or headers. */
function line(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** "Oct 9, 2026, 5:14 PM PHT (UTC+8)" - the time in Manila, labelled. */
function formatManilaTime(date = new Date()) {
  const when = new Date(date).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${when} Philippine Time (UTC+8)`;
}

/** The app's public origin for links, or null when none is configured (development). */
function appOrigin() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** A link to a fixed path on the app (never carries a token or key), or null. */
function appLink(pathname) {
  const origin = appOrigin();
  return origin ? `${origin}${pathname}` : null;
}

function renderDetailsHtml(details) {
  if (!details?.length) return '';
  const rows = details
    .map(
      ([label, value]) =>
        `<tr><td class="muted" style="padding:6px 12px 6px 0;font-size:14px;line-height:20px;color:${BRAND.muted};vertical-align:top;white-space:nowrap;">${esc(label)}</td>` +
        `<td class="ink" style="padding:6px 0;font-size:14px;line-height:20px;color:${BRAND.ink};vertical-align:top;word-break:break-word;">${esc(value)}</td></tr>`
    )
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;border-top:1px solid ${BRAND.line};border-bottom:1px solid ${BRAND.line};">` +
    `<tr><td style="padding:10px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`
  );
}

/**
 * @param {{
 *   subject: string,                 // fixed text, never the code or personal data
 *   preheader: string,               // the inbox preview line (hidden in the message)
 *   title: string,
 *   intro: string,
 *   code?: string,                   // a single unbroken string such as 482916
 *   codeNote?: string,               // shown directly under the code ("This code expires in 5 minutes")
 *   details?: Array<[string, string]>,
 *   warning?: string,
 *   cta?: { label: string, href: string } | null,   // a button; href must come from appLink()
 *   footerNote?: string,             // one extra sentence above the standard footer
 * }} input
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderEmail({ subject, preheader, title, intro, code, codeNote, details, warning, cta, footerNote }) {
  const hasCode = typeof code === 'string' && code !== '';
  if (hasCode && !/^\d{6}$/.test(code)) throw new Error('A code must be a single unbroken string of 6 digits.');
  if (/[\r\n]/.test(subject) || (hasCode && subject.includes(code))) throw new Error('The subject must be a single line without the code.');
  if (cta && !/^https:\/\//.test(cta.href)) throw new Error('A link must be an https address.');

  const pre = esc(preheader);
  // Pad the preheader so the inbox preview never pulls in body text.
  const padding = '&#847;&zwnj;&nbsp;'.repeat(40);

  const codeBlock = hasCode
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;"><tr>` +
      `<td align="center" class="codebox" bgcolor="${BRAND.tint}" style="background:${BRAND.tint};border:1px solid ${BRAND.accent};border-radius:10px;padding:20px 12px;">` +
      `<span class="code" style="display:inline-block;font-family:${MONO_STACK};font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:${BRAND.dark};">${esc(code)}</span>` +
      `</td></tr></table>` +
      (codeNote ? `<p class="muted" style="margin:0 0 4px;text-align:center;font-size:14px;line-height:20px;color:${BRAND.muted};">${esc(codeNote)}</p>` : '')
    : '';

  const warningBlock = warning
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;"><tr>` +
      `<td class="warnbox" style="border-left:4px solid ${BRAND.accent};background:${BRAND.page};padding:12px 14px;font-size:14px;line-height:21px;color:${BRAND.ink};">${esc(warning)}</td></tr></table>`
    : '';

  const ctaBlock = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;"><tr>` +
      `<td align="center" bgcolor="${BRAND.accent}" style="border-radius:8px;background:${BRAND.accent};">` +
      `<a href="${esc(cta.href)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${BRAND.dark};text-decoration:none;">${esc(cta.label)}</a>` +
      `</td></tr></table>`
    : '';

  const html =
    '<!doctype html>\n' +
    '<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n<meta name="supported-color-schemes" content="light dark">\n' +
    `<title>${esc(title)}</title>\n` +
    '<style>\n' +
    '@media (max-width:480px){.wrap{width:100%!important}.pad{padding:24px 18px!important}}\n' +
    '@media (prefers-color-scheme:dark){.bg{background:#0e090d!important}.card{background:#1b1319!important}' +
    '.ink{color:#f3e9f0!important}.muted{color:#b9a9b4!important}.codebox{background:#2a1626!important;border-color:#d45ebb!important}' +
    '.code{color:#ffd6f3!important}.warnbox{background:#251a22!important;color:#f3e9f0!important}}\n' +
    '</style>\n</head>\n' +
    `<body class="bg" style="margin:0;padding:0;background:${BRAND.page};">\n` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.page};opacity:0;">${pre}${padding}</div>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" bgcolor="${BRAND.page}" style="background:${BRAND.page};"><tr><td align="center" style="padding:24px 12px;">\n` +
    `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">\n` +
    `<tr><td bgcolor="${BRAND.dark}" style="background:${BRAND.dark};border-radius:12px 12px 0 0;padding:20px 28px;">` +
    `<span style="font-family:${FONT_STACK};font-size:24px;line-height:28px;font-weight:700;letter-spacing:1px;color:${BRAND.accent};">Warden</span></td></tr>\n` +
    `<tr><td class="card pad" bgcolor="${BRAND.card}" style="background:${BRAND.card};padding:32px 28px;border-radius:0 0 12px 12px;font-family:${FONT_STACK};">\n` +
    `<h1 class="ink" style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:700;color:${BRAND.ink};">${esc(title)}</h1>\n` +
    `<p class="ink" style="margin:0;font-size:16px;line-height:24px;color:${BRAND.ink};">${esc(intro)}</p>\n` +
    codeBlock +
    renderDetailsHtml(details) +
    warningBlock +
    ctaBlock +
    '\n</td></tr>\n' +
    `<tr><td align="center" style="padding:18px 12px 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${BRAND.muted};">` +
    (footerNote ? `<span class="muted" style="color:${BRAND.muted};">${esc(footerNote)}</span><br>` : '') +
    `<span class="muted" style="color:${BRAND.muted};">${esc(FOOTER_AUTOMATED)}</span><br>` +
    `<span class="muted" style="color:${BRAND.muted};">${esc(FOOTER_PROJECT)}</span></td></tr>\n` +
    '</table>\n</td></tr></table>\n</body>\n</html>\n';

  const parts = [line(title), '', line(intro)];
  if (hasCode) {
    parts.push('', code);
    if (codeNote) parts.push(line(codeNote));
  }
  if (details?.length) parts.push('', ...details.map(([label, value]) => `${line(label)}: ${line(value)}`));
  if (warning) parts.push('', line(warning));
  if (cta) parts.push('', `${line(cta.label)}: ${cta.href}`);
  parts.push('', '--');
  if (footerNote) parts.push(line(footerNote));
  parts.push(FOOTER_AUTOMATED, FOOTER_PROJECT);

  return { subject, html, text: `${parts.join('\n')}\n` };
}

const minutes = (n) => `${n} minute${n === 1 ? '' : 's'}`;
const expiresNote = (ttlMinutes) => `This code expires in ${minutes(ttlMinutes)}`;

/** A code email. `purposeLine` says in plain words what the code is for. */
function codeEmail({ subject, preheader, title, purposeLine, code, ttlMinutes, warning }) {
  return renderEmail({
    subject,
    preheader,
    title,
    intro: `${purposeLine} Enter this code where Warden asked for it.`,
    code,
    codeNote: expiresNote(ttlMinutes),
    warning: warning || `${NEVER_SHARE} ${IGNORE_IF_NOT_YOU}`,
  });
}

const templates = {
  signInCode: ({ code, ttlMinutes }) =>
    codeEmail({
      subject: 'Your Warden sign-in code',
      preheader: 'Use this code to sign in to Warden.',
      title: 'Sign in to Warden',
      purposeLine: 'Someone entered your email and password to sign in to Warden.',
      code,
      ttlMinutes,
    }),

  deleteAccountCode: ({ code, ttlMinutes }) =>
    codeEmail({
      subject: 'Confirm account deletion — Warden code',
      preheader: 'A code to confirm deleting your Warden account.',
      title: 'Confirm deleting your account',
      purposeLine: 'A request was made to permanently delete your Warden account and everything in it.',
      code,
      ttlMinutes,
      warning: `${NEVER_SHARE} ${IGNORE_IF_NOT_YOU} Deleting an account cannot be undone: if this was not you, change your password now, because someone may be signed in to your account.`,
    }),

  passwordResetCode: ({ code, ttlMinutes }) =>
    codeEmail({
      subject: 'Reset your Warden password',
      preheader: 'A code to reset your Warden password.',
      title: 'Reset your password',
      purposeLine: 'A request was made to reset the password of your Warden account.',
      code,
      ttlMinutes,
      warning: `${NEVER_SHARE} ${IGNORE_IF_NOT_YOU} Your password has not changed and will not unless this code is entered; if you did not ask for this, someone may know your email address.`,
    }),

  pairDeviceCode: ({ code, ttlMinutes }) =>
    codeEmail({
      subject: 'Your Warden code for pairing a device',
      preheader: 'A code to pair a new device with your Warden account.',
      title: 'Pair a new device',
      purposeLine: 'A request was made to pair a new phone with your Warden account.',
      code,
      ttlMinutes,
      warning: `${NEVER_SHARE} ${IGNORE_IF_NOT_YOU} If you did not ask to pair a device, someone may be signed in to your account: change your password now.`,
    }),

  shareCode: ({ code, ttlMinutes }) =>
    codeEmail({
      subject: 'Your code to open a shared document',
      preheader: 'A code to open a document someone shared with you on Warden.',
      title: 'Open a shared document',
      purposeLine: 'Someone shared a document with you on Warden, and it can only be opened with this code.',
      code,
      ttlMinutes,
      warning: `${NEVER_SHARE} If you didn't request this, ignore this email; nothing was opened and no account is involved.`,
    }),

  verifyEmail: ({ verifyUrl }) =>
    renderEmail({
      subject: 'Verify your Warden account',
      preheader: 'One step left: confirm your email address.',
      title: 'Welcome to Warden',
      intro: 'Confirm your email address to finish setting up your account. You will not be able to log in until you do.',
      cta: verifyUrl ? { label: 'Verify my email', href: verifyUrl } : null,
      warning: `The link expires in 24 hours. If you didn't sign up for Warden, ignore this email; no account will be used.`,
    }),

  verifyEmailResend: ({ verifyUrl }) =>
    renderEmail({
      subject: 'Your new Warden verification link',
      preheader: 'Here is a new link to confirm your email address.',
      title: 'Verify your email',
      intro: 'Here is a new link to confirm your email address. Any earlier link no longer works.',
      cta: verifyUrl ? { label: 'Verify my email', href: verifyUrl } : null,
      warning: `The link expires in 24 hours. If you didn't ask for it, ignore this email.`,
    }),

  signupAttempt: ({ when }) =>
    renderEmail({
      subject: 'Someone tried to sign up to Warden with your email',
      preheader: 'Nothing changed on your account.',
      title: 'Someone tried to sign up with your email',
      intro:
        'Someone tried to register for Warden with this email address, which already has an account. Nothing was changed: your account, your documents and your password are exactly as they were.',
      details: [['When', formatManilaTime(when)], ['What happened', 'A sign-up attempt was refused']],
      warning: 'If it was you, just log in, or use "Forgot password" on the login page. If it was not you, you do not need to do anything.',
      cta: appLink('/login') ? { label: 'Open Warden', href: appLink('/login') } : null,
    }),

  passwordChanged: ({ method, when, browser }) => {
    const wipe = method === 'wipe';
    return renderEmail({
      subject: 'Your Warden password was changed',
      preheader: 'Your password was reset and every device was signed out.',
      title: 'Your password was changed',
      intro: wipe
        ? 'Your Warden password was reset without your recovery key. Your previous vault was erased and replaced by a new, empty one with a new recovery key.'
        : 'Your Warden password was changed using your recovery key. Your documents were kept.',
      details: [
        ['When', formatManilaTime(when)],
        ['Browser', browser || 'Unknown'],
        ['What happened', wipe ? 'Password reset, vault erased and replaced' : 'Password changed with the recovery key'],
        ['Signed out', 'Every device, and all trusted browsers'],
      ],
      warning: wipe
        ? "If this wasn't you, someone can read this mailbox: secure your email account first, then reset your Warden password again."
        : "If this wasn't you, someone has your recovery key: reset your password now and treat the documents in this vault as exposed.",
      cta: appLink('/forgot-password') ? { label: 'Reset your password now', href: appLink('/forgot-password') } : null,
      footerNote: 'The next login needs your new password and an emailed code.',
    });
  },

  accountDeleted: ({ when }) =>
    renderEmail({
      subject: 'Your Warden account was deleted',
      preheader: 'Your account and all of its data were permanently deleted.',
      title: 'Your account was deleted',
      intro:
        'Your Warden account and all of its data have been permanently deleted. We have no copy of your documents and cannot recover them. This message is only a confirmation.',
      details: [['When', formatManilaTime(when)], ['What happened', 'Account and data permanently deleted']],
      warning: "If you didn't do this, someone had access to your account. Contact whoever runs this Warden right away.",
    }),

  devicePaired: ({ name, browser, when }) =>
    renderEmail({
      subject: 'A new device was paired with your Warden account',
      preheader: 'A new phone can now sync your files.',
      title: 'A new device was paired',
      intro: 'A new device was paired with your Warden account. It can now sync your files and open them with its own PIN.',
      details: [['Device name', name || 'Unnamed device'], ['Browser', browser || 'Unknown'], ['When', formatManilaTime(when)]],
      warning: "If this wasn't you, remove the device on the Devices page and reset your password now.",
      cta: appLink('/devices') ? { label: 'Review your devices', href: appLink('/devices') } : null,
    }),

  trustedBrowser: ({ browser, when }) =>
    renderEmail({
      subject: 'New trusted browser on your Warden account',
      preheader: 'A browser was set to skip the emailed code for 30 days.',
      title: 'A browser is now trusted',
      intro: 'A browser was set to skip the emailed sign-in code for 30 days. It still needs your password.',
      details: [['Browser', browser || 'Unknown'], ['When', formatManilaTime(when)], ['Trusted for', '30 days']],
      warning: "If this wasn't you, reset your password now: that removes every trusted browser.",
      cta: appLink('/forgot-password') ? { label: 'Reset your password now', href: appLink('/forgot-password') } : null,
    }),
};

module.exports = { renderEmail, templates, esc, formatManilaTime, appLink, BRAND, FOOTER_AUTOMATED, FOOTER_PROJECT, NEVER_SHARE, IGNORE_IF_NOT_YOU };
