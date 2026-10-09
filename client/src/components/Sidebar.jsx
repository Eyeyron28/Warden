import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import {
  DownloadSimple,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretDown,
  FolderSimple,
  Images,
  ShareNetwork,
  Trash,
  UserCircle,
  DeviceMobile,
} from '@phosphor-icons/react';

import FolderTree from './FolderTree.jsx';
import StorageMeter from './StorageMeter.jsx';
import { useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './Sidebar.module.css';

const ICON = 22;
const navClass = ({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`;

/**
 * Persistent left navigation: My files (with a lazily loaded folder tree),
 * Photos, Shared, Trash, then Account and the storage meter at the bottom.
 *
 * On desktop a button at the top collapses it to an icon rail (about 64px):
 * every icon gets a tooltip with its label, the active item stays
 * highlighted, the folder tree hides and the meter becomes a small ring. The
 * state lives in AppLayout's memory only. Under 768px it is a slide-in
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
  const [tip, setTip] = useState(null); // { text, top, left }

  const rail = collapsed && !drawer;

  useFocusTrap(navRef, drawer && open, { opener: 'activation' });

  useEffect(() => {
    if (!(drawer && open)) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawer, open, onClose]);

  // A tooltip left behind by a collapse/expand would point at nothing.
  useEffect(() => setTip(null), [rail]);

  const hidden = drawer && !open;
  // Following a link closes the drawer even when it points at the page you are already on.
  const closeDrawer = () => {
    if (drawer) onClose();
  };

  // Tooltip props for an icon in the rail (nothing when the labels are showing).
  const tipFor = (text) =>
    rail
      ? {
          onMouseEnter: (event) => showTip(event.currentTarget, text),
          onFocus: (event) => showTip(event.currentTarget, text),
          onMouseLeave: () => setTip(null),
          onBlur: () => setTip(null),
        }
      : {};
  const showTip = (element, text) => {
    const rect = element.getBoundingClientRect();
    setTip({ text, top: rect.top + rect.height / 2, left: rect.right + 10 });
  };
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
            {...tipFor(collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
          >
            {collapsed ? <CaretDoubleRight size={20} weight="bold" /> : <CaretDoubleLeft size={20} weight="bold" />}
            {!collapsed && <span className={styles.itemLabel}>Collapse</span>}
          </button>
        )}

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
        <NavLink to="/shared" className={navClass} onClick={closeDrawer} {...tipFor('Shared')}>
          <ShareNetwork size={ICON} weight="regular" aria-hidden="true" />
          {label('Shared')}
        </NavLink>
        <NavLink to="/trash" className={navClass} onClick={closeDrawer} {...tipFor('Trash')}>
          <Trash size={ICON} weight="regular" aria-hidden="true" />
          {label('Trash')}
        </NavLink>

        <NavLink to="/export" className={navClass} onClick={closeDrawer} {...tipFor('Export')}>
          <DownloadSimple size={ICON} weight="regular" aria-hidden="true" />
          {label('Export')}
        </NavLink>

        <NavLink to="/devices" className={navClass} onClick={closeDrawer} {...tipFor('Devices')}>
          <DeviceMobile size={ICON} weight="regular" aria-hidden="true" />
          {label('Devices')}
        </NavLink>

        <div className={styles.spacer} />

        <NavLink to="/account" className={navClass} onClick={closeDrawer} {...tipFor('Account')}>
          <UserCircle size={ICON} weight="regular" aria-hidden="true" />
          {label('Account')}
        </NavLink>
        <StorageMeter version={version} compact={rail} onTip={rail ? { show: showTip, hide: () => setTip(null) } : null} />
      </nav>
      {tip &&
        createPortal(
          <div className={styles.tip} role="tooltip" style={{ top: tip.top, left: tip.left }}>
            {tip.text}
          </div>,
          document.body
        )}
    </>
  );
}

export default Sidebar;
