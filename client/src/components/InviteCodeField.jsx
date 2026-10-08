import { useState } from 'react';

import SensitiveInput from './SensitiveInput.jsx';
import Icon from './site/Icon.jsx';
import forms from './site/forms.module.css';
import { INVITE_MAX_LENGTH, cleanInviteCode } from '../utils/inviteCode.js';
import styles from './InviteCodeField.module.css';

/**
 * The sign-up invite code: required, first in the form.
 *
 *  - visible "Required" marker, aria-required and native required (the form
 *    itself is noValidate, so the page's own inline errors do the talking);
 *  - paste is trimmed (a copied code often carries a trailing newline);
 *  - monospace, no autofill, no auto-capitalisation or spell-check;
 *  - masked by default with a show/hide toggle. The mask is CSS, not
 *    type="password", so password managers do not mistake it for a login.
 *
 * `value` and `onChange(string)` are controlled by the page. `inputRef` lets the
 * page move focus here when the server says the code was wrong.
 */
function InviteCodeField({ id = 'signup-invite', value, onChange, onBlur, error, inputRef, helper, autoFocus = false, children }) {
  const [revealed, setRevealed] = useState(false);
  const errorId = `${id}-error`;
  const helperId = `${id}-help`;

  const handlePaste = (event) => {
    const text = event.clipboardData?.getData('text');
    if (typeof text !== 'string') return;
    const clean = cleanInviteCode(text);
    if (clean === text) return; // nothing to trim: let the browser paste as usual
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${clean}${value.slice(end)}`);
  };

  return (
    <div className={forms.field}>
      <div className={styles.labelRow}>
        <label htmlFor={id} className={forms.label}>
          Invite code
        </label>
        <span className={styles.required}>Required</span>
      </div>
      <div className={forms.passwordWrap}>
        <SensitiveInput
          fieldName="signup-invite"
          id={id}
          inputRef={inputRef}
          className={`${forms.input} ${forms.mono} ${revealed ? '' : styles.masked}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onPaste={handlePaste}
          maxLength={INVITE_MAX_LENGTH + 64}
          required
          autoFocus={autoFocus}
          aria-required="true"
          aria-invalid={Boolean(error)}
          aria-describedby={`${helperId} ${errorId}`}
        />
        <button
          type="button"
          className={forms.revealButton}
          onClick={() => setRevealed((shown) => !shown)}
          aria-label={revealed ? 'Hide invite code' : 'Show invite code'}
          aria-pressed={revealed}
        >
          <Icon name={revealed ? 'eyeOff' : 'eye'} />
        </button>
      </div>
      <p id={helperId} className={forms.hint}>
        {helper || 'Warden is invite-only. Enter the code you were given.'}
      </p>
      {children}
      <p id={errorId} className={forms.error} aria-live="polite">
        {error || ''}
      </p>
    </div>
  );
}

export default InviteCodeField;
