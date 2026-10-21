import { useId, useRef, useState } from 'react';

import styles from './HowItWorks.module.css';

const TABS = [
  {
    id: 'signup',
    label: 'Sign up',
    title: 'No account exists until you enter the emailed code.',
    body: 'You give an email address and a password and agree to the terms. We email a 6-digit code. Once you enter it, the server makes a random 256-bit vault key and locks it twice: once with a key derived from your password (scrypt), and once with a recovery key that is shown to you one time.',
    flow: [
      { name: 'Password', note: 'only a salted scrypt hash is kept' },
      { name: 'Vault key', note: '256 random bits, made on the server' },
      { name: 'Locked copy 1', note: 'locked by your password' },
      { name: 'Locked copy 2', note: 'locked by the recovery key' },
    ],
  },
  {
    id: 'upload',
    label: 'Upload',
    title: 'The server encrypts the file, then stores the ciphertext.',
    body: 'Your file travels to the server over HTTPS (up to 4 MB). The server encrypts it with your vault key using AES-256-GCM, which also detects tampering. File names, folder names, types and sizes stay readable in the database so the vault can list and sort them.',
    flow: [
      { name: 'Your browser', note: 'sends the file over HTTPS' },
      { name: 'Server', note: 'encrypts with AES-256-GCM' },
      { name: 'Database', note: 'ciphertext, plus readable name and size' },
    ],
  },
  {
    id: 'share',
    label: 'Share',
    title: 'The key for a share link sits after the #.',
    body: "A share is a copy of the files encrypted under a fresh key. The key is generated when you create the link and placed after the # in the address, so it isn't sent to our server when someone opens the link. The server does handle the key while it creates the link, and does not store it. You can add a password, an expiry of up to 30 days, a download limit, or an email-code check.",
    flow: [
      { name: 'You', note: 'create the link' },
      { name: 'Link', note: 'address + #key' },
      { name: "Recipient's browser", note: 'fetches the copy and decrypts it' },
    ],
  },
  {
    id: 'emergency',
    label: 'Emergency',
    title: 'A trusted contact can ask. You get time to say no.',
    body: 'Optional. You name one contact, a waiting period (3, 7 or 14 days) and what they may see. They get a kit, which is half of a key. If they ask for access, we email you when the request is made, and the request is refused if that email cannot be sent. You can deny it until the wait ends. After that they get a read-only session of at most 4 hours, and everything they open is in your activity log.',
    flow: [
      { name: 'Contact asks', note: 'kit plus an emailed code' },
      { name: 'Waiting period', note: 'you are emailed and can deny' },
      { name: 'Read-only session', note: 'up to 4 hours, logged' },
    ],
  },
];

function HowItWorks() {
  const base = useId();
  const [active, setActive] = useState(0);
  const refs = useRef([]);
  const tab = TABS[active];

  const select = (index) => {
    const next = (index + TABS.length) % TABS.length;
    setActive(next);
    refs.current[next]?.focus();
  };
  const onKeyDown = (event) => {
    const moves = { ArrowRight: active + 1, ArrowDown: active + 1, ArrowLeft: active - 1, ArrowUp: active - 1, Home: 0, End: TABS.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      select(moves[event.key]);
    }
  };

  return (
    <div className={styles.wrap}>
      <div role="tablist" aria-label="How Warden works" className={styles.tabs}>
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${item.id}`}
            aria-selected={index === active}
            aria-controls={`${base}-panel`}
            tabIndex={index === active ? 0 : -1}
            className={styles.tab}
            onClick={() => setActive(index)}
            onKeyDown={onKeyDown}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab.id}`} className={styles.panel} tabIndex={0}>
        <div className={styles.text}>
          <h3 className={styles.title}>{tab.title}</h3>
          <p className={styles.body}>{tab.body}</p>
        </div>
        <ol className={styles.flow} aria-label={`${tab.label}: the steps`}>
          {tab.flow.map((node) => (
            <li key={node.name} className={styles.node}>
              <span className={styles.nodeName}>{node.name}</span>
              <span className={styles.nodeNote}>{node.note}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default HowItWorks;
