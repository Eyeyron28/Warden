import { useId, useState } from 'react';
import { Eye, EyeSlash } from '@phosphor-icons/react';

import styles from './PasswordField.module.css';

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  error,
  autoFocus = false,
}) {
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();
  const errorId = useId();

  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>

      <div className={`${styles.inputRow} ${error ? styles.inputRowError : ''}`}>
        <input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="current-password"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={styles.input}
        />
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide passphrase' : 'Show passphrase'}
          aria-pressed={revealed}
        >
          {revealed ? <EyeSlash size={18} /> : <Eye size={18} />}
        </button>
      </div>

      <p id={errorId} className={styles.error} role="alert">
        {error || ' '}
      </p>
    </div>
  );
}

export default PasswordField;
