import { useEffect, useState } from 'react';
import { Navigate, NavLink, useLocation } from 'react-router-dom';
import { FolderSimple, Lifebuoy, SignOut } from '@phosphor-icons/react';

import wardenLogo from '../../assets/warden_logo_badge.svg';
import ThemeToggle from '../ThemeToggle.jsx';
import EmergencyFilesPage from '../../pages/EmergencyFilesPage.jsx';
import { logoutVault } from '../../services/authService.js';
import { applySessionInfo, getEmergencyMode, leaveEmergencyMode, subscribeEmergencyMode } from '../../services/emergencyMode.js';
import { getSessionInfo } from '../../services/emergencyService.js';
import { clearToken, expireSession } from '../../services/session.js';
import { forgetPreviousVisit } from '../../services/sessionReset.js';
import { EMERGENCY_NAV, emergencyRedirect, sessionBannerText } from '../../utils/emergencyMode.js';
import { formatManila } from '../../utils/activityText.js';
import styles from './EmergencyShell.module.css';

function useEmergencyState() {
  const [state, setState] = useState(getEmergencyMode());
  useEffect(() => subscribeEmergencyMode(() => setState(getEmergencyMode())), []);
  return state;
}

function EmergencyShell() {
  const location = useLocation();
  const mode = useEmergencyState();

  useEffect(() => {
    getSessionInfo().then(applySessionInfo).catch(() => {});
  }, []);

  useEffect(() => {
    if (!mode.endsAt) return undefined;
    const wait = new Date(mode.endsAt).getTime() - Date.now();
    if (wait <= 0 || wait > 2 ** 31 - 1) return undefined;
    const timer = setTimeout(() => {
      leaveEmergencyMode({ keepFlag: true });
      expireSession('Emergency access has ended.');
    }, wait);
    return () => clearTimeout(timer);
  }, [mode.endsAt]);

  const redirect = emergencyRedirect(location.pathname);
  if (redirect) return <Navigate to={redirect} replace />;

  const signOut = async () => {
    try {
      await logoutVault();
    } catch {
    } finally {
      forgetPreviousVisit({ reason: 'signout' });
      clearToken();
    }
  };

  return (
    <div className={styles.shell} data-emergency-mode>
      <header className={styles.header}>
        <div className={styles.brand}>
          <img src={wardenLogo} alt="Warden" className={styles.mark} />
          <span className={styles.wordmark}>WARDEN</span>
        </div>
        <div className={styles.actions}>
          <ThemeToggle />
          <button type="button" className={styles.signOut} onClick={signOut}>
            <SignOut size={16} weight="bold" />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <div className={styles.banner} role="status" data-testid="emergency-session-banner">
        <Lifebuoy size={20} weight="fill" aria-hidden="true" />
        <p>{sessionBannerText(mode.endsAt, (value) => formatManila(value))}</p>
      </div>

      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Main">
          {EMERGENCY_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`}>
              <FolderSimple size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <button type="button" className={styles.item} onClick={signOut}>
            <SignOut size={20} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </nav>
        <main className={styles.content}>
          <EmergencyFilesPage />
        </main>
      </div>
    </div>
  );
}

export default EmergencyShell;
