import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import PublicLayout from './components/site/PublicLayout.jsx';
import HomePage from './pages/public/HomePage.jsx';
import { logoutVault } from './services/authService.js';
import { clearToken } from './services/session.js';
import { isPhoneDevice } from './utils/deviceDetection.js';
import { useSessionToken } from './utils/useSessionToken.js';

// Every route except the home page is its own chunk, so the landing page
// downloads only what it shows. Home itself is imported eagerly - it's the
// first thing most visitors see, and a spinner there would cost more than
// the bytes it saves.
const AboutPage = lazy(() => import('./pages/public/AboutPage.jsx'));
const ContactPage = lazy(() => import('./pages/public/ContactPage.jsx'));
const PrivacyPage = lazy(() => import('./pages/public/PrivacyPage.jsx'));
const TermsPage = lazy(() => import('./pages/public/TermsPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/public/NotFoundPage.jsx'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage.jsx'));
const SignupPage = lazy(() => import('./pages/auth/SignupPage.jsx'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage.jsx'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage.jsx'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage.jsx'));
const VaultShell = lazy(() => import('./pages/VaultShell.jsx'));
const SharedDocumentPage = lazy(() => import('./pages/SharedDocumentPage.jsx'));
const PairPage = lazy(() => import('./pages/PairPage.jsx'));
const PhoneVault = lazy(() => import('./pages/PhoneVault.jsx'));

/**
 * "/" is the public home page for everyone - except a phone that has
 * already been paired in this browser, which still goes straight to its
 * own PIN-unlocked vault at /phone, as before. Any other phone sees the
 * landing page and can log in normally.
 */
function RootRoute() {
  const [isPhone] = useState(isPhoneDevice);
  const [paired, setPaired] = useState(isPhone ? null : false);

  useEffect(() => {
    if (!isPhone) return undefined;
    let cancelled = false;
    // Loaded on demand: only phones need IndexedDB here, so the landing
    // page's own bundle doesn't carry it.
    import('./services/localVault.js')
      .then(({ getAllDeviceAuth }) => getAllDeviceAuth())
      .then((records) => !cancelled && setPaired(records.length > 0))
      .catch(() => !cancelled && setPaired(false));
    return () => {
      cancelled = true;
    };
  }, [isPhone]);

  if (paired === null) return null; // a few ms while IndexedDB answers
  if (paired) return <Navigate to="/phone" replace />;
  return <HomePage />;
}

/**
 * The vault needs a session. Without one - never logged in, "Lock
 * vault", or a session that expired mid-use (the axios 401 interceptor
 * clears the token) - send the person to /login, remembering where they
 * were so login can bring them straight back.
 */
function RequireSession({ children }) {
  const token = useSessionToken();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
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
          <Route index element={<RootRoute />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="contact" element={<ContactPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        <Route
          path="/vault"
          element={
            <RequireSession>
              <VaultShell onLocked={handleLocked} />
            </RequireSession>
          }
        />
        {/* Outside the account flow entirely: a share-link recipient has
            never logged into this account and never will. */}
        <Route path="/shared/:token" element={<SharedDocumentPage />} />
        {/* Same reasoning: a phone opening a pairing QR has no session. */}
        <Route path="/pair/:token" element={<PairPage />} />
        {/* The phone's own local vault, unlocked with its paired PIN and
            backed by IndexedDB, not a PC session at all. */}
        <Route path="/phone" element={<PhoneVault />} />
      </Routes>
    </Suspense>
  );
}

export default App;
