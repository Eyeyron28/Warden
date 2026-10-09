import { Link, useLocation } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import Reveal from '../../components/site/Reveal.jsx';
import VaultMock from '../../components/site/VaultMock.jsx';
import StepExplorer from '../../components/site/StepExplorer.jsx';
import Faq from '../../components/site/Faq.jsx';
import AboutSection from './AboutSection.jsx';
import ContactSection from './ContactSection.jsx';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import { useSignupConfig } from '../../utils/publicConfig.js';
import { MAX_FILE_SIZE_MB } from '../../config.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './HomePage.module.css';

// Copy rule for this page: every claim has to match what the code
// actually does (see server/utils/crypto.js, controllers/auth.controller.js
// and controllers/documents.controller.js). In particular, uploads and
// downloads are encrypted/decrypted by the server in memory during a
// signed-in session - so this page never says "the server can't read your
// files", "end-to-end" or "zero-knowledge", and it keeps the list of what
// Warden does not protect against (pages/public/limits.js) in view.

const COMPARISON = [
  {
    question: 'Who can read your stored files?',
    drive: 'The provider can - it manages the encryption keys.',
    warden: 'Not from the stored data alone: opening it takes your password or recovery key.',
  },
  {
    question: 'While you are signed in',
    drive: 'The provider can read what you open; it holds the keys.',
    warden: 'The Warden server unlocks your key for each request and decrypts files for you, so you are trusting it. This is not end-to-end encryption.',
  },
  {
    question: 'What sits in the database?',
    drive: 'Your files, encrypted with keys the provider holds.',
    warden: 'Encrypted files and previews, and two locked copies of your vault key. File and folder names are plain text.',
  },
  {
    question: 'If the database leaks',
    drive: 'Depends on how the provider guards its keys.',
    warden: 'Ciphertext and locked keys, useless without your password or recovery key.',
  },
  {
    question: 'If you forget your password',
    drive: 'Reset by email; your files are untouched.',
    warden: 'An emailed code starts the reset; your recovery key (or paired phone) keeps everything. Without the key, the reset erases the vault and starts a new, empty one.',
  },
];

const RECOVERY = [
  {
    icon: 'key',
    title: 'Recovery key',
    body: 'Sixteen characters shown once, when you sign up. After an emailed code, it unlocks your vault so you can set a new password and keep everything. It can also reset the password on its own, with no email.',
  },
  {
    icon: 'phone',
    title: 'Paired phone',
    body: 'A phone you paired keeps its own locked copy of the vault key. Approve the reset from it with its PIN.',
  },
  {
    icon: 'mail',
    title: 'Emailed code, no recovery key',
    body: 'The code proves the inbox is yours, not the vault. Without the recovery key the reset erases the vault and you start a new, empty one; the old files stay unreadable.',
  },
];

const FAQ_ITEMS = [
  {
    question: 'What if I forget my password?',
    answer: (
      <>
        <p>
          Choose &quot;Forgot password&quot; and we email a 6-digit code. After you enter it, give your recovery
          key and a new password: your documents stay exactly as they were. You can also approve the reset from
          a paired phone.
        </p>
        <p>
          If you can&apos;t get the email, &quot;Try another way&quot; resets with the recovery key alone.
          Without the recovery key, you can still get back into your account, but the reset erases your vault
          (files, folders, Trash, shares and paired phones) and starts a new, empty one with a new recovery key.
          Nobody, including us, can decrypt the old one.
        </p>
      </>
    ),
  },
  {
    question: 'Can Warden staff read my files?',
    answer: (
      <>
        <p>
          Not from what&apos;s stored. Files sit in the database encrypted, and the key that opens them is stored
          locked by your password and by your recovery key.
        </p>
        <p>
          But this is not end-to-end encryption. While you&apos;re signed in, the server unlocks your key for each
          request and encrypts uploads and decrypts downloads for you, so anyone who controls the running server
          could read what you open during that time. File and folder names are stored as plain text.
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
    question: "What doesn't Warden protect against?",
    answer: (
      <p>
        A compromised server while you&apos;re signed in, losing both your password and recovery key (the vault
        can&apos;t be recovered), a compromised or shared device, weak or reused passwords, and anyone who has a
        full share link. The full list is in{' '}
        <Link to="/#limits" className={site.textLink}>
          About
        </Link>
        .
      </p>
    ),
  },
  {
    question: 'Can I protect a share link?',
    answer: (
      <p>
        Yes, with any of three optional settings: a password, a limit of 1 to 100 downloads (after which the share is
        deleted), or restricting it to one email address that must enter a code we email. They control who our server
        will give the encrypted files to. A password also locks the link&apos;s key in your browser, so we never see
        it. The link itself is still a secret, and none of this makes Warden end-to-end encrypted. You can change or
        stop any share from Shared in the vault, but we can&apos;t show you a link again: we don&apos;t keep it.
      </p>
    ),
  },
  {
    question: 'How much can I store?',
    answer: (
      <p>
        A single file can be up to 4 MB, and each account has 25 MB in total (the server operator can change this). The
        total includes everything in Trash until it is removed. Uploads that would go over the limit are refused with a
        clear message, and emptying Trash or deleting files frees the space. Share links have their own limits: 20 MB
        per link, 60 MB across active links, and 20 active links.
      </p>
    ),
  },
  {
    question: 'What happens when I delete a file?',
    answer: (
      <p>
        It moves to Trash, still encrypted, for 30 days, and is then permanently removed along with its preview. You
        can restore it, delete it permanently, or empty the Trash sooner. Any share link that included it stops working
        right away. Previews are decrypted for you on the server over HTTPS, so this is not end-to-end encryption.
      </p>
    ),
  },
  {
    question: 'Can I get all my files out?',
    answer: (
      <p>
        Yes. Choose Export in the vault and download everything as one .zip, with your folders and original file names.
        It is built in your browser from the same downloads you could make one by one. The zip is not encrypted:
        anyone who gets it can open it, so keep it somewhere safe. Trash, share links and previews are not included.
        You can also import a zip back, through the normal upload (the same storage limit and 4 MB per file).
      </p>
    ),
  },
  {
    question: 'Can I delete my account?',
    answer: (
      <p>
        Yes, yourself. Open Account in the vault, choose Delete account, then enter your password, a code we email you,
        and your email address. Your documents, folders, share links, paired devices and the account are permanently
        deleted and can&apos;t be recovered. It can&apos;t reach files you downloaded or exported yourself,
        emails already sent, or a phone&apos;s offline copy.
      </p>
    ),
  },
  {
    question: 'Where is my data stored?',
    answer: (
      <p>
        In a MongoDB Atlas database. What&apos;s stored is your email, a password hash, your encrypted files and
        their encrypted preview images, the locked copies of your vault key, and basic file details such as names,
        folders and dates.
      </p>
    ),
  },
];

function HomePage() {
  usePageMeta(
    null,
    'Warden stores your IDs, contracts and records encrypted, with the key locked by your password and recovery key. A student project, provided as-is.'
  );
  const signedIn = Boolean(useSessionToken());
  // Only when the server says sign-up needs an invite code; a failed lookup just shows nothing here.
  const { status: configStatus, config } = useSignupConfig();
  const inviteOnly = !signedIn && configStatus === 'ready' && config?.signupMode === 'invite';
  // Set once, by the account page, right after a successful deletion.
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

  return (
    <>
      {accountDeleted && (
        <div className={site.container} style={{ paddingTop: 24 }}>
          <div className={forms.notice} role="status">
            <Icon name="check" />
            <p>
              <strong>Your account has been deleted.</strong> Your documents and account data were permanently
              removed from Warden, and we emailed you a confirmation.
            </p>
          </div>
        </div>
      )}

      {/* ---- Hero ---- */}
      <section className={styles.hero}>
        <div className={`${site.container} ${styles.heroGrid}`}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Encrypted document vault</p>
            <h1 className={styles.heroTitle}>
              A vault for the documents you can&apos;t afford to lose, or leak.
            </h1>
            <p className={styles.heroLede}>
              Warden stores your IDs, contracts and records encrypted, with a key locked by your password and your
              recovery key. The database holds only ciphertext and locked keys. It is not end-to-end encrypted; the
              limits are listed below.
            </p>
            <div className={styles.heroActions}>
              {primaryCta}
              <a href="#how-it-works" className={`${site.button} ${site.ghost}`}>
                See how it works
                <Icon name="arrowDown" size={18} />
              </a>
            </div>
            {inviteOnly && (
              <p className={styles.inviteNote}>
                <strong>Access is by invitation.</strong>{' '}
                {config.requestAccessText || 'Ask the person who runs this Warden for an invite code.'}
              </p>
            )}
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
              To be exact: this is not end-to-end encryption. While you&apos;re signed in, the server unlocks your
              key for each request and encrypts uploads and decrypts downloads for you. The comparison is about
              what&apos;s stored, and the{' '}
              <Link to="/#limits" className={site.textLink}>
                limits are listed here
              </Link>
              .
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
              <Link to="/#contact" className={site.textLink}>
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

      {/* ---- One page, three parts: Home -> About -> Contact. The header
          links and the old /about and /contact routes scroll to these. ---- */}
      <AboutSection />
      <ContactSection />
    </>
  );
}

export default HomePage;
