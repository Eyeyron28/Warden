import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowsClockwise,
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

const navClass = ({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`;

/**
 * Persistent left navigation: My files (with a lazily loaded folder tree),
 * Photos, Shared, Trash, then Account and the storage meter at the bottom.
 * Under 768px it is a slide-in drawer opened from the header's menu button:
 * it closes on navigation (AppLayout) and on Esc, and keeps keyboard focus
 * inside while open.
 */
function Sidebar({ drawer, open, onClose, version }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const navRef = useRef(null);
  const onFiles = location.pathname.startsWith('/files');
  const currentFolder = onFiles ? params.get('path') || '' : '';
  const [treeOpen, setTreeOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);

  useFocusTrap(navRef, drawer && open, { opener: 'activation' });

  useEffect(() => {
    if (!(drawer && open)) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawer, open, onClose]);

  const hidden = drawer && !open;

  return (
    <>
      {drawer && open && <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />}
      <nav
        id="app-sidebar"
        ref={navRef}
        className={`${styles.nav} ${drawer ? styles.drawer : ''} ${hidden ? styles.drawerClosed : ''}`}
        aria-label="Main"
        aria-modal={drawer && open ? 'true' : undefined}
        role={drawer && open ? 'dialog' : undefined}
      >
        <div className={styles.group}>
          <div className={styles.filesRow}>
            <NavLink to="/files" end={false} className={({ isActive }) => `${navClass({ isActive })} ${styles.grow}`}>
              <FolderSimple size={18} weight="regular" aria-hidden="true" />
              <span className={styles.itemLabel}>My files</span>
            </NavLink>
            <button
              type="button"
              className={styles.treeToggle}
              onClick={() => setTreeOpen((value) => !value)}
              aria-expanded={treeOpen}
              aria-label={treeOpen ? 'Collapse folders' : 'Expand folders'}
            >
              <CaretDown size={14} weight="bold" className={treeOpen ? '' : styles.caretClosed} />
            </button>
          </div>
          {treeOpen && <FolderTree current={currentFolder} active={onFiles} version={version} />}
        </div>

        <NavLink to="/photos" className={navClass}>
          <Images size={18} weight="regular" aria-hidden="true" />
          <span className={styles.itemLabel}>Photos</span>
        </NavLink>
        <NavLink to="/shared" className={navClass}>
          <ShareNetwork size={18} weight="regular" aria-hidden="true" />
          <span className={styles.itemLabel}>Shared</span>
        </NavLink>
        <NavLink to="/trash" className={navClass}>
          <Trash size={18} weight="regular" aria-hidden="true" />
          <span className={styles.itemLabel}>Trash</span>
        </NavLink>

        <div className={styles.group}>
          <button
            type="button"
            className={styles.item}
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
          >
            <ArrowsClockwise size={18} weight="regular" aria-hidden="true" />
            <span className={styles.itemLabel}>Backup &amp; devices</span>
            <CaretDown size={14} weight="bold" className={moreOpen ? '' : styles.caretClosed} />
          </button>
          {moreOpen && (
            <div className={styles.children}>
              <Link to="/files?panel=backup" className={styles.childItem}>Backup to USB</Link>
              <Link to="/files?panel=restore" className={styles.childItem}>Restore from backup</Link>
              <Link to="/files?panel=previews" className={styles.childItem}>Generate previews</Link>
              <Link to="/files?panel=pair" className={styles.childItem}>
                <DeviceMobile size={14} aria-hidden="true" /> Pair a device
              </Link>
              <Link to="/files?panel=devices" className={styles.childItem}>Paired devices</Link>
            </div>
          )}
        </div>

        <div className={styles.spacer} />

        <NavLink to="/account" className={navClass}>
          <UserCircle size={18} weight="regular" aria-hidden="true" />
          <span className={styles.itemLabel}>Account</span>
        </NavLink>
        <StorageMeter version={version} />
      </nav>
    </>
  );
}

export default Sidebar;
