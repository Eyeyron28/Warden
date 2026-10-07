// Run with: cd client && npm test   (Node's built-in test runner, no deps)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  KDF_PARAMS,
  deriveShareSecrets,
  parseShareLink,
  passwordProblem,
  randomSalt,
  toBase64,
  toBase64Url,
  unwrapShareKey,
  wrapShareKey,
} from './sharePassword.js';

// The server's view of the same scheme (test/share-gates.test.js builds the
// vectors the same way): scrypt, then HMAC under two labels.
const require = createRequire(import.meta.url);
const serverCrypto = require('../../../server/utils/shareCrypto.js');
const serverGate = require('../../../server/utils/shareGate.js');

function serverDerive(password, salt) {
  const master = crypto.scryptSync(password.normalize('NFKC'), salt, 32, { ...KDF_PARAMS, maxmem: 128 * 1024 * 1024 });
  const mac = (label) => crypto.createHmac('sha256', master).update(label).digest();
  return { wrap: mac('warden-share-wrap-v1'), verify: mac('warden-share-verify-v1') };
}

test('the browser and the server derive the same verifier, and the wrap key is a different value', async () => {
  const salt = randomSalt();
  const { verifier } = await deriveShareSecrets('Correct Horse Battery', salt);
  const server = serverDerive('Correct Horse Battery', Buffer.from(salt));
  assert.equal(verifier, server.verify.toString('base64'));
  assert.notEqual(verifier, server.wrap.toString('base64'), 'domain separation: verifier is not the wrap key');
  // Another password or salt gives something else entirely.
  assert.notEqual((await deriveShareSecrets('Correct Horse Batterx', salt)).verifier, verifier);
  assert.notEqual((await deriveShareSecrets('Correct Horse Battery', randomSalt())).verifier, verifier);
});

test('NFKC normalisation: visually identical passwords derive the same secrets', async () => {
  const salt = randomSalt();
  const composed = await deriveShareSecrets('café-pass-1', salt);
  const decomposed = await deriveShareSecrets('café-pass-1', salt);
  assert.equal(composed.verifier, decomposed.verifier);
});

test('a share key wraps under the password and only that password unwraps it', async () => {
  const shareKey = crypto.randomBytes(32);
  const shareId = crypto.randomBytes(16).toString('hex');
  const salt = randomSalt();
  const { wrapKey, verifier } = await deriveShareSecrets('open sesame', salt);
  const wrapped = await wrapShareKey(shareKey, wrapKey, shareId);
  assert.equal(Buffer.from(wrapped, 'base64').length, 60, 'iv 12 + key 32 + tag 16, as the server requires');

  assert.ok(Buffer.from(await unwrapShareKey(wrapped, wrapKey, shareId)).equals(shareKey));
  const wrongPassword = (await deriveShareSecrets('open sesamE', salt)).wrapKey;
  await assert.rejects(unwrapShareKey(wrapped, wrongPassword, shareId), 'wrong password');
  await assert.rejects(unwrapShareKey(wrapped, wrapKey, 'f'.repeat(32)), 'wrong share id');

  // The server, holding only the stored hash and the wrapped blob, can open nothing.
  const stored = serverGate.sha256(Buffer.from(verifier, 'base64'));
  const asKey = await crypto.subtle.importKey('raw', Buffer.from(stored, 'hex'), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(unwrapShareKey(wrapped, asKey, shareId), 'the stored hash is not a key');
  const verifierKey = await crypto.subtle.importKey('raw', Buffer.from(verifier, 'base64'), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(unwrapShareKey(wrapped, verifierKey, shareId), 'the verifier is not the wrap key');
  assert.ok(toBase64(new Uint8Array([1, 2, 3])) === 'AQID');
});

test('the server accepts exactly the material the browser makes', async () => {
  // Same parsing rules as shares.controller.parsePasswordBody, applied to real output.
  const shareKey = serverCrypto.generateShareKey();
  const salt = randomSalt();
  const { wrapKey, verifier } = await deriveShareSecrets('pw-123456', salt);
  const wrappedKey = await wrapShareKey(shareKey, wrapKey, 'a'.repeat(32));
  assert.equal(Buffer.from(salt).length, 16);
  assert.equal(Buffer.from(verifier, 'base64').length, 32);
  assert.equal(Buffer.from(wrappedKey, 'base64').length, 60);
  assert.ok(KDF_PARAMS.N >= 2 ** 15 && KDF_PARAMS.r === 8 && KDF_PARAMS.p === 1);
});

test('parseShareLink reads a pasted link and rejects anything else', () => {
  const id = 'a'.repeat(32);
  const key = toBase64Url(crypto.randomBytes(32));
  assert.deepEqual(parseShareLink(`https://warden.example.com/shared/${id}#k=${key}`), { shareId: id, keyText: key });
  assert.deepEqual(parseShareLink(`  https://warden.example.com/shared/${id}  `), { shareId: id, keyText: null });
  for (const bad of ['', 'nope', 'https://x.com/other', `https://x.com/shared/${id}x`, `https://x.com/shared/${'g'.repeat(32)}`, null, undefined, 42]) {
    assert.equal(parseShareLink(bad), null, String(bad));
  }
  assert.equal(parseShareLink(`https://x.com/shared/${id}#k=short`).keyText, null);
});

test('passwordProblem asks for a reasonable minimum', () => {
  assert.notEqual(passwordProblem('short'), '');
  assert.notEqual(passwordProblem('aaaaaaaaaa'), '');
  assert.equal(passwordProblem('a-reasonable-passphrase'), '');
});
