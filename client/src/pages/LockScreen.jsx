import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from '@phosphor-icons/react';

import VaultDial from '../components/VaultDial.jsx';
import PasswordField from '../components/PasswordField.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import styles from './LockScreen.module.css';

const UNLOCK_ANIMATION_MS = 900;

function LockScreen() {
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState('idle'); // idle | unlocking | unlocked | error
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const timeoutRef = useRef(null);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const handleSubmit = (event) => {
    event.preventDefault();

    if (status === 'unlocking') return;

    if (!passphrase.trim()) {
      setError('Enter your vault passphrase.');
      setStatus('error');
      timeoutRef.current = setTimeout(() => setStatus('idle'), 500);
      return;
    }

    // Placeholder unlock flow: no real authentication is wired up yet.
    setError('');
    setStatus('unlocking');
    timeoutRef.current = setTimeout(() => {
      setStatus('unlocked');
      timeoutRef.current = setTimeout(() => navigate('/vault'), 350);
    }, UNLOCK_ANIMATION_MS);
  };

  return (
    <main className={styles.screen}>
      <div className={styles.grid} aria-hidden="true" />

      <div className={styles.panel}>
        <div className={styles.brandRow}>
          <span className={styles.mark}>W</span>
          <span className={styles.wordmark}>WARDEN</span>
        </div>

        <VaultDial status={status} />

        <div className={styles.copy}>
          <h1 className={styles.title}>Your vault is sealed.</h1>
          <p className={styles.subtitle}>
            Enter your passphrase to decrypt and open this local vault.
          </p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <PasswordField
            label="Vault passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter passphrase"
            error={error}
            autoFocus
          />

          <button
            type="submit"
            className={styles.unlockButton}
            disabled={status === 'unlocking'}
          >
            <span>{status === 'unlocking' ? 'Unlocking' : 'Unlock vault'}</span>
            <ArrowRight size={18} weight="bold" />
          </button>
        </form>

        <div className={styles.footerBadges}>
          <StatusBadge label="AES-256" />
          <StatusBadge label="Local instance, no cloud sync" />
        </div>
      </div>
    </main>
  );
}

export default LockScreen;
