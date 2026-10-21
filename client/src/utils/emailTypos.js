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
