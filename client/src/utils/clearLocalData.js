import { clearToken } from '../services/session.js';

export function clearLocalData() {
  clearToken();
}
