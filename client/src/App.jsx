import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import AppLayout from './components/AppLayout.jsx';
import PublicLayout from './components/site/PublicLayout.jsx';
import HomePage from './pages/public/HomePage.jsx';
import { logoutVault } from './services/authService.js';
import { adoptTokenFromOtherTabs, clearToken, expireSession, getToken } from './services/session.js';
import { getMe } from './services/authService.js';
import { checkStoredSession } from './services/sessionCheck.js';
import { useSessionToken } from './utils/useSessionToken.js';

// Every route except the home page is its own chunk, so the landing page
// downloads only what it shows. Home itself is imported eagerly - it's the
// first thing most visitors see, and a spinner there would cost more than
// the bytes it saves.
const PrivacyPage = lazy(() => import('./pages/public/PrivacyPage.jsx'));
const TermsPage = lazy(() => import('./pages/public/TermsPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/public/NotFoundPage.jsx'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage.jsx'));
const SignupPage = lazy(() => import('./pages/auth/SignupPage.jsx'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage.jsx'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage.jsx'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage.jsx'));
const FilesPage = lazy(() => import('./pages/FilesPage.jsx'));
const PhotosPage = lazy(() => import('./pages/PhotosPage.jsx'));
const TrashPage = lazy(() => import('./pages/TrashPage.jsx'));
const AccountPage = lazy(() => import('./pages/AccountPage.jsx'));
const ExportPage = lazy(() => import('./pages/ExportPage.jsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.jsx'));
const OverviewPage = lazy(() => import('./pages/OverviewPage.jsx'));
const WasntMePage = lazy(() => import('./pages/auth/WasntMePage.jsx'));
const SharesPage = lazy(() => import('./pages/SharesPage.jsx'));
const SharedDocumentPage = lazy(() => import('./pages/SharedDocumentPage.jsx'));

/**
 * The vault needs a session. Without one - never logged in, "Lock
 * vault", or a session that expired mid-use (the axios 401 interceptor
 * clears the token) - send the person to /login, remembering where they
 * were so login can bring them straight back.
 */
function RequireSession({ children }) {
  const token = useSessionToken();
  const location = useLocation();
  const ready = useSessionCheck();
  // A token kept from before a reload (or handed over by another tab) is proved with the server first, so a
  // dead one sends you to the login page with a message instead of a screen full of failed requests.
  if (!ready) return null;
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

// Checked once per page load, shared by every route that needs the session (services/sessionCheck.js).
let sessionCheck = null;
function checkSessionOnce() {
  if (!sessionCheck) {
    sessionCheck = checkStoredSession({ getToken, adoptFromOtherTabs: adoptTokenFromOtherTabs, verify: getMe, expire: expireSession });
  }
  return sessionCheck;
}

function useSessionCheck() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    checkSessionOnce().finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

function App() {
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
    <Suspense fallback={null}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<HomePage />} />
          {/* About and Contact are sections of the one-page landing site now;
              the old URLs still work and land on the right section. */}
          <Route path="about" element={<Navigate to="/#about" replace />} />
          <Route path="contact" element={<Navigate to="/#contact" replace />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="wasnt-me" element={<WasntMePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* The signed-in app: header + sidebar around one real route per section,
            so refresh and the back button work. A reload ends the session by
            design, and login brings you back to the route you were on. */}
        <Route
          element={
            <RequireSession>
              <AppLayout onLocked={handleLocked} />
            </RequireSession>
          }
        >
          <Route path="/files" element={<FilesPage />} />
          <Route path="/photos" element={<PhotosPage />} />
          <Route path="/shared" element={<SharesPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/account" element={<AccountPage />} />
        </Route>
        <Route path="/vault" element={<Navigate to="/files" replace />} />
        <Route path="/shares" element={<Navigate to="/shared" replace />} />
        {/* Outside the account flow entirely: a share-link recipient has
            never logged into this account and never will. */}
        <Route path="/shared/:shareId" element={<SharedDocumentPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
