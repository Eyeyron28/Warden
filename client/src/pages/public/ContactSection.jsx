import { useRef, useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import { CONTACT_EMAIL } from '../../config.js';
import { contactFailureMessage, sendContactMessage } from '../../services/contactService.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './ContactSection.module.css';

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

function ContactSection() {
  const [values, setValues] = useState({ name: '', email: '', message: '', website: '' });
  const [touched, setTouched] = useState({});
  const [status, setStatus] = useState('idle');
  const [failure, setFailure] = useState('');
  const formRef = useRef(null);

  const errors = validate(values);
  const showError = (field) => touched[field] && errors[field];

  const update = (field) => (event) => setValues((prev) => ({ ...prev, [field]: event.target.value }));
  const blur = (field) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (status === 'sending') return;
    setTouched({ name: true, email: true, message: true });
    if (Object.keys(errors).length > 0) {
      const first = ['name', 'email', 'message'].find((field) => errors[field]);
      formRef.current?.querySelector(`#contact-${first}`)?.focus();
      return;
    }
    setStatus('sending');
    setFailure('');
    try {
      await sendContactMessage(values);
      setValues({ name: '', email: '', message: '', website: '' });
      setTouched({});
      setStatus('sent');
    } catch (error) {
      setFailure(contactFailureMessage(error));
      setStatus('error');
    }
  };

  return (
    <section
      id="contact"
      className={`${site.container} ${site.sectionRule} ${styles.layout}`}
      aria-labelledby="contact-title"
    >
      <header className={styles.aside}>
        <h2 id="contact-title" className={styles.title}>
          Get in touch
        </h2>
        <p className={styles.lede}>
          Questions about how Warden works, a bug you found, or a request to delete your account. We read
          everything; replies may take a few days.
        </p>
        <dl className={styles.details}>
          <div>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${CONTACT_EMAIL}`} className={`${site.textLink} ${site.tapLink}`}>
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
        {status === 'sent' ? (
          <div className={styles.success} role="status">
            <Icon name="check" size={28} className={styles.successIcon} />
            <h3 className={styles.successTitle}>Message sent.</h3>
            <p>We read everything; replies may take a few days.</p>
            <button
              type="button"
              className={`${site.button} ${site.ghost}`}
              onClick={() => {
                setStatus('idle');
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

            {status === 'error' && (
              <div className={forms.alert} role="alert">
                <Icon name="alert" />
                <p>{failure}</p>
              </div>
            )}

            <div className={styles.submitRow}>
              <button type="submit" className={`${site.button} ${site.primary}`} disabled={status === 'sending'}>
                {status === 'sending' ? 'Sending…' : status === 'error' ? 'Try again' : 'Send message'}
                <Icon name="arrowRight" size={18} />
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

export default ContactSection;
