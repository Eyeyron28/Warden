import { useRef, useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import { CONTACT_EMAIL } from '../../config.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './ContactPage.module.css';

const MESSAGE_MAX = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Please enter your name.';
  if (!values.email.trim()) errors.email = 'Please enter your email so we can reply.';
  else if (!EMAIL_RE.test(values.email.trim())) errors.email = 'That email address doesn’t look right.';
  if (values.message.trim().length < 10) errors.message = 'Please write at least a sentence (10 characters).';
  else if (values.message.length > MESSAGE_MAX) errors.message = `Please keep it under ${MESSAGE_MAX} characters.`;
  return errors;
}

function buildMailto(values) {
  const subject = `Warden: message from ${values.name.trim()}`;
  const body = `${values.message.trim()}\n\n- ${values.name.trim()} (${values.email.trim()})`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Contact form with no backend: on submit it opens the visitor's own mail
 * app with the message prefilled, addressed to CONTACT_EMAIL (config.js).
 * A hidden honeypot field filters the simplest bots - if it's filled in,
 * the form pretends to succeed and does nothing.
 */
function ContactPage() {
  usePageMeta('Contact', 'Questions, bug reports or account deletion requests for the Warden team.');

  const [values, setValues] = useState({ name: '', email: '', message: '', website: '' });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(null); // null | { mailto }
  const formRef = useRef(null);

  const errors = validate(values);
  const showError = (field) => touched[field] && errors[field];

  const update = (field) => (event) => setValues((prev) => ({ ...prev, [field]: event.target.value }));
  const blur = (field) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const handleSubmit = (event) => {
    event.preventDefault();
    setTouched({ name: true, email: true, message: true });
    if (Object.keys(errors).length > 0) {
      // Send keyboard and screen-reader users straight to the first problem.
      const first = ['name', 'email', 'message'].find((field) => errors[field]);
      formRef.current?.querySelector(`#contact-${first}`)?.focus();
      return;
    }
    if (values.website) {
      setSubmitted({ mailto: null });
      return;
    }
    const mailto = buildMailto(values);
    setSubmitted({ mailto });
    window.location.href = mailto;
  };

  return (
    <div className={`${site.container} ${styles.layout}`}>
      <header className={styles.aside}>
        <h1 className={styles.title}>Get in touch</h1>
        <p className={styles.lede}>
          Questions about how Warden works, a bug you found, or a request to delete your account. We read
          everything; replies may take a few days.
        </p>
        <dl className={styles.details}>
          <div>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${CONTACT_EMAIL}`} className={site.textLink}>
                {CONTACT_EMAIL}
              </a>
            </dd>
          </div>
          <div>
            <dt>Deleting your account</dt>
            <dd>Write from the address on your account so we know the request is really yours.</dd>
          </div>
        </dl>
      </header>

      <div className={styles.card}>
        {submitted ? (
          <div className={styles.success} role="status">
            <Icon name="check" size={28} className={styles.successIcon} />
            <h2 className={styles.successTitle}>Your email app should be open.</h2>
            <p>
              The message is ready to send from your own email account. Nothing is sent until you press send
              there.
            </p>
            {submitted.mailto && (
              <p>
                Didn&apos;t open?{' '}
                <a href={submitted.mailto} className={site.textLink}>
                  Try again
                </a>{' '}
                or write to <span className={styles.address}>{CONTACT_EMAIL}</span> directly.
              </p>
            )}
            <button
              type="button"
              className={`${site.button} ${site.ghost}`}
              onClick={() => {
                setSubmitted(null);
                setValues({ name: '', email: '', message: '', website: '' });
                setTouched({});
              }}
            >
              Write another message
            </button>
          </div>
        ) : (
          <form ref={formRef} className={forms.form} onSubmit={handleSubmit} noValidate>
            <div className={forms.field}>
              <label htmlFor="contact-name" className={forms.label}>
                Name
              </label>
              <input
                id="contact-name"
                className={forms.input}
                value={values.name}
                onChange={update('name')}
                onBlur={blur('name')}
                autoComplete="name"
                aria-invalid={Boolean(showError('name'))}
                aria-describedby="contact-name-error"
              />
              <p id="contact-name-error" className={forms.error} aria-live="polite">
                {showError('name') || ''}
              </p>
            </div>

            <div className={forms.field}>
              <label htmlFor="contact-email" className={forms.label}>
                Email
              </label>
              <input
                id="contact-email"
                type="email"
                className={forms.input}
                value={values.email}
                onChange={update('email')}
                onBlur={blur('email')}
                autoComplete="email"
                inputMode="email"
                aria-invalid={Boolean(showError('email'))}
                aria-describedby="contact-email-error"
              />
              <p id="contact-email-error" className={forms.error} aria-live="polite">
                {showError('email') || ''}
              </p>
            </div>

            <div className={forms.field}>
              <div className={forms.labelRow}>
                <label htmlFor="contact-message" className={forms.label}>
                  Message
                </label>
                <span
                  className={`${forms.counter} ${values.message.length > MESSAGE_MAX ? forms.counterOver : ''}`}
                  aria-live="polite"
                >
                  {values.message.length} / {MESSAGE_MAX}
                </span>
              </div>
              <textarea
                id="contact-message"
                className={forms.textarea}
                value={values.message}
                onChange={update('message')}
                onBlur={blur('message')}
                aria-invalid={Boolean(showError('message'))}
                aria-describedby="contact-message-error"
              />
              <p id="contact-message-error" className={forms.error} aria-live="polite">
                {showError('message') || ''}
              </p>
            </div>

            <div className={forms.honeypot} aria-hidden="true">
              <label htmlFor="contact-website">Leave this field empty</label>
              <input
                id="contact-website"
                tabIndex={-1}
                autoComplete="off"
                value={values.website}
                onChange={update('website')}
              />
            </div>

            <div className={styles.submitRow}>
              <button type="submit" className={`${site.button} ${site.primary}`}>
                Open in my email app
                <Icon name="arrowRight" size={18} />
              </button>
              <p className={forms.hint}>Opens your own email app with this message filled in.</p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default ContactPage;
