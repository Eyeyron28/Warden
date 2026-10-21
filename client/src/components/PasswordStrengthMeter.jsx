import { Check, X } from '@phosphor-icons/react';

import { calculatePasswordStrength, getRequirementChecklist } from '../utils/passwordPolicy.js';
import styles from './PasswordStrengthMeter.module.css';

const SCORE_COLORS = [
  'var(--color-danger)',
  'var(--color-danger)',
  'var(--color-text-faint)',
  'var(--color-accent-dim)',
];

function PasswordStrengthMeter({ password }) {
  const hasValue = Boolean(password);
  const { score, label } = hasValue ? calculatePasswordStrength(password) : { score: -1, label: '' };
  const checklist = getRequirementChecklist(password || '');

  return (
    <div className={styles.meter}>
      <div className={styles.segments} role="img" aria-label={hasValue ? `Password strength: ${label}` : 'Password strength'}>
        {SCORE_COLORS.map((_, index) => (
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
