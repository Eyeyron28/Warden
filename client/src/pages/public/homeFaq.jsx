import { Link } from 'react-router-dom';

import { MAX_FILE_SIZE_MB } from '../../config.js';
import site from '../../components/site/site.module.css';

// The questions on the landing page. Every answer has to match the code; src/utils/claims.test.js reads this file.
export const FAQ_ITEMS = [
  {
    question: 'What is the recovery key?',
    answer: (
      <p>
        Sixteen characters, in four groups, shown to you once when you sign up. It locks a second copy of your vault key. If you forget
        your password, an emailed code plus the recovery key lets you choose a new password and keep every file. We store only a hash of
        it, so we cannot show it again or recover it for you. Keep it somewhere safe, apart from your password.
      </p>
    ),
  },
  {
    question: 'Why does login need an emailed code?',
    answer: (
      <p>
        After your password is checked we email a 6-digit code that expires after a few minutes, and you get 5 tries at it. A stolen password
        alone is then not enough to sign in. It also means your email account is part of your security, so protect it as well.
      </p>
    ),
  },
  {
    question: 'What does "Trust this browser" do?',
    answer: (
      <p>
        If you tick it after entering a correct code, that browser skips the emailed code at later logins for 30 days. It still asks for
        your password. You can remove trusted browsers on the Account page, and any password reset removes them all. Do not tick it on a
        shared computer.
      </p>
    ),
  },
  {
    question: 'Will reloading the page sign me out?',
    answer: (
      <>
        <p>
          No. Your sign-in token is kept in that tab&apos;s sessionStorage, so a reload keeps you signed in; closing the tab (or the browser) ends
          it. Signed in sessions end after 30 minutes without activity, and after 12 hours at most. A second tab you open picks the session up from the first. Your
          password and your unlocked vault key are never stored in the browser.
        </p>
        <p>
          The trade-off: script that ran inside the page could read the token. That is why Warden loads no third-party script, ships a strict
          Content-Security-Policy, and why a token alone cannot do anything the signed-in person could not (sensitive actions still ask for an
          emailed code).
        </p>
      </>
    ),
  },
  {
    question: 'What does Warden record about my activity?',
    answer: (
      <p>
        For 30 days, a log of what happened on your account: sign-ins, which files were opened, downloaded or shared, and when, from which of your
        browsers and which country. It never holds file names, the contents, other people&apos;s emails, or IP addresses. You can read it on
        Devices &amp; activity, sign any browser out from there, and check it: the check detects edits and gaps. It cannot
        detect the removal of the newest entries by someone who can write to the database.
      </p>
    ),
  },
  {
    question: 'What if I forget my password?',
    answer: (
      <>
        <p>
          Choose &quot;Forgot password&quot; and we email a 6-digit code. After you enter it, give your recovery
          key and a new password: your documents stay exactly as they were.
        </p>
        <p>
          If you can&apos;t get the email, &quot;Try another way&quot; resets with the recovery key alone.
          Without the recovery key, you can still get back into your account, but the reset erases your vault
          (files, folders, Trash, shares, devices and activity) and starts a new, empty one with a new recovery key.
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
    question: "Why isn't it end-to-end encrypted?",
    answer: (
      <p>
        Because the server does the encrypting and decrypting. Your password reaches the server when you log in, and the server unlocks your
        vault key for each request. That is how previews, file-type checks and password recovery work. The cost is trust: someone who
        controls the running server could read what you open while you are signed in. Warden has not been audited by a third party.
      </p>
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
        Yes. Warden has no paid plans. It&apos;s provided as-is, so keep your own
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
        will give the encrypted files to. The key is generated when you create the link and placed after the # in the
        address, so it isn&apos;t sent to our server when someone opens the link. The server does handle the key while it
        creates the link. A password adds a lock on that key, made in your browser, so the password itself never
        reaches us. The link itself is still a secret, and none of this makes Warden end-to-end encrypted. You can
        change or stop any share from Shared in the vault, but we can&apos;t show you a link again: we don&apos;t keep it.
      </p>
    ),
  },
  {
    question: 'What is Emergency Access?',
    answer: (
      <>
        <p>
          An optional safety net for when you can&apos;t be reached. You name one person you trust, choose a waiting period (3, 7 or 14
          days) and what they may see (everything, or only some folders). They get an Emergency Kit: half of a key. If they ever ask for
          access, we email you when the request is made, and the request is refused if that email cannot be sent. The wait is counted from
          that email, and you can deny it until the wait ends. If you don&apos;t, they can open a read-only session that lasts a few hours
          (never more than 4), and everything they do appears in your activity log.
        </p>
        <p>
          It is not end-to-end encryption: Warden encrypts files on its server. A stolen kit alone, or a copy of our database alone, can&apos;t
          open your vault, but a kit together with a leak of our database could, and someone running the server together with your contact
          could skip the wait. The folder limit is enforced by our server, not by cryptography.{' '}
          <Link to="/emergency" className={site.textLink}>
            If you were named as someone&apos;s contact, start here.
          </Link>
        </p>
      </>
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
        Yes. Choose Export / Import in the vault and download everything as one .zip, with your folders and original file names.
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
        and your email address. Your documents, folders, share links, devices, the activity log and the account are permanently
        deleted and can&apos;t be recovered. It can&apos;t reach files you downloaded or exported yourself,
        or emails already sent.
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
