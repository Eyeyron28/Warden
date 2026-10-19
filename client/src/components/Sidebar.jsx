import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import {
  DownloadSimple,
  Clock,
  Star,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretDown,
  FolderSimple,
  Images,
  ShareNetwork,
  Trash,
  UserCircle,
  ShieldCheck,
  ChartBar,
  Lifebuoy,
} from '@phosphor-icons/react';

import FolderTree from './FolderTree.jsx';
import { useQuarantineCount } from '../services/quarantineCount.js';
import { useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './Sidebar.module.css';

const ICON = 22;

/** A small shield with a mark, drawn here (a library icon would add more to the main bundle than the whole item needs). */
function QuarantineIcon() {
  return (
    <svg width={ICON} height={ICON} viewBox="0 0 256 256" className={styles.shield} aria-hidden="true">
      <path d="M128 28 44 60v60c0 50 34 88 84 108 50-20 84-58 84-108V60Z" />
      <path d="M128 92v52m0 24v4" />
    </svg>
  );
}

/**
 * One labelled group of links (Main, Management, System). In the icon rail the small uppercase label becomes a thin divider, but it
 * stays in the page for screen readers, so the group keeps its name.
 */
function NavGroup({ id, title, rail, children }) {
  return (
    <div role="group" aria-labelledby={id} className={styles.navGroup} data-group={title}>
      <span id={id} className={rail ? styles.groupLabelRail : styles.groupLabel}>
        {title}
      </span>
      {children}
    </div>
  );
}
const navClass = ({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`;

/**
 * Persistent left navigation in three labelled groups - Main (My files with its lazily loaded folder tree, Photos, Recent, Starred,
 * Shared), Management (Overview, Devices & activity, Export / Import) and System (Emergency Access, Trash) - that scroll in the
 * middle, and an Account footer pinned at the bottom.
 *
 * On desktop a button at the top collapses it to an icon rail (about 64px):
 * every icon gets a tooltip with its label, the active item stays
 * highlighted, the folder tree hides and the group labels become thin dividers
 * (same order, same names for screen readers). The state lives in AppLayout's memory only. Under 768px it is a slide-in
 * drawer instead (never collapsed): it closes on navigation and Esc and keeps
 * keyboard focus inside while open.
 */
function Sidebar({ drawer, open, onClose, version, collapsed = false, onToggleCollapsed }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const navRef = useRef(null);
  const onFiles = location.pathname.startsWith('/files');
  const currentFolder = onFiles ? params.get('path') || '' : '';
  const [treeOpen, setTreeOpen] = useState(true);

  const rail = collapsed && !drawer;
  const held = useQuarantineCount();
  const ids = useId().replace(/:/g, '');

  useFocusTrap(navRef, drawer && open, { opener: 'activation' });

  useEffect(() => {
    if (!(drawer && open)) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawer, open, onClose]);

  // (The held-files count rides on the top level of the folder tree, which is asked for before the rail can be chosen.)

  const hidden = drawer && !open;
  // Following a link closes the drawer even when it points at the page you are already on.
  const closeDrawer = () => {
    if (drawer) onClose();
  };

  // In the icon rail an icon is named (and, on hover or keyboard focus, explained) by the shared tooltips: aria-label and data-tip.
  const tipFor = (text) => (rail ? { 'aria-label': text, 'data-tip': text } : {});
  const label = (text) => <span className={rail ? styles.srOnly : styles.itemLabel}>{text}</span>;

  return (
    <>
      {drawer && open && <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />}
      <nav
        id="app-sidebar"
        ref={navRef}
        className={`${styles.nav} ${drawer ? styles.drawer : ''} ${hidden ? styles.drawerClosed : ''} ${rail ? styles.rail : ''}`}
        aria-label="Main"
        aria-modal={drawer && open ? 'true' : undefined}
        role={drawer && open ? 'dialog' : undefined}
      >
        {!drawer && (
          <button
            type="button"
            className={styles.collapseButton}
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <CaretDoubleRight size={20} weight="bold" /> : <CaretDoubleLeft size={20} weight="bold" />}
            {!collapsed && <span className={styles.itemLabel}>Collapse</span>}
          </button>
        )}

        {/* The groups scroll in the middle; the Account footer stays pinned at the bottom. */}
        <div className={styles.scroll}>
          <NavGroup id={`${ids}-main`} title="Main" rail={rail}>
            <div className={styles.group}>
              <div className={styles.filesRow}>
                <NavLink to="/files" end={false} className={({ isActive }) => `${navClass({ isActive })} ${styles.grow}`} onClick={closeDrawer} {...tipFor('My files')}>
                  <FolderSimple size={ICON} weight="regular" aria-hidden="true" />
                  {label('My files')}
                </NavLink>
                {!rail && (
                  <button
                    type="button"
                    className={styles.treeToggle}
                    onClick={() => setTreeOpen((value) => !value)}
                    aria-expanded={treeOpen}
                    aria-label={treeOpen ? 'Collapse folders' : 'Expand folders'}
                  >
                    <CaretDown size={14} weight="bold" className={treeOpen ? '' : styles.caretClosed} />
                  </button>
                )}
              </div>
              {treeOpen && !rail && <FolderTree current={currentFolder} active={onFiles} version={version} onNavigate={closeDrawer} />}
            </div>
            <NavLink to="/photos" className={navClass} onClick={closeDrawer} {...tipFor('Photos')}>
              <Images size={ICON} weight="regular" aria-hidden="true" />
              {label('Photos')}
            </NavLink>
            <NavLink to="/recent" className={navClass} onClick={closeDrawer} {...tipFor('Recent')}>
              <Clock size={ICON} weight="light" aria-hidden="true" />
              {label('Recent')}
            </NavLink>
            <NavLink to="/starred" className={navClass} onClick={closeDrawer} {...tipFor('Starred')}>
              <Star size={ICON} weight="light" aria-hidden="true" />
              {label('Starred')}
            </NavLink>
            <NavLink to="/shared" className={navClass} onClick={closeDrawer} {...tipFor('Shared')}>
              <ShareNetwork size={ICON} weight="regular" aria-hidden="true" />
              {label('Shared')}
            </NavLink>
          </NavGroup>

          <NavGroup id={`${ids}-management`} title="Management" rail={rail}>
            <NavLink to="/overview" className={navClass} onClick={closeDrawer} {...tipFor('Overview')}>
              <ChartBar size={ICON} weight="regular" aria-hidden="true" />
              {label('Overview')}
            </NavLink>
            <NavLink to="/devices" className={navClass} onClick={closeDrawer} {...tipFor('Devices & activity')}>
              <ShieldCheck size={ICON} weight="regular" aria-hidden="true" />
              {label('Devices & activity')}
            </NavLink>
            <NavLink to="/expired" className={navClass} onClick={closeDrawer} {...tipFor('Expired documents')}>
              <svg width={ICON} height={ICON} viewBox="0 0 256 256" className={styles.shield} aria-hidden="true">
                <path d="M40 48h176v168H40zm0 48h176M88 28v32m80-32v32m-64 80 48 48m0-48-48 48" />
              </svg>
              {label('Expired documents')}
            </NavLink>
            <NavLink to="/export" className={navClass} onClick={closeDrawer} {...tipFor('Export / Import')}>
              <DownloadSimple size={ICON} weight="regular" aria-hidden="true" />
              {label('Export / Import')}
            </NavLink>
          </NavGroup>

          <NavGroup id={`${ids}-system`} title="System" rail={rail}>
            <NavLink to="/emergency-access" className={navClass} onClick={closeDrawer} {...tipFor('Emergency Access')}>
              <Lifebuoy size={ICON} weight="regular" aria-hidden="true" />
              {label('Emergency Access')}
            </NavLink>
            <NavLink to="/quarantine" className={navClass} onClick={closeDrawer} {...tipFor('Quarantine')}>
              <QuarantineIcon />
              {label('Quarantine')}
              {held > 0 && (
                <span className={styles.badge} data-testid="quarantine-badge" title={`${held} held`}>
                  {held}
                </span>
              )}
            </NavLink>
            <NavLink to="/trash" className={navClass} onClick={closeDrawer} {...tipFor('Trash')}>
              <Trash size={ICON} weight="regular" aria-hidden="true" />
              {label('Trash')}
            </NavLink>
          </NavGroup>
        </div>

        <div className={styles.footer} data-testid="sidebar-footer">
          <NavLink to="/account" className={navClass} onClick={closeDrawer} {...tipFor('Account')}>
            <UserCircle size={ICON} weight="regular" aria-hidden="true" />
            {label('Account')}
          </NavLink>
        </div>
      </nav>
    </>
  );
}

export default Sidebar;
