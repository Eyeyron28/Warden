import { useState } from 'react';
import { ArrowsClockwise, CaretDown, FileText, ShieldCheck } from '@phosphor-icons/react';

import styles from './SideNav.module.css';

/**
 * Collapsible side nav: Documents (a plain item), plus two expandable
 * groups - Sync (Backup to USB / Restore from backup) and Devices (Pair a
 * device / Paired devices). Every child action just calls a handler
 * VaultShell owns; each one opens a modal over the Documents page rather
 * than navigating anywhere. "Shared" and "Settings" were removed from the
 * nav for now, until a later pass defines what belongs on them.
 *
 * `open` is owned by VaultShell (defaulted via a matchMedia check on mount)
 * so the hamburger toggle in Header and this component agree on the same
 * state. On narrow viewports this renders as a fixed overlay drawer with a
 * backdrop; on wide viewports it's a persistent sidebar that can still be
 * collapsed to width 0 via the same toggle.
 */
function NavGroup({ label, icon: Icon, expanded, onToggle, children }) {
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.item}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <Icon size={18} weight="light" />
        <span className={styles.itemLabel}>{label}</span>
        <CaretDown
          size={14}
          weight="bold"
          className={`${styles.caret} ${expanded ? styles.caretOpen : ''}`}
        />
      </button>
      {expanded && <div className={styles.children}>{children}</div>}
    </div>
  );
}

function SideNav({
  open,
  onClose,
  onOpenDocuments,
  onOpenBackup,
  onOpenRestore,
  onOpenPair,
  onOpenDevices,
}) {
  const [syncExpanded, setSyncExpanded] = useState(false);
  const [devicesExpanded, setDevicesExpanded] = useState(false);

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />}
      <nav className={`${styles.nav} ${open ? styles.navOpen : styles.navClosed}`} aria-label="Vault sections">
        <button
          type="button"
          className={`${styles.item} ${styles.itemActive}`}
          onClick={onOpenDocuments}
        >
          <FileText size={18} weight="light" />
          <span className={styles.itemLabel}>Documents</span>
        </button>

        <NavGroup
          label="Sync"
          icon={ArrowsClockwise}
          expanded={syncExpanded}
          onToggle={() => setSyncExpanded((value) => !value)}
        >
          <button type="button" className={styles.childItem} onClick={onOpenBackup}>
            Backup to USB
          </button>
          <button type="button" className={styles.childItem} onClick={onOpenRestore}>
            Restore from backup
          </button>
        </NavGroup>

        <NavGroup
          label="Devices"
          icon={ShieldCheck}
          expanded={devicesExpanded}
          onToggle={() => setDevicesExpanded((value) => !value)}
        >
          <button type="button" className={styles.childItem} onClick={onOpenPair}>
            Pair a device
          </button>
          <button type="button" className={styles.childItem} onClick={onOpenDevices}>
            Paired devices
          </button>
        </NavGroup>
      </nav>
    </>
  );
}

export default SideNav;
