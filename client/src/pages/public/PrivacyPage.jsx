// Draft, not legal advice. Written for a student prototype; have it
// reviewed before Warden is offered to the public for real.
import { Link } from 'react-router-dom';

import LegalPage from '../../components/site/LegalPage.jsx';
import { CONTACT_EMAIL, PROJECT } from '../../config.js';
import { LIMITS } from './limits.js';
import { usePageMeta } from '../../utils/usePageMeta.js';

// Also shown inside the signup page's read-before-you-agree dialog
// (components/site/LegalModal.jsx), so it is exported.
export const SECTIONS = [
  {
    id: 'what-we-collect',
    title: 'What we collect',
    content: (
      <>
        <p>Only what the service needs to work:</p>
        <ul>
          <li>
            <strong>Your email address</strong>, to identify your account and send verification and
            verification links and one-time codes (login, password reset and account deletion), and to tell you when your password was changed.
          </li>
          <li>
            <strong>A password hash</strong> (scrypt, salted). We never store your password itself.
          </li>
          <li>
            <strong>Your documents, encrypted.</strong> Each file, and the small preview image made for images and
            PDFs, is stored as ciphertext (AES-256-GCM).
          </li>
          <li>
            <strong>Locked copies of your vault key</strong>, one locked by your password and one by your
            recovery key, plus a fingerprint used to check that recovery material belongs to your account.
          </li>
          <li>
            <strong>File details</strong>: file names, folder names, file types, sizes, expiry dates you set,
            and upload dates. These are stored as plain text so the vault can list and sort them.
          </li>
          <li>
            <strong>Shared copies</strong>: when you create a share link, encrypted copies of the files you chose
            and an encrypted list of their names. We do not store the link&apos;s key, so we cannot open them. They
            are deleted when the link expires (at most 30 days), reaches its download limit, or you stop sharing. If
            you use the extra options we also keep: how many times it was downloaded and its limit; the recipient
            email address you entered (to send them a code); and, for a password, a random salt, the password-locked
            copy of the link&apos;s key and a hash of a value made from the password. We never receive the password or
            the plain key. For your own share list we keep the shared files&apos; names encrypted under your vault key.
          </li>
          <li>
            <strong>Paired devices</strong>: the name you give a paired phone and when it was paired. The phone
            itself keeps encrypted copies of your documents and a copy of your vault key locked by its PIN.
          </li>
          <li>
            <strong>One-time codes</strong>: when you log in, recover access with a paired phone, delete your
            account, or open a share link restricted to your email address, a 6-digit code is emailed to you and expires after a few minutes. We keep only a salted hash of it, never the code itself, and delete it once it is used or
            expires.
          </li>
          <li>
            <strong>Trusted browsers</strong>: only if you tick &quot;Trust this browser for 30 days&quot; when
            entering a login code. We keep a hash of a random token (the token itself stays in a cookie in that
            browser), a short label such as &quot;Chrome on Windows&quot; from the browser&apos;s user-agent, and when
            it was added and last used. No IP address is stored. It lets that browser skip the emailed code, never
            the password, and expires after 30 days. You can remove one or all of them on the Account page; they
            are also removed when you reset your password (by any route), wipe your vault or delete your account.
          </li>
          <li>
            <strong>Basic logs and limits</strong>: short-lived records of request counts per IP address and per
            email (to slow down password guessing), sign-in sessions that expire after 30 minutes of inactivity,
            and ordinary server logs.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'encryption',
    title: 'What we can and cannot read',
    content: (
      <>
        <p>
          Your files are stored encrypted with a key unique to your vault. That key is itself only ever stored in
          locked form, so the stored data on its own cannot be read by us or by anyone who obtains a copy of the
          database. A share link is separate: it carries its own key after the # symbol, and the server stores
          only encrypted copies of the shared files, never that key.
        </p>
        <p>
          This is not end-to-end encryption. Files travel to and from the server over HTTPS, and while you are
          signed in the server unlocks your vault key for each request to encrypt the files you upload and decrypt
          the ones you open. Your session token is kept in browser memory only, and sessions end after 30 minutes
          without activity. A paired phone encrypts and decrypts on the phone itself.
        </p>
        <p>
          Previews work the same way: to show you a file, the server decrypts it for you and sends it to your browser
          over HTTPS, and your browser then displays it. The preview is decrypted for you on the server, not
          end-to-end, and the decrypted copy is not kept on the server.
        </p>
      </>
    ),
  },
  {
    id: 'limits',
    title: 'What Warden does not protect against',
    content: (
      <ul>
        {LIMITS.map((item) => (
          <li key={item.title}>
            <strong>{item.title}.</strong> {item.body}
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'use',
    title: 'How we use it',
    content: (
      <>
        <p>
          We use your information only to run Warden: to sign you in, keep your vault working, send the emails
          you ask for, and protect accounts from abuse. We do not sell, rent or share your data, and we do not use
          it for advertising.
        </p>
        <p>Warden has no analytics or tracking scripts.</p>
      </>
    ),
  },
  {
    id: 'where',
    title: 'Where it is stored',
    content: (
      <p>
        Data is stored in a MongoDB Atlas database. Emails are sent through an SMTP email provider. These
        providers process data on our behalf to run the service.
      </p>
    ),
  },
  {
    id: 'keeping',
    title: 'How long we keep it',
    content: (
      <p>
        Your account and documents are kept until you delete them or delete your account. When you delete a file or
        folder it moves to Trash, where it stays encrypted for 30 days and is then permanently removed, including its
        preview image. You can restore it, delete it permanently sooner, or empty the Trash at any time. Share links
        that include a file stop working the moment it is moved to Trash and are not brought back by restoring it.
        Sign-in sessions,
        verification links and rate-limit records expire on their own, within minutes to a day, and are removed
        immediately if you delete your account.
      </p>
    ),
  },
  {
    id: 'deleting',
    title: 'Deleting your account',
    content: (
      <>
        <p>
          You can delete any document from inside your vault at any time, and you can delete your whole account
          yourself: open Account in the vault and choose Delete account. You confirm with your master password, a
          one-time code we email you, and by typing your account email.
        </p>
        <p>
          <strong>Export:</strong> &quot;Export my files&quot; builds a zip inside your browser, from the same authenticated downloads
          you could make one at a time, and saves it to your device. We do not see or keep the zip. It is not encrypted, so
          anyone who gets the file can open it.
        </p>
        <p>
          Deleting is permanent and immediate. It removes your documents (including anything in Trash) and their previews, your folders, every share
          link and its encrypted copies, your paired devices, any pending login or deletion
          codes, your sessions, and the account itself (email, password hash and locked keys). We keep no copy and
          cannot recover any of it, and we send you an email confirming it. Our logs record only that an account was
          deleted, with no email address or content.
        </p>
        <p>
          Deletion cannot reach what is not on our servers: emails we already sent, files you downloaded or
          exported yourself, and the offline copy on a phone you paired (this browser&apos;s copy is cleared
          automatically; clear a phone&apos;s browser data yourself). If you cannot use the Account page, email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address on the account.
        </p>
      </>
    ),
  },
  {
    id: 'your-rights',
    title: 'Your rights (Data Privacy Act of 2012)',
    content: (
      <p>
        Under the Philippine Data Privacy Act of 2012 (Republic Act No. 10173), you have the right to be informed
        about how your personal data is processed, to access it, to correct it, to object to its processing, and
        to have it erased or blocked. To exercise any of these, contact us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes and contact',
    content: (
      <p>
        If this policy changes, we will update the date at the top of this page. Questions go to{' '}
        <Link to="/#contact">our contact page</Link>.
      </p>
    ),
  },
];

function PrivacyPage() {
  usePageMeta('Privacy', 'What Warden collects, what it can and cannot read, and how to delete your account.');
  return (
    <LegalPage
      title="Privacy"
      updated="October 2026"
      intro={
        <p>
          Warden is an academic project ({PROJECT.program} {PROJECT.course}, {PROJECT.group}, {PROJECT.school}),
          provided as-is. This is a plain-language draft, not a reviewed legal document.
        </p>
      }
      sections={SECTIONS}
    />
  );
}

export default PrivacyPage;
