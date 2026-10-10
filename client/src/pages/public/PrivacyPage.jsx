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
            and an encrypted list of their names. The key is generated when you create the link and placed after the # in the
            address, so it isn&apos;t sent to our server when someone opens the link. The server does handle the key while it
            creates the link, but it does not store it, so afterwards we cannot open the copies. They
            are deleted when the link expires (at most 30 days), reaches its download limit, or you stop sharing. If
            you use the extra options we also keep: how many times it was downloaded and its limit; the recipient
            email address you entered (to send them a code); and, for a password, a random salt, the password-locked
            copy of the link&apos;s key and a hash of a value made from the password. We never receive the password. The plain key
            was made by the server when the link was created and is not kept. For your own share list we keep the shared files&apos; names encrypted under your vault key.
          </li>
          <li>
            <strong>Devices and activity</strong>: each browser that signs in gets a random id kept in a strictly functional cookie
            (<code>warden_did</code>, HttpOnly, Secure, SameSite=Strict, up to 400 days). It is used only to tell your browsers apart in your own
            account, so you can see and sign out any of them: no tracking, no advertising, nothing shared. We store only a hash of it, a
            label such as &quot;Chrome on Windows&quot;, when the browser was first and last seen, and its country and city, taken from the
            hosting platform&apos;s own headers (never an IP address, and no third-party location service). Alongside it we keep, for 30
            days, a log of what happened on your account (sign-ins and failures, files opened, downloaded, renamed, moved, deleted or shared,
            exports, and when your share links are opened, with only a coarse country for a visitor). The log holds ids only: no file names,
            no content, no email addresses and no IP addresses; names are looked up when you read it. Each entry is signed in a chain. The
            check detects edits and gaps. It cannot detect the removal of the newest entries by someone who can write to the
            database, and it does not protect against someone who also holds our signing key. We also count, per
            file, how often you opened or downloaded it and when you last did, and per share link how many times it was opened, to show you
            the Overview. Deleting your account or erasing your vault removes all of it.
          </li>
          <li>
            <strong>One-time codes</strong>: when you log in, delete your
            account, or open a share link restricted to your email address, a 6-digit code is emailed to you and expires after a few minutes. We keep only a salted hash of it, never the code itself, and delete it once it is used or
            expires.
          </li>
          <li>
            <strong>Emergency access</strong>: only if you set it up. We store your trusted contact&apos;s email address (to send them codes and
            notices), a name you gave them, the waiting period (3, 7 or 14 days), which folders they may see, and half of a key. The other half (the
            kit) is shown to you once and is not stored, logged or emailed by us. Your vault key is stored wrapped under the combination of both
            halves, so a stolen kit alone, or a copy of our database alone, cannot open your vault. A copy of our database together with the kit can,
            and an operator working with your contact could skip the wait: this is not end-to-end encryption, because Warden encrypts files on the
            server. When your contact asks for access we email you when the request is made, and the request is refused if that email cannot be sent.
            The waiting period is counted from that email, and we email you every day until you deny it or the wait ends; you can deny it by
            one click until a session starts. After a denial they cannot ask again for 24 hours. A session is read-only, ends within 4 hours, and can
            only see the folders you chose; that limit is enforced by our server, not by encryption. Everything they do is written to your activity
            log (file ids only, no names). Turning it off, or changing your vault key, ends any session and removes the setup. Deleting your account
            or erasing your vault removes all of it.
          </li>
          <li>
            <strong>Expiry dates and reminders</strong>: if you give a file an &quot;Expires on&quot; date, that date is stored readable by the
            server (it has to be, to email you while you are signed out). The file&apos;s contents and name stay encrypted. When a date is 60,
            30 or 7 days away, and on the day, we send one email with a count (never a file name). You can turn it off in Account settings.
            Deleting the file, your account or your vault removes the dates and the record of which reminders were sent.
          </li>
          <li>
            <strong>Share purpose</strong>: if you add a &quot;Purpose&quot; to a share link, it is kept inside the share&apos;s encrypted manifest
            (and, for your own list, encrypted under your vault key), never stored in the clear, in the link, in the activity log or in an
            email. The viewer&apos;s browser shows it as a faint watermark. It discourages reuse; it cannot stop a screenshot.
          </li>
          <li>
            <strong>Trusted browsers</strong>: only if you leave &quot;Trust this browser for 30 days&quot; ticked when
            entering a login code (it is ticked by default; do not leave it ticked on a shared computer). We keep a hash of a random token (the token
            itself stays in a cookie named for your account in that browser, so several accounts can each be trusted there), a short label such as &quot;Chrome on Windows&quot; from the browser&apos;s user-agent, and when
            it was added and last used. No IP address is stored. It lets that browser skip the emailed code, never
            the password, and expires after 30 days. You can remove one or all of them on the Account page; they
            are also removed when you reset your password (by any route), wipe your vault or delete your account.
          </li>
          <li>
            <strong>Basic logs and limits</strong>: short-lived records of request counts per IP address and per
            email (to slow down password guessing), sign-in sessions that end after 30 minutes without activity and after
            12 hours at most, and ordinary server logs (which hold error text and a request number, never email addresses).
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
          database. A share link is separate: it carries its own key after the # symbol. The key is generated when you create the link, so it
          isn&apos;t sent to our server when someone opens the link; the server does handle it while it creates the link, and stores only
          encrypted copies of the shared files, not that key.
        </p>
        <p>
          This is not end-to-end encryption. Files travel to and from the server over HTTPS, and while you are
          signed in the server unlocks your vault key for each request to encrypt the files you upload and decrypt
          the ones you open. Your session token is kept in your browser tab&apos;s sessionStorage (so a reload keeps you signed in; closing the tab ends it),
          never in a cookie or localStorage, and signed in sessions end after 30 minutes without activity, and after 12 hours at most. Script injected into a page could read that token,
          which is why Warden loads no third-party script and sets a strict Content-Security-Policy. Your password and the unlocked key are never
          stored in the browser. Warden is a website: there is no phone vault and no offline copy of your files.
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
          link and its encrypted copies, your devices and activity log, any pending login or deletion
          codes, your sessions, and the account itself (email, password hash and locked keys). We keep no copy and
          cannot recover any of it, and we send you an email confirming it. Our logs record only that an account was
          deleted, with no email address or content.
        </p>
        <p>
          Deletion cannot reach what is not on our servers: emails we already sent, files you downloaded or
          exported yourself. If you cannot use the Account page, email{' '}
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
