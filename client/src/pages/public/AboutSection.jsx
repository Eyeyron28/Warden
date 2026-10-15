import { Link } from 'react-router-dom';

import Reveal from '../../components/site/Reveal.jsx';
import { PROJECT, REPO_URL } from '../../config.js';
import { LIMITS } from './limits.js';
import site from '../../components/site/site.module.css';
import styles from './AboutSection.module.css';

const DESIGN_POINTS = [
  {
    title: 'One random key per vault',
    body: 'Each account gets its own 256-bit key at signup. Every file is encrypted with it using AES-256-GCM, which also refuses to decrypt a file that has been altered.',
  },
  {
    title: 'The key is never stored in the open',
    body: 'It is saved twice, each copy locked: once with a key derived from your password (scrypt), once with a key derived from your recovery key. Your password itself is never stored, only a salted hash used to check it.',
  },
  {
    title: 'Share links have their own key',
    body: 'A share is a copy encrypted under a fresh random key. The key is generated when you create the link and placed after the # in the address, so it isn’t sent to our server when someone opens the link; the server does handle it while it creates the link, and does not store it. You can add a password (your browser locks the key with it), a download limit, or an email-code check; those decide who the server will serve the encrypted copy to. They are checks on our server, not a different kind of encryption.',
  },
  {
    title: 'Logging in needs your password and an emailed code',
    body: 'After your password is checked, Warden emails a 6-digit code that expires after a few minutes, and you enter it to finish logging in. The code is stored only as a salted hash while it is valid, and the unlocked key is not held on the server in the meantime. If you tick "Trust this browser for 30 days" after a correct code, that browser keeps a random token in a cookie and later logins there skip the emailed code but still need your password. Deleting your account and restricting a share to an email address always ask for a fresh code. Remove trusted browsers any time from the Account page.',
  },
  {
    title: 'Deleted files wait in Trash for 30 days',
    body: 'Deleting a file or folder moves it to Trash. It stays encrypted there for 30 days, then it and its preview are permanently removed. You can restore it, delete it for good, or empty the Trash sooner, and any share links that included it stop working as soon as it is trashed.',
  },
  {
    title: 'Previews are decrypted for you on the server',
    body: 'To preview a file, the server decrypts it with your session and sends it to your browser over HTTPS, where it is displayed. This is not end-to-end encryption. Web pages and other markup are never shown inline, only downloaded.',
  },
  {
    title: 'Sessions hold the key only while you use it',
    body: 'When you log in, your unlocked key is locked again for your session with a random key that exists only in your session token. The token is kept in the tab’s sessionStorage, so reloading the page keeps you signed in, and closing the tab ends it. The server unlocks the key for each request. Logging out deletes the session. Signed in sessions end after 30 minutes without activity, and after 12 hours at most. Your password and the unlocked key are never stored in the browser.',
  },
  {
    title: 'Recovery is checked before anything changes',
    body: 'Forgot your password? An emailed 6-digit code starts the reset, and your recovery key is what keeps the vault: it is checked against your exact vault before any password or key is rewritten. Without the recovery key, the reset erases the vault and starts a new, empty one. The recovery key alone can also reset the password, with no email, under strict limits.',
  },
];

/**
 * The "About" part of the one-page landing site: who made it and why, the design in plain words, the limits, and the
 * project facts. Lives at /#about; the old /about route redirects there.
 */
function AboutSection({ cta = null }) {
  return (
    <section id="about" className={`${site.sectionRule} ${styles.about}`} aria-labelledby="about-title">
      <div className={styles.wrap}>
        <header className={styles.intro}>
          <div>
            <p className={site.marker}>
              <span className={site.markerNumber}>06</span> About this project
            </p>
            <h2 id="about-title" className={styles.title}>
              We built this for our COMSEC class, and we tried to be honest about it.
            </h2>
            <div className={styles.introText}>
              <p>
                We are {PROJECT.group}, {PROJECT.program} at {PROJECT.school}. Warden is our capstone for {PROJECT.course}, the computer
                security course.
              </p>
              <p>
                We picked a problem we had ourselves: IDs, birth certificates, land titles and tax records end up as phone photos or
                files in a general-purpose drive. Warden is our try at a vault for exactly those, with claims you can check against the
                code and a plain list of what it does not protect against.
              </p>
            </div>
            {cta && <div className={styles.cta}>{cta}</div>}
          </div>

          <dl className={styles.project} aria-label="Project facts">
            <div>
              <dt>School</dt>
              <dd>{PROJECT.school}</dd>
            </div>
            <div>
              <dt>Program</dt>
              <dd>{PROJECT.program}</dd>
            </div>
            <div>
              <dt>Course</dt>
              <dd>{PROJECT.course}</dd>
            </div>
            <div>
              <dt>Group</dt>
              <dd>{PROJECT.group}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>Class project. Not audited by a third party. Provided as-is.</dd>
            </div>
            <div>
              <dt>Source code</dt>
              <dd>
                <a href={REPO_URL} className={`${site.textLink} ${site.tapLink}`} rel="noopener noreferrer">
                  GitHub repository
                </a>
              </dd>
            </div>
            <div>
              <dt>Read next</dt>
              <dd>
                <Link to="/privacy" className={`${site.textLink} ${site.tapLink}`}>
                  Privacy
                </Link>
                {' · '}
                <Link to="/terms" className={`${site.textLink} ${site.tapLink}`}>
                  Terms
                </Link>
              </dd>
            </div>
          </dl>
        </header>

        <div className={styles.block}>
          <Reveal>
            <h3 id="design-title" className={styles.blockTitle}>
              The design, in plain words
            </h3>
          </Reveal>
          <Reveal as="ol" className={styles.designList}>
            {DESIGN_POINTS.map((point) => (
              <li key={point.title}>
                <h4>{point.title}</h4>
                <p>{point.body}</p>
              </li>
            ))}
          </Reveal>
        </div>

        <div id="limits" className={styles.block}>
          <Reveal>
            <h3 id="limits-title" className={styles.blockTitle}>
              What Warden does not protect against
            </h3>
            <p className={styles.blockNote}>Warden is not end-to-end encrypted, and some risks sit outside what encryption can do.</p>
          </Reveal>
          <Reveal as="ul" className={styles.designList}>
            {LIMITS.map((item) => (
              <li key={item.title}>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </div>
    </section>
  );
}

export default AboutSection;
