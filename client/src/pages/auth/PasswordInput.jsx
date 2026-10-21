import { useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import forms from '../../components/site/forms.module.css';

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
      <label data-required htmlFor={id} className={forms.label}>
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
