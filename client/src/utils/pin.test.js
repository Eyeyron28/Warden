import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { checkPin, isTrivialPin, MIN_PIN_LENGTH } from './pinRules.js';
import { MAX_PIN_FAILURES, afterRightPin, afterWrongPin, readLockout, waitSecondsAfter } from './pinLockout.js';
import {
  LEGACY_PIN_KDF,
  PIN_KDF,
  deriveKeyFromPin,
  isLocallyUnlocked,
  lockLocalVault,
  rewrapWithNewPin,
  unlockLocalVault,
  wrapDekForPin,
  getUnwrappedDEK,
} from '../services/localCrypto.js';

// ---------- the rules ----------

test('a PIN needs at least 6 characters; digits and letters are both fine', () => {
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(checkPin('48271').ok, false);
  assert.match(checkPin('48271').message, /at least 6/);
  assert.equal(checkPin('482917').ok, true);
  assert.equal(checkPin('mango-42').ok, true);
  assert.equal(checkPin('').ok, false);
  assert.equal(checkPin('a'.repeat(65)).ok, false);
});

test('trivial PINs are refused: repeats, sequences, repeated blocks and the very common ones', () => {
  for (const bad of ['000000', '111111', '999999', 'aaaaaa', '123456', '234567', '654321', '987654', '012345', 'abcdef', '121212', '123123', '112233', '445566', '696969', '159753', '123456789', 'password', 'qwerty123', '12341234']) {
    assert.equal(isTrivialPin(bad), true, `${bad} should be trivial`);
    assert.equal(checkPin(bad).ok, false, `${bad} should be refused`);
  }
  for (const fine of ['482917', '907153', 'tulip-81', '135792', '2468ab']) {
    assert.equal(isTrivialPin(fine), false, `${fine} should be fine`);
  }
  assert.match(checkPin('123456').message, /too easy to guess/);
});

test('the strength hint grows with length and variety, and says why a PIN is refused', () => {
  assert.equal(checkPin('482917').strength, 'fair');
  assert.equal(checkPin('48291736').strength, 'good');
  assert.equal(checkPin('4829173650').strength, 'strong');
  assert.equal(checkPin('tulip-81').strength, 'strong');
  assert.equal(checkPin('1234').strength, 'weak');
  assert.ok(checkPin('482917').hint.length > 0);
  assert.equal(checkPin('9').hint, '5 more to go.');
});

// ---------- local attempt limiting ----------

test('wrong PINs: three free tries, then a growing wait, then a lockout at 10', () => {
  let state;
  const waits = [];
  for (let i = 1; i < MAX_PIN_FAILURES; i += 1) {
    state = afterWrongPin(state, 1_000_000);
    waits.push(Math.round((state.notBefore - 1_000_000) / 1000));
    assert.equal(state.lockedOut, false);
  }
  assert.deepEqual(waits, [0, 0, 5, 15, 30, 60, 120, 300, 900]);
  state = afterWrongPin(state, 1_000_000);
  assert.equal(state.lockedOut, true);
  assert.equal(readLockout(state).lockedOut, true);
  assert.equal(waitSecondsAfter(10), Infinity);
});

test('the wait counts down, a right PIN resets everything, and a missing record means no limit', () => {
  const state = afterWrongPin(afterWrongPin(afterWrongPin(undefined, 0), 0), 0);
  assert.equal(readLockout(state, 1000).waitMs, 4000);
  assert.equal(readLockout(state, 6000).waitMs, 0);
  assert.equal(readLockout(state, 0).triesLeft, 7);
  assert.deepEqual(readLockout(afterRightPin()), { lockedOut: false, waitMs: 0, failures: 0, triesLeft: 10 });
  assert.deepEqual(readLockout(undefined), { lockedOut: false, waitMs: 0, failures: 0, triesLeft: 10 });
  // a lockout survives (it is a stored flag, not a timer)
  assert.equal(readLockout({ failures: 10, lockedOut: true }, Date.now() + 10 ** 10).lockedOut, true);
});

// ---------- the key derivation and the migration ----------

const aesWrap = (dek, kek) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(kek), iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { wrappedKey: wrapped.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
};

/** What the server used to hand a phone at pairing: scrypt N=2^15, context "encryption-key", AES-GCM. */
function legacyRecord(dek, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const kek = crypto.scryptSync(pin, `${salt}:encryption-key`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const wrapped = aesWrap(dek, kek);
  return {
    deviceId: 'd1',
    wrappedDEKPhonePin: wrapped.wrappedKey,
    wrappedDEKPhonePinIv: wrapped.iv,
    wrappedDEKPhonePinAuthTag: wrapped.authTag,
    wrappedDEKPhonePinSalt: salt,
  };
}

test('the new key derivation costs more than the old one and is stored with the wrap', async () => {
  assert.ok(PIN_KDF.N > LEGACY_PIN_KDF.N);
  assert.deepEqual([PIN_KDF.name, PIN_KDF.r, PIN_KDF.p], ['scrypt', 8, 1]);
  const dek = crypto.randomBytes(32);
  const record = await wrapDekForPin(dek, 'tulip-81');
  assert.deepEqual(record.kdf, { ...PIN_KDF });
  // the same PIN and salt under the old parameters make a different key
  const oldKey = await deriveKeyFromPin('tulip-81', record.wrappedDEKPhonePinSalt, LEGACY_PIN_KDF);
  const newKey = await deriveKeyFromPin('tulip-81', record.wrappedDEKPhonePinSalt, record.kdf);
  assert.notDeepEqual(Buffer.from(oldKey), Buffer.from(newKey));
  // and the record contains nothing that is the PIN
  assert.ok(!JSON.stringify(record).includes('tulip-81'));
});

test('a new wrap opens with its own PIN, not a wrong one, and needs no migration', async () => {
  lockLocalVault();
  const dek = crypto.randomBytes(32);
  const record = await wrapDekForPin(dek, 'tulip-81');
  await assert.rejects(unlockLocalVault('tulip-82', record), /Incorrect PIN/);
  assert.equal(isLocallyUnlocked(), false);
  const outcome = await unlockLocalVault('tulip-81', record);
  assert.deepEqual(outcome, { needsNewPin: false, reason: null });
  assert.deepEqual(Buffer.from(getUnwrappedDEK()), dek);
  lockLocalVault();
});

test('MIGRATION: an old short-PIN wrap still opens, forces a new PIN, and the re-wrapped record opens with the new cost', async () => {
  lockLocalVault();
  const dek = crypto.randomBytes(32);
  const old = legacyRecord(dek, '1234'); // four digits, old cost, no kdf field

  // still opens (so existing paired phones are not locked out of their own files) ...
  const outcome = await unlockLocalVault('1234', old);
  assert.equal(outcome.needsNewPin, true);
  assert.equal(outcome.reason, 'old-kdf');
  assert.deepEqual(Buffer.from(getUnwrappedDEK()), dek);

  // ... and the forced new PIN re-wraps the SAME key, locally, with the new parameters
  const upgraded = await rewrapWithNewPin('maple-5190');
  assert.deepEqual(upgraded.kdf, { ...PIN_KDF });
  assert.notEqual(upgraded.wrappedDEKPhonePinSalt, old.wrappedDEKPhonePinSalt);
  lockLocalVault();
  const merged = { ...old, ...upgraded };
  await assert.rejects(unlockLocalVault('1234', merged), /Incorrect PIN/, 'the old PIN no longer opens it');
  const reopened = await unlockLocalVault('maple-5190', merged);
  assert.deepEqual(reopened, { needsNewPin: false, reason: null });
  assert.deepEqual(Buffer.from(getUnwrappedDEK()), dek, 'the vault key is unchanged by the migration');
  lockLocalVault();
});

test('MIGRATION: a long-enough old PIN with the old cost is upgraded too; a trivial PIN on a new wrap is refused for use', async () => {
  lockLocalVault();
  const dek = crypto.randomBytes(32);
  const oldButLong = legacyRecord(dek, '482917');
  assert.equal((await unlockLocalVault('482917', oldButLong)).reason, 'old-kdf');
  lockLocalVault();
  // a wrap that was made with the new cost but a PIN the rules would now refuse
  const weak = await wrapDekForPin(dek, '000000');
  assert.deepEqual(await unlockLocalVault('000000', weak), { needsNewPin: true, reason: 'weak-pin' });
  lockLocalVault();
});

test('phone recovery keeps using the old derivation, so the PC can still match it', async () => {
  // deriveKeyFromToken must stay byte-identical to the server (version 1); only PINs moved on.
  const { deriveKeyFromToken } = await import('../services/localCrypto.js');
  const salt = 'ab'.repeat(16);
  const expected = crypto.scryptSync('recovery-token', `${salt}:encryption-key`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  assert.deepEqual(Buffer.from(await deriveKeyFromToken('recovery-token', salt)), expected);
});
