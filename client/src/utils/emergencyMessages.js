/**
 * The public Emergency Access page speaks in one voice whoever is asking: the same confirmation for a code
 * request, the same single failure message for everything that did not work. (The server answers the same way;
 * this keeps the screen from adding anything of its own.)
 */

export const NEUTRAL_CODE_MESSAGE = 'If these details match an active setup, we sent a code to the contact’s email.';
export const GENERIC_FAILURE = 'That didn’t work. Check the details and try again.';
export const THROTTLED_MESSAGE = 'Too many attempts. Please wait a while and try again.';
export const ONLY_IF_SETUP_NOTE = 'This only works if the owner set up Emergency Access for you.';

/**
 * Any error from the public endpoints -> the one message to show. Only a rate limit (429) says something different
 * for everybody alike; every other status, a network error included, is the same generic line EXCEPT the three
 * answers the server gives only to someone who has proved who they are (not yet, cooldown, expired).
 */
export function publicFailureMessage(error) {
  const status = error?.response?.status;
  if (status === 429) {
    const text = error?.response?.data?.error?.message;
    // The 24-hour cooldown is only ever said to a person who has already passed the kit and code checks.
    return typeof text === 'string' && /24 hours/.test(text) ? text : THROTTLED_MESSAGE;
  }
  const code = error?.response?.data?.error?.code;
  if (status === 409 && code === 'NOT_YET') return 'The waiting period has not ended yet. Come back after the time we showed you.';
  if (status === 410) return 'The time to open the vault has passed. You can make a new request.';
  return GENERIC_FAILURE;
}

/** What to show after a request went through. `formatWhen` renders the time in Asia/Manila. */
export function requestSentText(releaseAt, formatWhen) {
  return `Your request was sent. Access can be available on ${formatWhen(releaseAt)}. Come back to this page then.`;
}
