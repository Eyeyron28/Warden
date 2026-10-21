const FLAG_KEY = 'warden.emergencyMode';

let state = { emergency: false, endsAt: null, scopeMode: null, scopeFolders: null };
const listeners = new Set();

const notify = () => listeners.forEach((listener) => listener());

function readFlag() {
  try {
    return window.sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(on) {
  try {
    if (on) window.sessionStorage.setItem(FLAG_KEY, '1');
    else window.sessionStorage.removeItem(FLAG_KEY);
  } catch {
  }
}

export const getEmergencyMode = () => state;
export const subscribeEmergencyMode = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setModeFromMe(me) {
  const emergency = me?.emergency === true;
  state = emergency ? { ...state, emergency: true, endsAt: me.endsAt ?? state.endsAt, scopeMode: me.scopeMode ?? null } : { emergency: false, endsAt: null, scopeMode: null, scopeFolders: null };
  writeFlag(emergency);
  notify();
}

export function enterEmergencyMode({ endsAt, scope }) {
  state = { emergency: true, endsAt: endsAt ?? null, scopeMode: scope?.mode ?? null, scopeFolders: scope?.folders ?? null };
  writeFlag(true);
  notify();
}

export function applySessionInfo(info) {
  state = { ...state, emergency: true, endsAt: info?.expiresAt ?? state.endsAt, scopeMode: info?.scopeSummary?.mode ?? state.scopeMode, scopeFolders: info?.scopeSummary?.folders ?? state.scopeFolders };
  notify();
}

export const wasEmergencyTab = () => readFlag();

export function leaveEmergencyMode({ keepFlag = false } = {}) {
  state = { emergency: false, endsAt: null, scopeMode: null, scopeFolders: null };
  if (!keepFlag) writeFlag(false);
  notify();
}

export const clearEmergencyFlag = () => writeFlag(false);
