/**
 * Look-alike timing for the answers that must not reveal whether an address has an account.
 *
 * Where the real path sends an email and the other path sends nothing, the other path waits about as long as the real
 * one usually takes. The expected duration is learned per named path (smoothed, per server instance), with a
 * fallback before the first real sample. The wait is jittered a little so it is not a constant either.
 */
const smoothed = new Map();

function recordDuration(name, ms) {
  const previous = smoothed.get(name);
  smoothed.set(name, previous === undefined ? ms : previous * 0.7 + ms * 0.3);
}

function expectedDuration(name, fallback = 0) {
  return smoothed.get(name) ?? fallback;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Waits until about as long as the real path takes has passed since `startedAt` (a Date.now() value). */
async function padLikeReal(name, startedAt, fallback = process.env.SMTP_HOST ? 700 : 0) {
  await wait(expectedDuration(name, fallback) * (0.85 + Math.random() * 0.3) - (Date.now() - startedAt));
}

module.exports = { recordDuration, expectedDuration, padLikeReal, wait };
