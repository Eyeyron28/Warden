import { useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import forms from '../../components/site/forms.module.css';

/**
 * Password field with a show/hide toggle. The toggle is a real button
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
  autoComplete = 'current-password',
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
          type={revealed ? 'text' : 'password'}
          className={forms.input}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
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
