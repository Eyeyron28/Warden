import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import LockScreen from './pages/LockScreen.jsx';
import VaultShell from './pages/VaultShell.jsx';
import SharedDocumentPage from './pages/SharedDocumentPage.jsx';
import PairPage from './pages/PairPage.jsx';
import PhoneVault from './pages/PhoneVault.jsx';
import { getAuthStatus, logoutVault } from './services/authService.js';
import { getToken, setToken, clearToken, subscribeToken } from './services/session.js';
import { isPhoneDevice } from './utils/deviceDetection.js';

/**
 * Root route ("/"): a phone should never drive the live PC session
 * (LockScreen/VaultShell) directly - it always has its own local,
 * PIN-unlocked experience at /phone instead. useState's lazy initializer
 * runs the phone check exactly once, on this component's initial mount,
 * so resizing an already-open desktop window narrower afterward can
 * never trigger it - only the device this route is FIRST opened on
 * decides the redirect.
 *
 * Deliberate tradeoff, not an oversight: this means first-time vault
 * SETUP (the very first LockScreen visit, before any account exists) can
 * now only be done from a PC/desktop browser. A phone always bounces to
 * /phone, which requires an already-paired device to do anything at all -
 * there is no path for a phone to run initial setup.
 */
function RootRoute({ sessionToken, statusLoading, initialized, onAuthenticated }) {
  const [isPhone] = useState(isPhoneDevice);

  if (isPhone) {
    return <Navigate to="/phone" replace />;
  }

  if (sessionToken) {
    return <Navigate to="/vault" replace />;
  }

  return (
    <LockScreen
      statusLoading={statusLoading}
      initialized={initialized}
      onAuthenticated={onAuthenticated}
    />
  );
}

function App() {
  const [statusLoading, setStatusLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [sessionToken, setSessionToken] = useState(getToken());

  // Mirrors the module-level session token (set by axios's 401 interceptor
  // as well as explicit auth actions) into React state so routing reacts
  // to it.
  useEffect(() => subscribeToken(setSessionToken), []);

  useEffect(() => {
    let cancelled = false;

    getAuthStatus()
      .then((data) => {
        if (!cancelled) setInitialized(data.initialized);
      })
      .catch(() => {
        // Backend unreachable: fall back to the unlock screen rather than
        // getting stuck on a loading state forever.
        if (!cancelled) setInitialized(false);
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = useCallback((nextToken) => {
    setToken(nextToken);
    setInitialized(true);
  }, []);

  const handleLocked = useCallback(async () => {
    try {
      await logoutVault();
    } catch {
      // Locking the vault should never get the user stuck - worst case is
      // an orphaned server-side session that expires naturally in 30 min.
    } finally {
      clearToken();
    }
  }, []);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <RootRoute
            sessionToken={sessionToken}
            statusLoading={statusLoading}
            initialized={initialized}
            onAuthenticated={handleAuthenticated}
          />
        }
      />
      <Route
        path="/vault"
        element={sessionToken ? <VaultShell onLocked={handleLocked} /> : <Navigate to="/" replace />}
      />
      {/* Deliberately outside the auth flow above: no sessionToken check, no
          LockScreen/VaultShell involved at all. A recipient opening a share
          link has never unlocked this vault and never will. */}
      <Route path="/shared/:token" element={<SharedDocumentPage />} />
      {/* Same reasoning as /shared/:token above: this runs on a phone that
          has never unlocked (or even seen) this vault before, so it can't
          depend on any of the session/auth state the routes above use. */}
      <Route path="/pair/:token" element={<PairPage />} />
      {/* Also outside the auth flow, for the same reason: this is the
          phone's own local vault, unlocked with its paired PIN and backed
          by IndexedDB, not a PC session at all. */}
      <Route path="/phone" element={<PhoneVault />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
