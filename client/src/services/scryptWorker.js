import scryptJs from 'scrypt-js';

/**
 * Runs one scrypt derivation off the page's main thread. scrypt-js's async mode
 * pauses with setTimeout(0) every few hundred steps, which browsers clamp to
 * about 4 ms each: at the cost used for phone PINs that was several seconds of
 * pure waiting. Here the synchronous form runs flat out inside a worker, so the
 * page stays responsive and the time is just the work.
 */
self.onmessage = (event) => {
  const { password, salt, N, r, p, length } = event.data;
  try {
    const key = scryptJs.syncScrypt(password, salt, N, r, p, length);
    self.postMessage({ ok: true, key }, [key.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: String(error?.message || error) });
  }
};
