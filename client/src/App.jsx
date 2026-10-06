import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import LockScreen from './pages/LockScreen.jsx';
import VaultShell from './pages/VaultShell.jsx';
import SharedDocumentPage from './pages/SharedDocumentPage.jsx';
import PairPage from './pages/PairPage.jsx';
import PhoneVault from './pages/PhoneVault.jsx';
import VerifyEmailPage from './pages/VerifyEmailPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import { logoutVault } from './services/authService.js';
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
 */
function RootRoute({ sessionToken, onAuthenticated }) {
  const [isPhone] = useState(isPhoneDevice);

  if (isPhone) {
    return <Navigate to="/phone" replace />;
  }

  if (sessionToken) {
    return <Navigate to="/vault" replace />;
  }

  return <LockScreen onAuthenticated={onAuthenticated} />;
}

function App() {
  const [sessionToken, setSessionToken] = useState(getToken());

  // Mirrors the module-level session token (set by axios's 401 interceptor
  // as well as explicit auth actions) into React state so routing reacts
  // to it.
  useEffect(() => subscribeToken(setSessionToken), []);

  const handleAuthenticated = useCallback((nextToken) => {
    setToken(nextToken);
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
        element={<RootRoute sessionToken={sessionToken} onAuthenticated={handleAuthenticated} />}
      />
      <Route
        path="/vault"
        element={sessionToken ? <VaultShell onLocked={handleLocked} /> : <Navigate to="/" replace />}
      />
      {/* Deliberately outside the auth flow above: no sessionToken check, no
          LockScreen/VaultShell involved at all. A recipient opening a share
          link has never logged into this account and never will. */}
      <Route path="/shared/:token" element={<SharedDocumentPage />} />
      {/* Same reasoning as /shared/:token above: this runs on a phone that
          has never logged in (or even seen) this account before, so it
          can't depend on any of the session/auth state the routes above
          use. */}
      <Route path="/pair/:token" element={<PairPage />} />
      {/* Also outside the auth flow, for the same reason: this is the
          phone's own local vault, unlocked with its paired PIN and backed
          by IndexedDB, not a PC session at all. */}
      <Route path="/phone" element={<PhoneVault />} />
      {/* Email-link landing pages - the token in the URL is the only
          credential either one needs, same trust model as /shared/:token. */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
