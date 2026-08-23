import axios from 'axios';

import { getToken, clearToken } from './session.js';

const baseURL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const api = axios.create({
  baseURL: `${baseURL}/api`,
});
// No default Content-Type here: axios infers "application/json" for plain
// object payloads and the correct multipart boundary for FormData on its
// own. Forcing one globally would break document uploads.

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Session expired, was invalidated, or never existed. Clearing it
      // here (rather than in every caller) is what lets the app fall
      // back to the LockScreen from any authenticated call, globally.
      clearToken();
    }
    return Promise.reject(error);
  }
);

/**
 * Pulls the backend's `{ error: { message } }` shape out of a failed
 * axios call, falling back to a generic message for network errors etc.
 */
export function extractErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  return error?.response?.data?.error?.message || fallback;
}

export default api;
