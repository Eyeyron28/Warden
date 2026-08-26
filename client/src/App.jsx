import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import LockScreen from './pages/LockScreen.jsx';
import VaultShell from './pages/VaultShell.jsx';
import SharedDocumentPage from './pages/SharedDocumentPage.jsx';
import PairPage from './pages/PairPage.jsx';
import DevLocalVault from './pages/DevLocalVault.jsx';
import { getAuthStatus, logoutVault } from './services/authService.js';
import { getToken, setToken, clearToken, subscribeToken } from './services/session.js';

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
          sessionToken ? (
            <Navigate to="/vault" replace />
          ) : (
            <LockScreen
              statusLoading={statusLoading}
              initialized={initialized}
              onAuthenticated={handleAuthenticated}
            />
          )
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
      {/* TEMPORARY, dev-build-only: excluded from production entirely via
          import.meta.env.DEV, so it never ships in the installable app.
          Remove this route along with pages/DevLocalVault.jsx once real
          pairing/sync replaces it in the next pass. */}
      {import.meta.env.DEV && (
        <Route path="/dev/local-vault" element={<DevLocalVault />} />
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
