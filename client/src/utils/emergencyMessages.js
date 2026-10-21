export const NEUTRAL_CODE_MESSAGE = 'If these details match an active setup, we sent a code to the contact’s email.';
export const GENERIC_FAILURE = 'That didn’t work. Check the details and try again.';
export const THROTTLED_MESSAGE = 'Too many attempts. Please wait a while and try again.';
export const ONLY_IF_SETUP_NOTE = 'This only works if the owner set up Emergency Access for you.';

export function publicFailureMessage(error) {
  const status = error?.response?.status;
  if (status === 429) {
    const text = error?.response?.data?.error?.message;
    return typeof text === 'string' && /24 hours/.test(text) ? text : THROTTLED_MESSAGE;
  }
  const code = error?.response?.data?.error?.code;
  if (status === 409 && code === 'NOT_YET') return 'The waiting period has not ended yet. Come back after the time we showed you.';
  if (status === 410) return 'The time to open the vault has passed. You can make a new request.';
  if (status === 503) return 'We could not process your request right now. Please try again later; you will need to ask for a new code.';
  return GENERIC_FAILURE;
}

export function requestSentText(releaseAt, formatWhen) {
  return `Your request was sent. Access can be available on ${formatWhen(releaseAt)}. Come back to this page then.`;
}
