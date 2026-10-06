// Draft, not legal advice. Written for a student prototype; have it
// reviewed before Warden is offered to the public for real.
import { Link } from 'react-router-dom';

import LegalPage from '../../components/site/LegalPage.jsx';
import { CONTACT_EMAIL, MAX_FILE_SIZE_MB, PROJECT } from '../../config.js';
import { usePageMeta } from '../../utils/usePageMeta.js';

// Also shown inside the signup page's read-before-you-agree dialog
// (components/site/LegalModal.jsx), so it is exported.
export const SECTIONS = [
  {
    id: 'the-service',
    title: 'What Warden is',
    content: (
      <p>
        Warden is a student capstone project that lets you store documents in an encrypted vault. It is offered
        free of charge, for learning and demonstration, and it is not a commercial service.
      </p>
    ),
  },
  {
    id: 'as-is',
    title: 'Provided as-is',
    content: (
      <>
        <p>
          <strong>Warden is provided as-is, without any warranty.</strong> It may have bugs, go offline, or be
          shut down when the project ends. Keep your own copies of anything you cannot afford to lose.
        </p>
        <p>
          To the extent the law allows, the project team is not liable for lost data, lost access, or any damage
          arising from using Warden.
        </p>
      </>
    ),
  },
  {
    id: 'your-account',
    title: 'Your account and your keys',
    content: (
      <>
        <p>
          You are responsible for your password and your recovery key. Because of how Warden is built, we cannot
          recover your documents for you: if you lose both your password and your recovery key, and have no paired
          phone, the only way back into your account is a reset that starts a new, empty vault. Your old documents
          cannot be decrypted by anyone.
        </p>
        <p>Use a real email address you control. One account per person.</p>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    content: (
      <>
        <p>Do not use Warden to:</p>
        <ul>
          <li>store or share content that is illegal or that you have no right to store;</li>
          <li>attack, overload or probe the service, or other users&apos; accounts;</li>
          <li>get around limits such as the {MAX_FILE_SIZE_MB} MB per-file size or rate limits.</li>
        </ul>
        <p>We may suspend accounts that break these rules.</p>
      </>
    ),
  },
  {
    id: 'sharing',
    title: 'Share links',
    content: (
      <p>
        When you create a share link, anyone who has the link can open the shared files until it expires or you
        revoke it. Share links only to people you trust, and revoke them when they are no longer needed.
      </p>
    ),
  },
  {
    id: 'ending',
    title: 'Ending your use',
    content: (
      <p>
        You can stop using Warden at any time. To delete your account and all of its data, email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. See the{' '}
        <Link to="/privacy#deleting">privacy page</Link> for details.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    content: <p>If these terms change, we will update the date at the top of this page.</p>,
  },
];

function TermsPage() {
  usePageMeta('Terms', 'The terms for using Warden, a student capstone project provided as-is.');
  return (
    <LegalPage
      title="Terms of use"
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

export default TermsPage;
