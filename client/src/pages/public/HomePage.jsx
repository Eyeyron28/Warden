import { Suspense, lazy } from 'react';
import { Link, useLocation } from 'react-router-dom';

import EncryptionDemo from '../../components/site/EncryptionDemo.jsx';
import Icon from '../../components/site/Icon.jsx';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import { useSignupConfig } from '../../utils/publicConfig.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './HomePage.module.css';

const HomeBelow = lazy(() => import('./HomeBelow.jsx'));

const FACTS = [
  { big: 'AES-256-GCM', small: 'for every file' },
  { big: 'scrypt', small: 'for your password' },
  { big: '6-digit code', small: 'emailed at login' },
  { big: '30 minutes', small: 'idle timeout, 12 hours at most' },
  { big: '30 days', small: 'in Trash before removal' },
  { big: 'Recovery key', small: 'shown once' },
];

function HomePage() {
  usePageMeta(
    null,
    'Warden stores your IDs, contracts and records encrypted, with the key locked by your password and recovery key. File names and sizes are visible to the server, and it is not end-to-end encrypted. A student project, provided as-is.'
  );
  const signedIn = Boolean(useSessionToken());
  const { status: configStatus, config } = useSignupConfig();
  const inviteOnly = !signedIn && configStatus === 'ready' && config?.signupMode === 'invite';
  const accountDeleted = Boolean(useLocation().state?.accountDeleted);

  const primaryCta = signedIn ? (
    <Link to="/files" className={`${site.button} ${site.primary}`}>
      Go to your vault
      <Icon name="arrowRight" size={18} />
    </Link>
  ) : (
    <Link to="/signup" className={`${site.button} ${site.primary}`}>
      Create your vault
      <Icon name="arrowRight" size={18} />
    </Link>
  );

  const bottomCta = (
    <>
      {primaryCta}
      {!signedIn && (
        <Link to="/login" className={`${site.textLink} ${site.tapLink}`}>
          I already have one
        </Link>
      )}
    </>
  );

  return (
    <>
      {accountDeleted && (
        <div className={styles.wrap} style={{ paddingTop: 16 }}>
          <div className={forms.notice} role="status">
            <Icon name="check" />
            <p>
              <strong>Your account has been deleted.</strong> Your documents and account data were permanently removed from Warden,
              and we emailed you a confirmation.
            </p>
          </div>
        </div>
      )}

      <section className={styles.hero} aria-labelledby="home-title">
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Encrypted document vault</p>
            <h1 id="home-title" className={styles.heroTitle}>
              A vault for the <span>documents</span> you can&apos;t afford to lose, or leak.
            </h1>
            <p className={styles.heroLede}>
              Your files are stored as ciphertext, and the key is locked by your password and your recovery key. The server can still see
              file names and sizes, and it is not end-to-end encrypted. The limits are listed below.
            </p>
            <div className={styles.heroActions}>
              {primaryCta}
              <Link to="/#how-it-works" className={`${site.button} ${site.ghost}`}>
                See how it works
                <Icon name="arrowDown" size={18} />
              </Link>
            </div>
            {inviteOnly && (
              <p className={styles.inviteNote}>
                <strong>Access is by invitation.</strong>{' '}
                {config.requestAccessText || 'Ask the person who runs this Warden for an invite code.'}
              </p>
            )}
            <p className={styles.free}>Free, student-built. A class project, not audited by a third party.</p>
          </div>
          <div className={styles.heroDemo}>
            <EncryptionDemo />
          </div>
        </div>
      </section>

      <section className={styles.factsBand} aria-label="Facts">
        <ul className={`${styles.wrap} ${styles.facts}`}>
          {FACTS.map((fact) => (
            <li key={fact.big} className={styles.fact}>
              <span className={styles.factBig}>{fact.big}</span>
              <span className={styles.factSmall}>{fact.small}</span>
            </li>
          ))}
        </ul>
      </section>

      <Suspense fallback={<div className={styles.placeholder} aria-hidden="true" />}>
        <HomeBelow cta={bottomCta} />
      </Suspense>
    </>
  );
}

export default HomePage;
