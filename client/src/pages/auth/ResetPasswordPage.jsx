import { Link } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

/**
 * /reset-password?token=... was the page the old emailed reset link opened. That
 * flow is gone (resetting now starts from an emailed 6-digit code), but links in
 * old emails still exist. They land here and get one plain answer: the page does
 * not read, send or say anything about the token in the address.
 */
function ResetPasswordPage() {
  usePageMeta('This reset link doesn’t work', 'Reset links have been replaced by emailed codes.');
  return (
    <AuthLayout title="This reset link doesn't work">
      <div className={styles.stack}>
        <div className={forms.alert} role="alert">
          <Icon name="alert" />
          <p>
            Reset links have been replaced. To reset your password, request a 6-digit code instead; you can still keep
            your documents with your recovery key.
          </p>
        </div>
        <Link to="/forgot-password" className={`${site.button} ${site.primary} ${site.block}`}>
          Reset my password
        </Link>
      </div>
    </AuthLayout>
  );
}

export default ResetPasswordPage;
