export const MAX_DEMO_CHARS = 140;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const webCrypto = () => globalThis.crypto;

export function demoSupported() {
  const c = webCrypto();
  return Boolean(c && c.subtle && c.getRandomValues);
}

export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex || '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error('not hex');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function createDemoKey() {
  return webCrypto().subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptDemo(key, text) {
  const c = webCrypto();
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(String(text ?? '').slice(0, MAX_DEMO_CHARS));
  const sealed = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ivHex: toHex(iv), cipherHex: toHex(sealed), plainBytes: data.length };
}

export async function decryptDemo(key, { ivHex, cipherHex }) {
  const opened = await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: fromHex(ivHex) }, key, fromHex(cipherHex));
  return new TextDecoder().decode(opened);
}

export const demoSizes = { IV_BYTES, TAG_BYTES };
