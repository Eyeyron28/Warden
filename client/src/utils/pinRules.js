/**
 * Rules for the PIN a phone uses to unlock its own copy of the vault. The PIN
 * protects a key stored on the phone, so a guesser who gets at that storage can
 * try PINs offline: the length floor, the block list and the slow key
 * derivation (services/localCrypto.js) are what make that expensive.
 */
export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 64;

const COMMON = new Set([
  '123456', '654321', '123123', '112233', '121212', '131313', '696969', '159753', '147258', '123321', '111222', '222333',
  '000111', '007007', '101010', '123654', '321321', '456456', '789789', '246810', '135790', '520520', '5201314',
  '1234567', '12345678', '123456789', '1234567890', '87654321', '987654321', '11111111', '00000000', '12341234',
  'password', 'qwerty', 'qwerty123', 'letmein', 'iloveyou', 'admin123', 'warden', 'warden123',
]);

const lower = (pin) => pin.toLowerCase();

/** 111111, aaaaaa */
const allSame = (pin) => pin.split('').every((ch) => ch === pin[0]);

/** 123456, 345678, 987654, abcdef - every character one step from the last. */
function isSequence(pin) {
  const codes = [...lower(pin)].map((ch) => ch.charCodeAt(0));
  if (codes.length < 3) return false;
  const step = codes[1] - codes[0];
  if (Math.abs(step) !== 1) return false;
  return codes.every((code, i) => i === 0 || code - codes[i - 1] === step);
}

/** 121212, 123123, 112211 - a short block repeated across the whole PIN. */
function isRepeatedBlock(pin) {
  for (let size = 1; size <= Math.floor(pin.length / 2); size += 1) {
    if (pin.length % size !== 0) continue;
    const block = pin.slice(0, size);
    if (block.repeat(pin.length / size) === pin) return true;
  }
  return false;
}

/** 112233, 667788 - each character doubled, stepping by one. */
function isDoubledSequence(pin) {
  if (pin.length % 2 !== 0) return false;
  const singles = [];
  for (let i = 0; i < pin.length; i += 2) {
    if (pin[i] !== pin[i + 1]) return false;
    singles.push(pin[i]);
  }
  return singles.length >= 3 && isSequence(singles.join(''));
}

/** Whether a PIN is on the block list or follows an obvious pattern. */
export function isTrivialPin(pin) {
  if (typeof pin !== 'string' || pin.length === 0) return true;
  return COMMON.has(lower(pin)) || allSame(pin) || isSequence(pin) || isRepeatedBlock(pin) || isDoubledSequence(pin);
}

/**
 * @param {string} pin
 * @returns {{ ok: boolean, message: string, strength: 'none' | 'weak' | 'fair' | 'good' | 'strong', hint: string }}
 *   `message` says why a PIN is refused ('' when it is fine); `hint` is the
 *   always-visible line under the field.
 */
export function checkPin(pin) {
  const value = typeof pin === 'string' ? pin : '';
  if (value.length === 0) {
    return { ok: false, message: '', strength: 'none', hint: `At least ${MIN_PIN_LENGTH} characters. Longer, or with letters, is stronger.` };
  }
  if (value.length < MIN_PIN_LENGTH) {
    return { ok: false, message: `The PIN must be at least ${MIN_PIN_LENGTH} characters.`, strength: 'weak', hint: `${MIN_PIN_LENGTH - value.length} more to go.` };
  }
  if (value.length > MAX_PIN_LENGTH) {
    return { ok: false, message: `The PIN can be at most ${MAX_PIN_LENGTH} characters.`, strength: 'weak', hint: '' };
  }
  if (isTrivialPin(value)) {
    return { ok: false, message: 'That PIN is too easy to guess (repeated digits, a sequence, or a very common PIN). Choose another.', strength: 'weak', hint: 'Avoid 123456, 000000, 121212 and the like.' };
  }
  const digitsOnly = /^\d+$/.test(value);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  const distinct = new Set(value).size;
  if (distinct < 4) {
    return { ok: false, message: 'That PIN uses too few different characters. Choose another.', strength: 'weak', hint: '' };
  }
  if (value.length >= 10 || (!digitsOnly && classes >= 2 && value.length >= 8)) {
    return { ok: true, message: '', strength: 'strong', hint: 'Strong.' };
  }
  if (value.length >= 8 || (!digitsOnly && classes >= 2)) {
    return { ok: true, message: '', strength: 'good', hint: 'Good.' };
  }
  return { ok: true, message: '', strength: 'fair', hint: 'Acceptable, but 8 or more characters, or letters and digits, is much harder to guess.' };
}
