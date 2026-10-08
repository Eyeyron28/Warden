import SensitiveInput from '../../components/SensitiveInput.jsx';
import PasswordStrengthMeter from '../../components/PasswordStrengthMeter.jsx';
import { validatePassword } from '../../utils/passwordPolicy.js';
import { formatRecoveryKeyInput, recoveryKeyProblem } from '../../utils/passwordReset.js';
import PasswordInput from './PasswordInput.jsx';
import forms from '../../components/site/forms.module.css';

/**
 * The recovery-key box: paste-friendly (spaces, dashes and case are sorted out as
 * it is typed), monospace, no autofill (autocomplete="off"), no spell-check.
 */
export function RecoveryKeyField({ id, value, onChange, onBlur, error, touched, autoFocus = false, label = 'Recovery key' }) {
  const problem = touched ? recoveryKeyProblem(value) : '';
  const shown = error || problem;
  return (
    <div className={forms.field}>
      <label htmlFor={id} className={forms.label}>
        {label}
      </label>
      <SensitiveInput
        fieldName="recovery-secret"
        id={id}
        className={`${forms.input} ${forms.mono}`}
        value={value}
        onChange={(event) => onChange(formatRecoveryKeyInput(event.target.value))}
        onBlur={onBlur}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoFocus={autoFocus}
        maxLength={40}
        aria-invalid={Boolean(shown)}
        aria-describedby={`${id}-hint ${id}-error`}
      />
      <p id={`${id}-hint`} className={`${forms.hint} ${forms.hintOptional}`}>
        The 16-character key you saved when you signed up. Paste it as it is; spaces, dashes and capital letters don’t
        matter.
      </p>
      <p id={`${id}-error`} className={forms.error} aria-live="polite">
        {shown}
      </p>
    </div>
  );
}

/** New password + confirmation, with the strength rules. `idPrefix` keeps ids unique per screen. */
export function NewPasswordFields({ idPrefix, password, confirm, onPassword, onConfirm, touched, onTouch, passwordError }) {
  const passwordOk = passwordIsValid(password);
  const confirmOk = confirm.length > 0 && confirm === password;
  return (
    <>
      {/* Side by side on a desktop landscape window; the rules sit under both. */}
      <div className={forms.row2}>
        <PasswordInput
          id={`${idPrefix}-password`}
          label="New password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          onBlur={() => onTouch('password')}
          error={passwordError || (touched.password && !passwordOk ? 'This password doesn’t meet every requirement below yet.' : '')}
          autoComplete="new-password"
          describedBy={`${idPrefix}-rules`}
        />
        <PasswordInput
          id={`${idPrefix}-confirm`}
          label="Confirm new password"
          value={confirm}
          onChange={(event) => onConfirm(event.target.value)}
          onBlur={() => onTouch('confirm')}
          error={touched.confirm && !confirmOk ? 'The two passwords don’t match.' : ''}
          autoComplete="new-password"
        />
      </div>
      <div id={`${idPrefix}-rules`}>
        <PasswordStrengthMeter password={password} />
      </div>
    </>
  );
}

export function passwordIsValid(password) {
  return validatePassword(password).valid;
}
