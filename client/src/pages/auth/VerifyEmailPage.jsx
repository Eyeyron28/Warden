import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import { verifyEmailToken } from '../../services/authService.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import ResendButton from './ResendButton.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

// Verification links are single-use. React's StrictMode runs effects
// twice in development, which would send the token twice and report the
// (already-consumed) second attempt as a failure - so each token's
// request is made once and shared.
const verifications = new Map();
function verifyOnce(token) {
  if (!verifications.has(token)) verifications.set(token, verifyEmailToken(token));
  return verifications.get(token);
}

function VerifyEmailPage() {
  usePageMeta('Verify your email', 'Confirm your email address to finish setting up your Warden vault.');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [status, setStatus] = useState(token ? 'verifying' : 'invalid'); // verifying | verified | invalid
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    verifyOnce(token)
      .then(() => !cancelled && setStatus('verified'))
      .catch(() => !cancelled && setStatus('invalid'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === 'verifying') {
    return (
      <AuthLayout title="Verifying your email…">
        <p className={styles.subtitle} role="status" aria-live="polite" style={{ marginTop: 0 }}>
          This only takes a moment.
        </p>
      </AuthLayout>
    );
  }

  if (status === 'verified') {
    return (
      <AuthLayout title="Email verified" dial="unlocked">
        <div className={styles.stack} role="status">
          <p className={styles.subtitle} style={{ marginTop: 0 }}>
            Your vault is ready. Log in with your email and password to start adding documents.
          </p>
          <Link to="/login" className={`${site.button} ${site.primary} ${site.block}`}>
            Log in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="This link didn't work">
      <div className={styles.stack}>
        <div className={forms.alert} role="alert">
          <Icon name="alert" />
          <p>
            {token
              ? 'This verification link has expired or has already been used.'
              : 'This link is missing its verification code.'}{' '}
            Enter your email to get a new one.
          </p>
        </div>
        <div className={forms.field}>
          <label htmlFor="verify-email" className={forms.label}>
            Email
          </label>
          <input
            id="verify-email"
            type="email"
            className={forms.input}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
          />
        </div>
        <ResendButton email={email.trim()} variant="primary" />
        <p className={forms.hint}>
          Already verified?{' '}
          <Link to="/login" className={site.textLink}>
            Log in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}

export default VerifyEmailPage;
