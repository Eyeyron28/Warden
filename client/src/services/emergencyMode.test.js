import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySessionInfo,
  clearEmergencyFlag,
  enterEmergencyMode,
  getEmergencyMode,
  leaveEmergencyMode,
  setModeFromMe,
  subscribeEmergencyMode,
  wasEmergencyTab,
} from './emergencyMode.js';

function fakeWindow() {
  const store = new Map();
  return {
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => void store.set(key, String(value)),
      removeItem: (key) => void store.delete(key),
    },
    store,
  };
}

test('an emergency token is recognised from /auth/me, remembered for the "ended" screen, and a normal one clears it', () => {
  globalThis.window = fakeWindow();
  const seen = [];
  const stop = subscribeEmergencyMode(() => seen.push(getEmergencyMode().emergency));

  setModeFromMe({ emergency: true, readOnly: true, scopeMode: 'folders', endsAt: '2026-10-09T12:00:00Z' });
  assert.equal(getEmergencyMode().emergency, true);
  assert.equal(getEmergencyMode().scopeMode, 'folders');
  assert.equal(getEmergencyMode().endsAt, '2026-10-09T12:00:00Z');
  assert.equal(wasEmergencyTab(), true);

  setModeFromMe({ email: 'owner@example.com', emailVerified: true });
  assert.equal(getEmergencyMode().emergency, false);
  assert.equal(wasEmergencyTab(), false);
  assert.deepEqual(seen, [true, false]);
  stop();
});

test('starting a session enters the mode; the server’s session-info refines it; leaving can keep the "ended" flag; it holds no secret', () => {
  const win = (globalThis.window = fakeWindow());
  enterEmergencyMode({ endsAt: '2026-10-09T12:00:00Z', scope: { mode: 'folders', folders: ['2024'] } });
  assert.equal(getEmergencyMode().emergency, true);
  assert.deepEqual(getEmergencyMode().scopeFolders, ['2024']);
  applySessionInfo({ readOnly: true, expiresAt: '2026-10-09T11:30:00Z', scopeSummary: { mode: 'folders', folders: ['2024'] } });
  assert.equal(getEmergencyMode().endsAt, '2026-10-09T11:30:00Z');

  // the only thing stored is a flag, never a token, kit or name
  assert.deepEqual([...win.store.entries()], [['warden.emergencyMode', '1']]);

  leaveEmergencyMode({ keepFlag: true });
  assert.equal(getEmergencyMode().emergency, false);
  assert.equal(wasEmergencyTab(), true, 'so the ended screen can say so after a reload');
  clearEmergencyFlag();
  assert.equal(wasEmergencyTab(), false);
  leaveEmergencyMode();
  assert.equal(win.store.size, 0);
});

test('a blocked sessionStorage is not an error', () => {
  globalThis.window = {
    get sessionStorage() {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => enterEmergencyMode({ endsAt: null, scope: null }));
  assert.equal(wasEmergencyTab(), false);
  assert.equal(getEmergencyMode().emergency, true);
  leaveEmergencyMode();
});
