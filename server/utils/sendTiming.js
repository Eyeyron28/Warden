const smoothed = new Map();

function recordDuration(name, ms) {
  const previous = smoothed.get(name);
  smoothed.set(name, previous === undefined ? ms : previous * 0.7 + ms * 0.3);
}

function expectedDuration(name, fallback = 0) {
  return smoothed.get(name) ?? fallback;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function padLikeReal(name, startedAt, fallback = process.env.SMTP_HOST ? 700 : 0) {
  await wait(expectedDuration(name, fallback) * (0.85 + Math.random() * 0.3) - (Date.now() - startedAt));
}

module.exports = { recordDuration, expectedDuration, padLikeReal, wait };
