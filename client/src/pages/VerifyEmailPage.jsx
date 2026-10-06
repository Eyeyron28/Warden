import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import { verifyEmailToken } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './PairPage.module.css';

/**
 * /verify-email?token=... - the link POST /api/auth/signup emails out.
 * Lives entirely outside the login/signup flow, same spirit as PairPage:
 * whoever opens this has no session and the token in the URL is the only
 * credential, consumed exactly once (a second open of the same link fails
 * the same way an unknown one would).
 */
function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState('verifying'); // verifying | success | error
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setStatus('error');
      setError('This verification link is missing its token.');
      return undefined;
    }

    verifyEmailToken(token)
      .then(() => {
        if (!cancelled) setStatus('success');
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus('error');
          setError(extractErrorMessage(err, 'This verification link is invalid or has expired.'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Warden</span>
      </header>

      <main className={styles.content}>
        {status === 'verifying' && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>Verifying your email...</h1>
            </div>
          </div>
        )}

        {status === 'success' && (
          <div className={styles.successState}>
            <CheckCircle size={40} weight="fill" className={styles.successIcon} />
            <h1 className={styles.successTitle}>Email verified</h1>
            <p className={styles.successBody}>You can now log in to your account.</p>
            <Link to="/" className={styles.submitButton}>
              Go to log in
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This link didn't work</h1>
            <p className={styles.invalidBody}>{error}</p>
            <Link to="/" className={styles.submitButton}>
              Back to log in
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

export default VerifyEmailPage;
