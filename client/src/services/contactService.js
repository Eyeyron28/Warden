import api from './api.js';

export async function sendContactMessage({ name, email, message, website }) {
  const { data } = await api.post('/contact', { name: name.trim(), email: email.trim(), message: message.trim(), website }, { skipSessionClear: true });
  return data;
}

export function contactFailureMessage(error) {
  const status = error?.response?.status;
  if (status === 429) return 'Too many messages just now. Please try again in an hour.';
  if (status === 400) return error?.response?.data?.error?.message || 'Please check your name, email and message.';
  if (!error?.response) return 'We couldn’t reach the server. Check your connection and try again.';
  return 'The message could not be sent. Please try again.';
}
