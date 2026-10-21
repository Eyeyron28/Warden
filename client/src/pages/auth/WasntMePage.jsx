import { Link } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';

function WasntMePage() {
  usePageMeta('This wasn’t me', 'Secure your Warden account after a sign-in you do not recognise.');
  return (
    <AuthLayout
      title="Secure your account"
      subtitle="If you did not sign in from that new device, someone may know your password. Resetting it takes a few minutes."
    >
      <div className={forms.form}>
        <div className={forms.alert}>
          <Icon name="alert" />
          <p>
            <strong>Sign out all devices and reset my password.</strong> Resetting your password signs out every device, removes every trusted
            browser and sends you an email to confirm. Your files stay encrypted and are kept.
          </p>
        </div>
        <Link to="/forgot-password" className={`${site.button} ${site.primary} ${site.block}`}>
          Sign out all devices and reset my password
        </Link>
        <p className={forms.hint}>
          If it was you after all, you can ignore this and just sign in. Already signed in? Open Devices &amp; activity in the app to sign out a
          single device.
        </p>
      </div>
    </AuthLayout>
  );
}

export default WasntMePage;
