import { Check, X } from '@phosphor-icons/react';

import { calculatePasswordStrength, getRequirementChecklist } from '../utils/passwordPolicy.js';
import styles from './PasswordStrengthMeter.module.css';

const SEGMENT_COUNT = 5;

// Built from the existing palette rather than a generic red-yellow-green
// ramp: danger red at the weak end, a neutral faint tone for "meh", then
// the app's own accent green (dim, then full) for strong - the same
// red/neutral/green vocabulary already used for error/idle/success states
// elsewhere in the app.
const SCORE_COLORS = [
  'var(--color-danger)',
  'var(--color-danger)',
  'var(--color-text-faint)',
  'var(--color-accent-dim)',
  'var(--color-accent)',
];

/**
 * Live password strength meter + requirement checklist. Reads straight
 * from utils/passwordPolicy.js so it updates on every keystroke with no
 * network round-trip.
 */
function PasswordStrengthMeter({ password }) {
  const hasValue = Boolean(password);
  const { score, label } = hasValue ? calculatePasswordStrength(password) : { score: -1, label: '' };
  const checklist = getRequirementChecklist(password || '');

  return (
    <div className={styles.meter}>
      <div className={styles.segments} role="img" aria-label={hasValue ? `Password strength: ${label}` : 'Password strength'}>
        {Array.from({ length: SEGMENT_COUNT }).map((_, index) => (
          <span
            key={index}
            className={styles.segment}
            style={index <= score ? { background: SCORE_COLORS[score] } : undefined}
          />
        ))}
      </div>

      <p className={styles.label} style={hasValue ? { color: SCORE_COLORS[score] } : undefined}>
        {hasValue ? label : 'Enter a password'}
      </p>

      <ul className={styles.checklist}>
        {checklist.map((item) => (
          <li key={item.key} className={item.met ? styles.met : styles.unmet}>
            {item.met ? <Check size={13} weight="bold" /> : <X size={13} weight="bold" />}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default PasswordStrengthMeter;
