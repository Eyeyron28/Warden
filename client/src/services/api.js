import axios from 'axios';

import { getToken, clearToken, expireSession } from './session.js';
import { invalidateAll } from './dataCache.js';

const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

const isWrite = (config) => Boolean(config?.method) && String(config.method).toLowerCase() !== 'get';

api.interceptors.response.use(
  (response) => {
    if (isWrite(response.config)) invalidateAll();
    return response;
  },
  (error) => {
    if (isWrite(error.config)) invalidateAll();
    if (error.response?.status === 401) {
      const sessionProblem = error.response?.data?.error?.code === 'SESSION_INVALID';
      if (!error.config?.skipSessionClear || sessionProblem) {
        if (getToken()) expireSession();
        else clearToken();
      }
    }
    return Promise.reject(error);
  }
);

export function extractErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  const apiError = error?.response?.data?.error;
  if (Array.isArray(apiError?.errors) && apiError.errors.length > 0) {
    return apiError.errors.join(' ');
  }
  return apiError?.message || fallback;
}

export default api;
