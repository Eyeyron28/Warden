import { useEffect, useId, useRef, useState } from 'react';

import { MAX_DEMO_CHARS, createDemoKey, decryptDemo, demoSizes, demoSupported, encryptDemo } from '../../utils/encryptionDemo.js';
import styles from './EncryptionDemo.module.css';

const START_TEXT = 'Land title, scan 2 of 3';

function EncryptionDemo() {
  const inputId = useId();
  const [text, setText] = useState(START_TEXT);
  const [sealed, setSealed] = useState(null);
  const [shown, setShown] = useState(false);
  const [opened, setOpened] = useState('');
  const [state, setState] = useState(() => (demoSupported() ? 'ready' : 'unsupported'));
  const keyRef = useRef(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (state === 'unsupported') return undefined;
    const run = ++runRef.current;
    (async () => {
      try {
        keyRef.current ||= await createDemoKey();
        const result = await encryptDemo(keyRef.current, text);
        if (run !== runRef.current) return;
        setSealed(result);
        setOpened(await decryptDemo(keyRef.current, result));
      } catch {
        if (run === runRef.current) setState('unsupported');
      }
    })();
    return undefined;
  }, [text, state]);

  if (state === 'unsupported') {
    return (
      <section className={styles.panel} aria-labelledby={`${inputId}-title`}>
        <h2 id={`${inputId}-title`} className={styles.title}>See what the server stores</h2>
        <p className={styles.note}>
          This demo needs the browser&apos;s Web Crypto feature, which is not available here (it needs https or localhost).
        </p>
      </section>
    );
  }

  const bytesIn = sealed ? sealed.plainBytes : 0;
  const bytesOut = sealed ? sealed.cipherHex.length / 2 : 0;

  return (
    <section className={styles.panel} aria-labelledby={`${inputId}-title`}>
      <div className={styles.head}>
        <h2 id={`${inputId}-title`} className={styles.title}>See what the server stores</h2>
        <span className={styles.badge}>Demo: runs only in this tab</span>
      </div>

      <label htmlFor={inputId} className={styles.label}>
        1. Type something
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="text"
        value={text}
        maxLength={MAX_DEMO_CHARS}
        autoComplete="off"
        spellCheck="false"
        onChange={(event) => setText(event.target.value)}
      />

      <div className={styles.rows}>
        <div className={styles.row}>
          <p className={styles.label}>2. Encrypted in this tab with AES-256-GCM</p>
          <p className={styles.hex} data-testid="demo-cipher">
            {sealed ? sealed.cipherHex : '…'}
          </p>
          <p className={styles.meta}>
            {bytesIn} bytes of text became {bytesOut} bytes: the text plus a {demoSizes.TAG_BYTES}-byte tag that makes any change detectable. A
            new random {demoSizes.IV_BYTES}-byte IV is used each time, so the same words never give the same bytes twice.
          </p>
        </div>

        <div className={styles.row}>
          <p className={styles.label}>3. What someone with a copy of the database sees</p>
          <p className={styles.hex} data-testid="demo-db">
            {sealed ? `${sealed.ivHex}${sealed.cipherHex}` : '…'}
          </p>
          <p className={styles.meta}>No readable text. Without the key, this is all there is.</p>
        </div>
      </div>

      <div className={styles.decrypt}>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? 'Hide the decrypted text' : 'Decrypt with the key'}
        </button>
        <p className={styles.result} aria-live="polite" data-testid="demo-plain">
          {shown ? (opened === '' ? '(nothing typed)' : opened) : 'The key is held in this tab only.'}
        </p>
      </div>

      <p className={styles.fine}>
        This only shows what AES-256-GCM does. The key here is random, lives in this tab&apos;s memory, is never sent anywhere and is
        gone when you leave. Warden itself encrypts your files on its server, so it is not end-to-end encrypted.
      </p>
    </section>
  );
}

export default EncryptionDemo;
