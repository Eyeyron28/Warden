import { useEffect, useState } from 'react';
import { Navigate, NavLink, useLocation } from 'react-router-dom';
import { FolderSimple, Lifebuoy, SignOut } from '@phosphor-icons/react';

import wardenLogo from '../../assets/warden_logo_badge.svg';
import ThemeToggle from '../ThemeToggle.jsx';
import EmergencyFilesPage from '../../pages/EmergencyFilesPage.jsx';
import { logoutVault } from '../../services/authService.js';
import { applySessionInfo, getEmergencyMode, leaveEmergencyMode, subscribeEmergencyMode } from '../../services/emergencyMode.js';
import { getSessionInfo } from '../../services/emergencyService.js';
import { clearToken } from '../../services/session.js';
import { EMERGENCY_NAV, emergencyRedirect, sessionBannerText } from '../../utils/emergencyMode.js';
import { formatManila } from '../../utils/activityText.js';
import styles from './EmergencyShell.module.css';

/** Subscribes to the emergency-mode store (mode, end time, scope). */
function useEmergencyState() {
  const [state, setState] = useState(getEmergencyMode());
  useEffect(() => subscribeEmergencyMode(() => setState(getEmergencyMode())), []);
  return state;
}

/**
 * The contact's read-only vault. A deliberately small shell: the header has the logo, the theme switch and Sign out;
 * the sidebar has only "Files"; a banner says it is read-only and when it ends. Every other client route goes
 * to Files. There is no search box, upload, Trash, account, devices, sharing or Overview here at all (see
 * utils/emergencyMode.js, which lists them): the server would refuse them with 403 anyway.
 */
function EmergencyShell() {
  const location = useLocation();
  const mode = useEmergencyState();

  // The authoritative end time and scope names come from the server (never the owner's name or address).
  useEffect(() => {
    getSessionInfo().then(applySessionInfo).catch(() => {});
  }, []);

  // When the 4 hours are up the session is ended here too (the server has already stopped honouring it).
  useEffect(() => {
    if (!mode.endsAt) return undefined;
    const wait = new Date(mode.endsAt).getTime() - Date.now();
    if (wait <= 0 || wait > 2 ** 31 - 1) return undefined;
    const timer = setTimeout(() => {
      leaveEmergencyMode({ keepFlag: true });
      clearToken();
    }, wait);
    return () => clearTimeout(timer);
  }, [mode.endsAt]);

  const redirect = emergencyRedirect(location.pathname);
  if (redirect) return <Navigate to={redirect} replace />;

  const signOut = async () => {
    try {
      await logoutVault();
    } catch {
      // the session expires on its own
    } finally {
      leaveEmergencyMode({ keepFlag: true });
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
