/**
 * Warden password policy - mirrors server/utils/passwordPolicy.js exactly,
 * so the strength meter and requirement checklist can update on every
 * keystroke without a round-trip to the backend. Keep the two in sync if
 * the rules ever change; the backend is still the source of truth and
 * re-validates on submit.
 */

// 12, not the more common 8 - see the backend module for the full
// rationale (NIST SP 800-63B, offline brute-force resistance).
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

const SPECIAL_CHARS = new Set('!@#$%^&*()_+-=[]{};\':"\\|,.<>/?'.split(''));

// Small hardcoded blocklist - a real product would check a breach corpus
// (e.g. Have I Been Pwned), but Warden is fully offline by design.
const COMMON_PASSWORDS = [
  'password',
  '12345678',
  'qwerty',
  'letmein',
  'admin',
  'warden',
  'iloveyou',
  'welcome',
  'monkey',
  'dragon',
];

const SEQUENTIAL_RUN_LENGTH = 4;

function hasUppercase(password) {
  return /[A-Z]/.test(password);
}

function hasLowercase(password) {
  return /[a-z]/.test(password);
}

function hasDigit(password) {
  return /[0-9]/.test(password);
}

function hasSpecialChar(password) {
  return [...password].some((ch) => SPECIAL_CHARS.has(ch));
}

function hasNoSpaces(password) {
  return !/\s/.test(password);
}

function containsCommonPassword(password) {
  const lower = password.toLowerCase();
  return COMMON_PASSWORDS.some((word) => lower.includes(word));
}

function hasSequentialRun(password) {
  let ascending = 1;
  let descending = 1;

  for (let i = 1; i < password.length; i += 1) {
    const prev = password.charCodeAt(i - 1);
    const curr = password.charCodeAt(i);

    if (curr === prev + 1) {
      ascending += 1;
      descending = 1;
    } else if (curr === prev - 1) {
      descending += 1;
      ascending = 1;
    } else {
      ascending = 1;
      descending = 1;
    }

    if (ascending >= SEQUENTIAL_RUN_LENGTH || descending >= SEQUENTIAL_RUN_LENGTH) {
      return true;
    }
  }

  return false;
}

function hasRepeatedRun(password) {
  let run = 1;

  for (let i = 1; i < password.length; i += 1) {
    if (password[i] === password[i - 1]) {
      run += 1;
      if (run >= SEQUENTIAL_RUN_LENGTH) return true;
    } else {
      run = 1;
    }
  }

  return false;
}

function hasBadPattern(password) {
  return containsCommonPassword(password) || hasSequentialRun(password) || hasRepeatedRun(password);
}

/**
 * @param {string} password
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, errors: ['A password is required.'] };
  }

  const errors = [];

  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    errors.push(`Must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`);
  }
  if (!hasUppercase(password)) errors.push('Must include an uppercase letter.');
  if (!hasLowercase(password)) errors.push('Must include a lowercase letter.');
  if (!hasDigit(password)) errors.push('Must include a number.');
  if (!hasSpecialChar(password)) errors.push('Must include a special character.');
  if (!hasNoSpaces(password)) errors.push('Must not contain spaces.');
  if (containsCommonPassword(password)) errors.push('Must not contain a common word or password.');
  if (hasSequentialRun(password) || hasRepeatedRun(password)) {
    errors.push('Must not contain a sequential or repeated pattern (e.g. 1234, aaaa).');
  }

  return { valid: errors.length === 0, errors };
}

const STRENGTH_LABELS = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];

/**
 * @param {string} password
 * @returns {{ score: number, label: string }}
 */
function calculatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { score: 0, label: STRENGTH_LABELS[0] };
  }

  let points = 0;
  if (password.length >= MIN_LENGTH) points += 1;
  if (password.length >= 16) points += 1;
  if (password.length >= 20) points += 1;

  [hasUppercase, hasLowercase, hasDigit, hasSpecialChar].forEach((test) => {
    if (test(password)) points += 1;
  });

  if (hasBadPattern(password) || !hasNoSpaces(password)) {
    points = Math.min(points, 2);
  }

  let score;
  if (points <= 1) score = 0;
  else if (points <= 3) score = 1;
  else if (points <= 4) score = 2;
  else if (points <= 5) score = 3;
  else score = 4;

  return { score, label: STRENGTH_LABELS[score] };
}

/**
 * Requirement-by-requirement pass/fail, for the live checklist UI.
 * @param {string} password
 * @returns {Array<{ key: string, label: string, met: boolean }>}
 */
function getRequirementChecklist(password) {
  const value = typeof password === 'string' ? password : '';

  return [
    { key: 'length', label: `At least ${MIN_LENGTH} characters`, met: value.length >= MIN_LENGTH && value.length <= MAX_LENGTH },
    { key: 'uppercase', label: 'An uppercase letter', met: hasUppercase(value) },
    { key: 'lowercase', label: 'A lowercase letter', met: hasLowercase(value) },
    { key: 'digit', label: 'A number', met: hasDigit(value) },
    { key: 'special', label: 'A special character', met: hasSpecialChar(value) },
    { key: 'noSpaces', label: 'No spaces', met: hasNoSpaces(value) },
    { key: 'noCommon', label: 'No common words or passwords', met: !containsCommonPassword(value) },
    {
      key: 'noSequential',
      label: 'No sequential or repeated patterns',
      met: !hasSequentialRun(value) && !hasRepeatedRun(value),
    },
  ];
}

export { MIN_LENGTH, MAX_LENGTH, validatePassword, calculatePasswordStrength, getRequirementChecklist };
