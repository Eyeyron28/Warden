import { useRef } from 'react';

import { CODE_LENGTH, backspaceAt, digitsOnly, fillFrom } from '../utils/otpInput.js';
import styles from './OtpCodeInput.module.css';

/**
 * Six single-digit boxes for the emailed login code. Controlled: `digits` is
 * an array of six strings ('' or one digit) and `onChange` receives the next
 * array. Typing advances, Backspace steps back, arrow keys move, and a pasted
 * code (or a code autofilled from an SMS/email, which arrives in one box) is
 * spread across all six.
 */
function OtpCodeInput({ digits, onChange, disabled = false, invalid = false, autoFocus = false, labelId }) {
  const refs = useRef([]);

  const focusBox = (index) => {
    const node = refs.current[index];
    if (node) {
      node.focus();
      node.select();
    }
  };

  const apply = ({ digits: next, focusIndex }) => {
    onChange(next);
    focusBox(focusIndex);
  };

  const handleChange = (index, event) => {
    let text = event.target.value;
    // Typing over a filled box gives two characters; keep only the new one.
    if (digits[index] && text.length > 1) text = text.replace(digits[index], '');
    if (!digitsOnly(text)) {
      // Not a digit: drop it, leaving the box as it was.
      onChange([...digits]);
      return;
    }
    apply(fillFrom(digits, index, text));
  };

  const handleKeyDown = (index, event) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      apply(backspaceAt(digits, index));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(Math.max(0, index - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(Math.min(CODE_LENGTH - 1, index + 1));
    }
  };

  const handlePaste = (index, event) => {
    event.preventDefault();
    apply(fillFrom(digits, index, event.clipboardData.getData('text')));
  };

  return (
    <div className={styles.group} role="group" aria-labelledby={labelId} aria-label={labelId ? undefined : 'Login code'}>
      {digits.map((digit, index) => (
        <input
          // Positions are fixed, so the index is a stable key.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          className={`${styles.box} ${index === 2 ? styles.afterThird : ''}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoCapitalize="off"
          spellCheck={false}
          maxLength={index === 0 ? CODE_LENGTH : 2}
          value={digit}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
          aria-invalid={invalid || undefined}
          onChange={(event) => handleChange(index, event)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={(event) => handlePaste(index, event)}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  );
}

export default OtpCodeInput;
