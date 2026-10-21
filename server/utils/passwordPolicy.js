const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

const SPECIAL_CHARS = new Set('!@#$%^&*()_+-=[]{};\':"\\|,.<>/?'.split(''));

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

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  validatePassword,
  calculatePasswordStrength,
};
