import api from './api.js';

export async function listDevices() {
  const { data } = await api.get('/security/devices');
  return data.devices;
}

export async function signOutDevice(id) {
  const { data } = await api.post(`/security/devices/${id}/sign-out`);
  return data;
}

export async function forgetTrustedDevice(id) {
  const { data } = await api.post(`/security/devices/${id}/forget-trusted`);
  return data;
}

export async function signOutOtherDevices({ forgetTrusted = false } = {}) {
  const { data } = await api.post('/security/devices/sign-out-others', { forgetTrusted });
  return data;
}

export async function getActivity(filters = {}) {
  const params = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params[key] = value === true ? '1' : value;
  }
  const { data } = await api.get('/security/activity', { params });
  return data;
}

export async function verifyActivityLog() {
  const { data } = await api.post('/security/verify-log');
  return data;
}

export async function reportClientEvent(type) {
  try {
    await api.post('/security/client-event', { type });
  } catch {
  }
}
