import { useEffect } from 'react';
import { Link } from 'react-router-dom';

import { startTypewriter } from '../../components/site/typeWord.js';
import '../../components/site/typeWord.css';

import Faq from '../../components/site/Faq.jsx';
import HowItWorks from '../../components/site/HowItWorks.jsx';
import ProtectionCompare from '../../components/site/ProtectionCompare.jsx';
import Reveal from '../../components/site/Reveal.jsx';
import { FAQ_ITEMS } from './homeFaq.jsx';
import { LIMITS } from './limits.js';
import ContactSection from './ContactSection.jsx';
import site from '../../components/site/site.module.css';
import styles from './HomeBelow.module.css';

const FEATURES = [
  { tag: 'Files', title: 'Encrypted storage', body: 'Each file and its preview image is AES-256-GCM ciphertext in the database. A changed byte makes it refuse to decrypt.' },
  { tag: 'Files', title: 'Folders and previews', body: 'Nested folders, rename and move, and previews for common file types. The server decrypts a preview for you over HTTPS.' },
  { tag: 'Files', title: 'Trash for 30 days', body: 'Deleted files wait in Trash, still encrypted, then are removed with their previews. Restore, delete for good or empty it earlier.' },
  { tag: 'Files', title: 'Expiry reminders', body: 'Give a file an expiry date. We email one count (never a file name) at 60, 30 and 7 days and on the day. You can turn it off.' },
  { tag: 'Sharing', title: 'Share links with limits', body: 'A password, an expiry of up to 30 days, a download limit, or one email address that must enter a code. An optional purpose shows as a faint watermark.' },
  { tag: 'Sharing', title: 'Emergency access', body: 'Name one trusted contact. They can ask for read-only access after a waiting period you choose, and you can deny it until the wait ends.' },
  { tag: 'Safety', title: 'Vault health score', body: 'A score out of 100 from nine checks, such as open share links, trusted browsers and expired documents. Each one links to where you fix it.' },
  { tag: 'Safety', title: 'Devices and activity', body: 'See every browser signed in and sign any out. A 30-day log shows what happened, and a check detects edits and gaps in it.' },
  { tag: 'Safety', title: 'Recovery key', body: 'Forget your password and keep your files, as long as you saved the recovery key. We cannot recover it for you.' },
  { tag: 'Yours', title: 'Export / Import', body: 'Download everything as one zip built in your browser, and import a zip back through the normal upload.' },
  { tag: 'Yours', title: 'Delete it all', body: 'Delete your account yourself. Your files, shares, devices and activity log are removed, and we email you a confirmation.' },
  { tag: 'Yours', title: 'No tracking', body: 'No analytics and no third-party scripts. The page loads only its own files and a strict Content-Security-Policy.' },
];

const SECTION_ATTRS = { className: `${site.sectionRule} ${styles.sec}` };

function Heading({ id, number, label, title, children }) {
  return (
    <header className={styles.head}>
      <p className={site.marker}>
        <span className={site.markerNumber}>{number}</span> {label}
      </p>
      <h2 id={id} className={styles.title}>{title}</h2>
      {children}
    </header>
  );
}

function HomeBelow() {
  useEffect(() => startTypewriter(document.querySelector('#home-title span'), site.srOnly), []);

  return (
    <>
      <section id="how-it-works" {...SECTION_ATTRS} aria-labelledby="how-title">
        <div className={styles.wrap}>
          <Reveal>
            <Heading id="how-title" number="01" label="How it works" title="Four things Warden does with your keys.">
              <p className={styles.lede}>
                Pick one. It is what the code does, not a metaphor.
              </p>
            </Heading>
          </Reveal>
          <Reveal>
            <HowItWorks />
          </Reveal>
        </div>
      </section>

      <section id="protected" {...SECTION_ATTRS} aria-labelledby="protected-title">
        <div className={`${styles.wrap} ${styles.split}`}>
          <Reveal>
            <Heading id="protected-title" number="02" label="Protected, and not" title="What each person can see.">
              <p className={styles.lede}>
                Warden is not end-to-end encrypted, so the answer is never &quot;nothing&quot;. Switch who is looking.
              </p>
            </Heading>
            <ProtectionCompare />
          </Reveal>
          <Reveal className={styles.limitsBox}>
            <h3 className={styles.limitsTitle}>What Warden does not protect against</h3>
            <ul className={styles.limitsList}>
              {LIMITS.map((item) => (
                <li key={item.title}>{item.title}</li>
              ))}
            </ul>
            <p className={styles.limitsMore}>
              <Link to="/#limits" className={`${site.textLink} ${site.tapLink}`}>
                Read the full list
              </Link>
            </p>
          </Reveal>
        </div>
      </section>

      <section id="features" {...SECTION_ATTRS} aria-labelledby="features-title">
        <div className={styles.wrap}>
          <Reveal>
            <Heading id="features-title" number="03" label="What is in it" title="Twelve things it does." />
          </Reveal>
          <Reveal as="ul" className={styles.features}>
            {FEATURES.map((item) => (
              <li key={item.title} className={styles.feature}>
                <span className={styles.featureTag}>{item.tag}</span>
                <h3 className={styles.featureTitle}>{item.title}</h3>
                <p className={styles.featureBody}>{item.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <section id="sharing" {...SECTION_ATTRS} aria-labelledby="sharing-title">
        <div className={styles.wrap}>
          <Reveal>
            <Heading id="sharing-title" number="04" label="Sharing and emergency access" title="Two ways someone else gets in." />
          </Reveal>
          <div className={styles.pair}>
            <Reveal className={styles.card}>
              <h3 className={styles.cardTitle}>A share link</h3>
              <ul className={styles.facts}>
                <li>You pick the files and how long it lasts, up to 30 days.</li>
                <li>Optional locks: a password, 1 to 100 downloads, or one email address that must enter a code.</li>
                <li>The key is the part of the address after the #, which browsers do not send to our server.</li>
                <li>One link holds up to 20 MB, you can have 20 active links, and you can stop any of them.</li>
              </ul>
            </Reveal>
            <Reveal className={styles.card}>
              <h3 className={styles.cardTitle}>Emergency access</h3>
              <ul className={styles.facts}>
                <li>Optional. One contact, a waiting period of 3, 7 or 14 days, and everything or chosen folders.</li>
                <li>They get a kit (half a key). A copy of our database alone cannot open your vault, and neither can a kit alone.</li>
                <li>We email you when they ask. You can deny until the wait ends. After a denial they cannot ask for 24 hours.</li>
                <li>
                  The session is read-only, lasts at most 4 hours and shows up in your activity log.{' '}
                  <Link to="/emergency" className={site.textLink}>
                    If you were named as someone&apos;s contact, start here.
                  </Link>
                </li>
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="faq" {...SECTION_ATTRS} aria-labelledby="faq-title">
        <div className={styles.wrap}>
          <Reveal>
            <Heading id="faq-title" number="05" label="Questions" title="Straight answers.">
              <p className={styles.lede}>
                Something missing?{' '}
                <Link to="/#contact" className={`${site.textLink} ${site.tapLink}`}>
                  Ask us
                </Link>
                .
              </p>
            </Heading>
          </Reveal>
          <Reveal>
            <Faq items={FAQ_ITEMS} columns />
          </Reveal>
        </div>
      </section>

      <ContactSection />
    </>
  );
}

export default HomeBelow;
