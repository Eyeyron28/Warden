/**
 * Whether THIS tab's session is an Emergency Access session, and what it may be told about itself.
 *
 * The truth comes from the server (GET /api/auth/me answers { emergency: true, readOnly: true, scopeMode, endsAt } for
 * an emergency token), so a reload cannot turn a read-only session into a full one. The only thing remembered
 * across a reload is a flag that "this tab was in emergency mode" so that when the session ends the contact sees
 * "Emergency access ended" instead of the owner's sign-in page. The flag holds no secret.
 */

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
    // the "ended" screen just falls back to the sign-in page
  }
}

export const getEmergencyMode = () => state;
export const subscribeEmergencyMode = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** From GET /auth/me: an emergency token says so; a normal one clears the mode. */
export function setModeFromMe(me) {
  const emergency = me?.emergency === true;
  state = emergency ? { ...state, emergency: true, endsAt: me.endsAt ?? state.endsAt, scopeMode: me.scopeMode ?? null } : { emergency: false, endsAt: null, scopeMode: null, scopeFolders: null };
  writeFlag(emergency);
  notify();
}

/** From POST /emergency/public/start-session, before the first /me. */
export function enterEmergencyMode({ endsAt, scope }) {
  state = { emergency: true, endsAt: endsAt ?? null, scopeMode: scope?.mode ?? null, scopeFolders: scope?.folders ?? null };
  writeFlag(true);
  notify();
}

/** From GET /emergency/session-info (the authoritative end time and scope names). */
export function applySessionInfo(info) {
  state = { ...state, emergency: true, endsAt: info?.expiresAt ?? state.endsAt, scopeMode: info?.scopeSummary?.mode ?? state.scopeMode, scopeFolders: info?.scopeSummary?.folders ?? state.scopeFolders };
  notify();
}

/** True when this tab was in emergency mode (kept across the reload so an ended session says so). */
export const wasEmergencyTab = () => readFlag();

export function leaveEmergencyMode({ keepFlag = false } = {}) {
  state = { emergency: false, endsAt: null, scopeMode: null, scopeFolders: null };
  if (!keepFlag) writeFlag(false);
  notify();
}

export const clearEmergencyFlag = () => writeFlag(false);
