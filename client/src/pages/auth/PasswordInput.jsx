import { useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import forms from '../../components/site/forms.module.css';

/**
 * Password field with a show/hide toggle.
 *
 * `autoComplete` says what the field is for:
 *   - "new-password": the person is CHOOSING a password (sign-up, reset, change,
 *     and the confirm field next to it) - browsers may offer a generated one;
 *   - "off" (the default): the existing password (login, re-authentication) - with a
 *     non-standard name, so browsers do not offer to generate a strong password
 *     where nothing new is being created.
 The toggle is a real button
 * with a changing label and aria-pressed, outside the input's own tab
 * stop order only by position (Tab reaches it right after the input).
 */
function PasswordInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  error,
  autoComplete = 'off',
  describedBy,
  autoFocus = false,
  inputRef,
}) {
  const [revealed, setRevealed] = useState(false);
  const errorId = `${id}-error`;

  return (
    <div className={forms.field}>
      <label htmlFor={id} className={forms.label}>
        {label}
      </label>
      <div className={forms.passwordWrap}>
        <input
          ref={inputRef}
          id={id}
          name={autoComplete === 'new-password' ? undefined : `wd-${id}-secret`}
          type={revealed ? 'text' : 'password'}
          className={forms.input}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          aria-invalid={Boolean(error)}
          aria-describedby={[errorId, describedBy].filter(Boolean).join(' ')}
        />
        <button
          type="button"
          className={forms.revealButton}
          onClick={() => setRevealed((value) => !value)}
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={revealed}
        >
          <Icon name={revealed ? 'eyeOff' : 'eye'} />
        </button>
      </div>
      <p id={errorId} className={forms.error} aria-live="polite">
        {error || ''}
      </p>
    </div>
  );
}

export default PasswordInput;
