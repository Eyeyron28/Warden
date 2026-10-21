import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import AppLayout from './components/AppLayout.jsx';
import { AppFrameSkeleton } from './components/Skeletons.jsx';
import PublicLayout from './components/site/PublicLayout.jsx';
import HomePage from './pages/public/HomePage.jsx';
import { logoutVault } from './services/authService.js';
import { adoptTokenFromOtherTabs, clearToken, expireSession, getToken } from './services/session.js';
import { getMe } from './services/authService.js';
import { JUST_ASKED_MS } from './services/dataCache.js';
import { checkStoredSession } from './services/sessionCheck.js';
import { transfers } from './services/transfers.js';
import { forgetPreviousVisit } from './services/sessionReset.js';
import { visitMemory } from './services/visitMemory.js';
import { useSessionToken } from './utils/useSessionToken.js';
import { getEmergencyMode, setModeFromMe, subscribeEmergencyMode, wasEmergencyTab } from './services/emergencyMode.js';

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
const StarredPage = lazy(() => import('./pages/StarredPage.jsx'));
const RecentPage = lazy(() => import('./pages/RecentPage.jsx'));
const AccountPage = lazy(() => import('./pages/AccountPage.jsx'));
const ExportPage = lazy(() => import('./pages/ExportPage.jsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.jsx'));
const OverviewPage = lazy(() => import('./pages/OverviewPage.jsx'));
const QuarantinePage = lazy(() => import('./pages/QuarantinePage.jsx'));
const ExpiredPage = lazy(() => import('./pages/OverviewPage.jsx').then((m) => ({ default: m.ExpiredPage })));
const WasntMePage = lazy(() => import('./pages/auth/WasntMePage.jsx'));
const EmergencyAccessPage = lazy(() => import('./pages/EmergencyAccessPage.jsx'));
const EmergencyContactPage = lazy(() => import('./pages/EmergencyContactPage.jsx'));
const EmergencyShell = lazy(() => import('./components/emergency/EmergencyShell.jsx'));
const SharesPage = lazy(() => import('./pages/SharesPage.jsx'));
const SharedDocumentPage = lazy(() => import('./pages/SharedDocumentPage.jsx'));

function RequireSession({ children }) {
  const token = useSessionToken();
  const location = useLocation();
  const ready = useSessionCheck();
  useEffect(() => {
    if (token) visitMemory.trackVisit(`${location.pathname}${location.search}`);
  }, [token, location.pathname, location.search]);
  if (!ready) return <AppFrameSkeleton />;
  if (!token && wasEmergencyTab()) return <Navigate to="/emergency?ended=1" replace />;
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function SignedInShell({ onLocked }) {
  const mode = useSyncExternalStore(subscribeEmergencyMode, getEmergencyMode);
  return mode.emergency ? (
    <Suspense fallback={<AppFrameSkeleton />}>
      <EmergencyShell />
    </Suspense>
  ) : (
    <AppLayout onLocked={onLocked} />
  );
}

let sessionCheck = null;
function checkSessionOnce() {
  if (!sessionCheck) {
    sessionCheck = checkStoredSession({ getToken, adoptFromOtherTabs: adoptTokenFromOtherTabs, verify: async () => setModeFromMe(await getMe({ maxAgeMs: JUST_ASKED_MS })), expire: expireSession });
  }
  return sessionCheck;
}

function LandingGate({ children }) {
  const token = useSessionToken();
  const mode = useSyncExternalStore(subscribeEmergencyMode, getEmergencyMode);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(getToken() || adoptTokenFromOtherTabs())
      .then((held) => held && checkSessionOnce())
      .then((outcome) => !cancelled && setResult(outcome));
    return () => {
      cancelled = true;
    };
  }, []);
  if (token && !mode.emergency && result === 'valid') return <Navigate to="/files" replace />;
  return children;
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
  const handleLocked = useCallback(
    () =>
      transfers.requestSignOut(async () => {
        try {
          await logoutVault();
        } catch {
        } finally {
          forgetPreviousVisit({ reason: 'signout' });
          clearToken();
        }
      }, { confirm: true }),
    []
  );

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<LandingGate><HomePage /></LandingGate>} />
          <Route path="about" element={<Navigate to="/" replace />} />
          <Route path="contact" element={<Navigate to="/#contact" replace />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="wasnt-me" element={<WasntMePage />} />
          <Route path="emergency" element={<EmergencyContactPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        <Route
          element={
            <RequireSession>
              <SignedInShell onLocked={handleLocked} />
            </RequireSession>
          }
        >
          <Route path="/files" element={<FilesPage />} />
          <Route path="/photos" element={<PhotosPage />} />
          <Route path="/shared" element={<SharesPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/starred" element={<StarredPage />} />
          <Route path="/recent" element={<RecentPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/emergency-access" element={<EmergencyAccessPage />} />
          <Route path="/quarantine" element={<QuarantinePage />} />
          <Route path="/expired" element={<ExpiredPage />} />
        </Route>
        <Route path="/vault" element={<Navigate to="/files" replace />} />
        <Route path="/shares" element={<Navigate to="/shared" replace />} />
        <Route path="/shared/:shareId" element={<SharedDocumentPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
