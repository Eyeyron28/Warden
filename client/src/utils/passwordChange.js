import { validatePassword } from './passwordPolicy.js';

export function changePasswordErrors({ current, next, confirm }) {
  const errors = {};
  if (!current) errors.current = 'Enter your current password.';
  if (!validatePassword(next).valid) errors.next = 'This password doesn’t meet every requirement below yet.';
  else if (next === current) errors.next = 'Your new password must be different from your current password.';
  if (!confirm || confirm !== next) errors.confirm = 'The two passwords don’t match.';
  return errors;
}

export function startFailureMessage(error) {
  const status = error?.response?.status;
  const message = error?.response?.data?.error?.message || error?.response?.data?.message || '';
  if (status === 401) return 'That is not your current password.';
  if (status === 400 && error?.response?.data?.error?.errors) return 'The new password does not meet the requirements below.';
  if (status === 400 && message) return message;
  if (status === 429 && message) return message;
  return 'Could not start the password change. Please try again.';
}
