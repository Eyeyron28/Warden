/**
 * A gentle "Did you mean name@gmail.com?" for the most common typos in the domain part of an address. It only ever SUGGESTS:
 * the form is never blocked, and a domain that is not on this list is never touched.
 */

const FIXES = Object.freeze({
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.cmo': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
});

/**
 * @param {string} value what was typed in the email field
 * @returns {string | null} the corrected address to offer, or null when nothing looks like a known typo
 */
export function suggestEmailFix(value) {
  const text = String(value ?? '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  const fixed = FIXES[domain];
  return fixed ? `${local}@${fixed}` : null;
}

export const TYPO_DOMAINS = Object.keys(FIXES);
