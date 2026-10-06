import { useRef, useState } from 'react';

import styles from './StepExplorer.module.css';

const STEPS = [
  {
    title: 'You choose a password',
    body:
      'Warden never stores it. It keeps a slow, salted scrypt hash to check it at login, and separately derives a key from it that is only ever used to lock your vault key. Your password reaches the server over HTTPS when you sign up or log in, and the server does this work.',
    diagram: 'Your password, turned into a key-locking key with scrypt.',
    highlight: ['password'],
  },
  {
    title: 'Warden makes a random vault key',
    body:
      '256 random bits, generated on the server when you sign up. Files reach the server over HTTPS, and it encrypts each one, and its preview image, with this key using AES-256-GCM, which also detects tampering.',
    diagram: 'A random 256-bit vault key that encrypts every file.',
    highlight: ['vault'],
  },
  {
    title: 'That key is locked twice',
    body:
      'One copy is locked with your password, another with a recovery key we show you exactly once. Either one can unlock the vault, so forgetting your password is not the end.',
    diagram: 'The vault key, locked once by your password and once by your recovery key.',
    highlight: ['password', 'recovery', 'vault', 'wrapPassword', 'wrapRecovery'],
  },
  {
    title: 'The database keeps only locked things',
    body:
      'Encrypted files and previews, and the two locked copies of the vault key. A copy of the database alone cannot decrypt them without your password or recovery key. While you are signed in, the server unlocks the key for each request to do the encrypting and decrypting, so this is not end-to-end encryption.',
    diagram: 'The database holds encrypted files and the two locked copies of the key.',
    highlight: ['database', 'store'],
  },
];

/**
 * "How it works": four steps as a vertical tab list with a diagram that
 * follows along. Standard ARIA tabs: arrow keys (either axis), Home and
 * End move between steps, with roving tabindex so Tab leaves the list.
 */
function StepExplorer() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef([]);
  const step = STEPS[active];
  const lit = (part) => (step.highlight.includes(part) ? styles.lit : '');

  const select = (index) => {
    const next = (index + STEPS.length) % STEPS.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const onKeyDown = (event) => {
    const keys = {
      ArrowDown: active + 1,
      ArrowRight: active + 1,
      ArrowUp: active - 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: STEPS.length - 1,
    };
    if (event.key in keys) {
      event.preventDefault();
      select(keys[event.key]);
    }
  };

  return (
    <div className={styles.explorer}>
      <div role="tablist" aria-label="How Warden protects a file" aria-orientation="vertical" className={styles.tabs}>
        {STEPS.map((item, index) => (
          <button
            key={item.title}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`step-tab-${index}`}
            aria-selected={index === active}
            aria-controls="step-panel"
            tabIndex={index === active ? 0 : -1}
            className={styles.tab}
            onClick={() => setActive(index)}
            onKeyDown={onKeyDown}
          >
            <span className={styles.tabNumber}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.tabTitle}>{item.title}</span>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="step-panel"
        aria-labelledby={`step-tab-${active}`}
        className={styles.panel}
        tabIndex={0}
      >
        <svg
          className={styles.diagram}
          viewBox="0 0 560 300"
          role="img"
          aria-label={`Diagram: ${step.diagram}`}
        >
          {/* edges */}
          <path className={`${styles.edge} ${lit('wrapPassword')}`} d="M150 78 C 205 78, 205 150, 238 150" />
          <path className={`${styles.edge} ${lit('wrapRecovery')}`} d="M150 222 C 205 222, 205 150, 238 150" />
          <path className={`${styles.edge} ${lit('store')}`} d="M352 150 L 398 150" />
          <text className={`${styles.edgeLabel} ${lit('wrapPassword')}`} x="168" y="98">
            locks
          </text>
          <text className={`${styles.edgeLabel} ${lit('wrapRecovery')}`} x="168" y="212">
            locks
          </text>

          {/* nodes */}
          <g className={`${styles.node} ${lit('password')}`}>
            <rect x="20" y="52" width="130" height="52" rx="10" />
            <text x="85" y="76" textAnchor="middle" className={styles.nodeTitle}>
              Password
            </text>
            <text x="85" y="93" textAnchor="middle" className={styles.nodeSub}>
              only you know it
            </text>
          </g>
          <g className={`${styles.node} ${lit('recovery')}`}>
            <rect x="20" y="196" width="130" height="52" rx="10" />
            <text x="85" y="220" textAnchor="middle" className={styles.nodeTitle}>
              Recovery key
            </text>
            <text x="85" y="237" textAnchor="middle" className={styles.nodeSub}>
              shown once
            </text>
          </g>
          <g className={`${styles.node} ${lit('vault')}`}>
            <rect x="238" y="118" width="114" height="64" rx="10" />
            <text x="295" y="146" textAnchor="middle" className={styles.nodeTitle}>
              Vault key
            </text>
            <text x="295" y="164" textAnchor="middle" className={styles.nodeSub}>
              256 random bits
            </text>
          </g>
          <g className={`${styles.node} ${lit('database')}`}>
            <rect x="398" y="60" width="142" height="180" rx="12" />
            <text x="469" y="86" textAnchor="middle" className={styles.nodeTitle}>
              Database
            </text>
            <rect className={styles.slot} x="414" y="104" width="110" height="34" rx="6" />
            <text x="469" y="125" textAnchor="middle" className={styles.slotText}>
              locked key ×2
            </text>
            <rect className={styles.slot} x="414" y="148" width="110" height="34" rx="6" />
            <text x="469" y="169" textAnchor="middle" className={styles.slotText}>
              encrypted files
            </text>
            <text x="469" y="214" textAnchor="middle" className={styles.nodeSub}>
              no readable copy
            </text>
          </g>
        </svg>

        <div className={styles.caption} aria-live="polite">
          <p className={styles.captionStep}>
            Step {active + 1} of {STEPS.length}
          </p>
          <h3 className={styles.captionTitle}>{step.title}</h3>
          <p className={styles.captionBody}>{step.body}</p>
        </div>
      </div>
    </div>
  );
}

export default StepExplorer;
