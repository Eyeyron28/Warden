import { useId, useState } from 'react';

import styles from './ProtectionCompare.module.css';

const VIEWS = [
  {
    id: 'database',
    label: 'Someone with a copy of the database',
    can: [
      'Your email address, file and folder names, file types, sizes and dates.',
      'Share records: expiry, download counts and any recipient email you entered.',
      'A salted scrypt hash of your password, which they can try to guess against offline.',
    ],
    cannot: [
      'File contents or previews: they are stored as AES-256-GCM ciphertext.',
      'Your vault key: it is stored only as two locked copies (one by your password, one by your recovery key).',
      'Your password. Only a hash is kept.',
    ],
    note: 'If you set up Emergency Access, a copy of the database together with the printed kit can open the vault.',
  },
  {
    id: 'link',
    label: 'A person with your share link',
    can: [
      'The files in that one share, decrypted in their own browser, until it expires (30 days at most), reaches its download limit or you stop it.',
      'Only after any password, emailed code or download limit you set on the link.',
    ],
    cannot: [
      'Any other file in your vault, your account, or your activity log.',
      'The link again once you stop sharing: the server deletes the encrypted copies.',
    ],
    note: 'The link is a secret. Anyone who has the whole link and passes the gates you chose can open it.',
  },
  {
    id: 'stranger',
    label: 'A stranger on the internet',
    can: [
      'The public pages, the sign-up page and the login page.',
      'Nothing about whether an email address has an account: the answers look the same.',
    ],
    cannot: [
      'Any file. Login needs the password and an emailed 6-digit code.',
      'Unlimited guesses: 3 wrong passwords lock that login for 5 minutes, and a code allows 5 tries.',
    ],
    note: 'Strangers can still try to phish you or guess a weak password, which is why the password rules and the emailed code exist.',
  },
];

function ProtectionCompare() {
  const name = useId();
  const [picked, setPicked] = useState(VIEWS[0].id);
  const view = VIEWS.find((item) => item.id === picked);

  return (
    <div className={styles.wrap}>
      <fieldset className={styles.switch}>
        <legend className={styles.legend}>Look at it as</legend>
        <div className={styles.options}>
          {VIEWS.map((item) => (
            <label key={item.id} className={styles.option}>
              <input
                type="radio"
                name={name}
                value={item.id}
                checked={picked === item.id}
                onChange={() => setPicked(item.id)}
                className={styles.radio}
              />
              <span className={styles.optionText}>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.columns} aria-live="polite">
        <div className={styles.col}>
          <h3 className={`${styles.head} ${styles.headCan}`}>Can see</h3>
          <ul className={styles.list}>
            {view.can.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className={styles.col}>
          <h3 className={styles.head}>Cannot see</h3>
          <ul className={styles.list}>
            {view.cannot.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className={styles.note}>{view.note}</p>
    </div>
  );
}

export default ProtectionCompare;
