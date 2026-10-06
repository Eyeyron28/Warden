import { Link } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import Reveal from '../../components/site/Reveal.jsx';
import VaultMock from '../../components/site/VaultMock.jsx';
import StepExplorer from '../../components/site/StepExplorer.jsx';
import Faq from '../../components/site/Faq.jsx';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import { MAX_FILE_SIZE_MB } from '../../config.js';
import site from '../../components/site/site.module.css';
import styles from './HomePage.module.css';

// Copy rule for this page: every claim has to match what the code
// actually does (see server/utils/crypto.js, controllers/auth.controller.js
// and controllers/documents.controller.js). In particular, uploads and
// downloads are encrypted/decrypted by the server in memory during a
// signed-in session - so this page says "a copy of the database opens
// nothing", never "the server can't read your files".

const COMPARISON = [
  {
    question: 'Who can read your stored files?',
    drive: 'The provider can - it manages the encryption keys.',
    warden: 'Nobody, from the stored data alone. Opening it takes your password or recovery key.',
  },
  {
    question: 'What sits in the database?',
    drive: 'Your files, encrypted with keys the provider holds.',
    warden: 'Encrypted files and two locked copies of your vault key. File and folder names are plain text.',
  },
  {
    question: 'If the database leaks',
    drive: 'Depends on how the provider guards its keys.',
    warden: 'Ciphertext and locked keys. Useless without your password or recovery key.',
  },
  {
    question: 'If you forget your password',
    drive: 'Reset by email; your files are untouched.',
    warden: 'Use your recovery key or paired phone and nothing is lost. Lose both, and an email reset starts you on a new, empty vault.',
  },
];

const RECOVERY = [
  {
    icon: 'key',
    title: 'Recovery key',
    body: 'Sixteen characters shown once, when you sign up. It unlocks your vault so you can set a new password.',
  },
  {
    icon: 'phone',
    title: 'Paired phone',
    body: 'A phone you paired keeps its own locked copy of the vault key. Approve the reset from it with its PIN.',
  },
  {
    icon: 'mail',
    title: 'Email reset, last resort',
    body: 'Proves the inbox is yours, not the vault. You get a new, empty vault; the old files stay unreadable.',
  },
];

const FAQ_ITEMS = [
  {
    question: 'What if I forget my password?',
    answer: (
      <>
        <p>
          Request a reset link, then enter your recovery key on the reset page, or approve the reset from your
          paired phone. Either way your documents stay exactly as they were.
        </p>
        <p>
          Without the recovery key or a paired phone, the reset link can still get you back into your account,
          but only with a new, empty vault. Nobody, including us, can decrypt the old one.
        </p>
      </>
    ),
  },
  {
    question: 'Can Warden staff read my files?',
    answer: (
      <>
        <p>
          Not from what&apos;s stored. Files sit in the database encrypted, and the key that opens them is only
          ever stored locked by your password or recovery key.
        </p>
        <p>
          To be precise about the limits: while you&apos;re signed in, the server encrypts uploads and decrypts
          downloads in memory, so you&apos;re trusting the code that runs it, as with any web app. File and
          folder names are stored as plain text.
        </p>
      </>
    ),
  },
  {
    question: 'What file sizes are supported?',
    answer: (
      <p>
        Up to {MAX_FILE_SIZE_MB} MB per file. Warden is built for scans, PDFs and photos of documents, not video
        or large archives.
      </p>
    ),
  },
  {
    question: 'Is it free?',
    answer: (
      <p>
        Yes. Warden is a student capstone project with no paid plans. It&apos;s provided as-is, so keep your own
        copies of anything you can&apos;t afford to lose.
      </p>
    ),
  },
  {
    question: 'Where is my data stored?',
    answer: (
      <p>
        In a MongoDB Atlas database. What&apos;s stored is your email, a password hash, your encrypted files, the
        locked copies of your vault key, and basic file details such as names, folders and dates.
      </p>
    ),
  },
];

function HomePage() {
  usePageMeta(
    null,
    'Warden keeps your IDs, contracts and records encrypted with a key only your password or recovery key can unlock.'
  );
  const signedIn = Boolean(useSessionToken());

  const primaryCta = signedIn ? (
    <Link to="/vault" className={`${site.button} ${site.primary}`}>
      Go to your vault
      <Icon name="arrowRight" size={18} />
    </Link>
  ) : (
    <Link to="/signup" className={`${site.button} ${site.primary}`}>
      Create your vault
      <Icon name="arrowRight" size={18} />
    </Link>
  );

  return (
    <>
      {/* ---- Hero ---- */}
      <section className={styles.hero}>
        <div className={`${site.container} ${styles.heroGrid}`}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Encrypted document vault</p>
            <h1 className={styles.heroTitle}>
              A vault for the documents you can&apos;t afford to lose, or leak.
            </h1>
            <p className={styles.heroLede}>
              Warden encrypts your IDs, contracts and records with a key that only your password or recovery key
              can unlock. The database keeps ciphertext; a stolen copy of it opens nothing.
            </p>
            <div className={styles.heroActions}>
              {primaryCta}
              <a href="#how-it-works" className={`${site.button} ${site.ghost}`}>
                See how it works
                <Icon name="arrowDown" size={18} />
              </a>
            </div>
            <ul className={styles.heroFacts}>
              <li>AES-256-GCM per file</li>
              <li>Recovery key shown once</li>
              <li>Free, student-built</li>
            </ul>
          </div>
          <div className={styles.heroVisual}>
            <VaultMock />
          </div>
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section id="how-it-works" className={`${site.section} ${site.sectionRule}`} aria-labelledby="how-title">
        <div className={site.container}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>01</span> How it works
            </p>
            <h2 id="how-title" className={site.sectionTitle}>
              Four steps between your file and the database.
            </h2>
            <p className={site.lede}>
              Pick a step to see what happens to the keys. Nothing here is a metaphor; it&apos;s what the code
              does.
            </p>
          </Reveal>
          <Reveal>
            <StepExplorer />
          </Reveal>
        </div>
      </section>

      {/* ---- Comparison ---- */}
      <section className={`${site.section} ${site.sectionRule}`} aria-labelledby="diff-title">
        <div className={`${site.container} ${styles.splitHeading}`}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>02</span> What&apos;s different
            </p>
            <h2 id="diff-title" className={site.sectionTitle}>
              Warden next to a typical cloud drive.
            </h2>
          </Reveal>
          <Reveal className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={site.srOnly}>Warden compared with a typical cloud drive</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className={site.srOnly}>Question</span>
                  </th>
                  <th scope="col">Typical cloud drive</th>
                  <th scope="col" className={styles.wardenCol}>
                    Warden
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.question}>
                    <th scope="row">{row.question}</th>
                    <td data-label="Typical cloud drive">{row.drive}</td>
                    <td data-label="Warden" className={styles.wardenCol}>
                      {row.warden}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.footnote}>
              To be exact: while you&apos;re signed in, the server encrypts uploads and decrypts downloads in memory
              for your session. The guarantee above is about what&apos;s stored.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---- Ways back in ---- */}
      <section className={`${site.section} ${site.sectionRule}`} aria-labelledby="recovery-title">
        <div className={site.container}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>03</span> Ways to get back in
            </p>
            <h2 id="recovery-title" className={site.sectionTitle}>
              Forgetting your password doesn&apos;t have to cost you your files.
            </h2>
          </Reveal>
          <Reveal as="ol" className={styles.recoveryList}>
            {RECOVERY.map((item) => (
              <li key={item.title} className={styles.recoveryItem}>
                <Icon name={item.icon} size={22} className={styles.recoveryIcon} />
                <h3 className={styles.recoveryTitle}>{item.title}</h3>
                <p className={styles.recoveryBody}>{item.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ---- FAQ ---- */}
      <section className={`${site.section} ${site.sectionRule}`} aria-labelledby="faq-title">
        <div className={`${site.container} ${styles.faqGrid}`}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>04</span> Questions
            </p>
            <h2 id="faq-title" className={site.sectionTitle}>
              Straight answers.
            </h2>
            <p className={site.lede}>
              Something missing?{' '}
              <Link to="/contact" className={site.textLink}>
                Ask us
              </Link>
              .
            </p>
          </Reveal>
          <Reveal>
            <Faq items={FAQ_ITEMS} />
          </Reveal>
        </div>
      </section>

      {/* ---- Closing CTA ---- */}
      <section className={styles.ctaBand} aria-labelledby="cta-title">
        <div className={`${site.container} ${styles.ctaInner}`}>
          <h2 id="cta-title" className={styles.ctaTitle}>
            Set up your vault in about a minute.
          </h2>
          <div className={styles.ctaActions}>
            {primaryCta}
            {!signedIn && (
              <Link to="/login" className={site.textLink}>
                I already have one
              </Link>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

export default HomePage;
