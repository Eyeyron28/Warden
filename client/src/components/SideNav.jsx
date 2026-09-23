import { ArrowsClockwise, FileText, Gear, ShareNetwork, ShieldCheck } from '@phosphor-icons/react';

import styles from './SideNav.module.css';

// "Documents" is the only section with real content behind it today.
// "Shared" and "Settings" are named here as the information architecture
// this redesign is building toward, but nothing backs them yet - they're
// visibly present and honestly disabled rather than faked, since
// inventing a real global-shares view or a settings page is out of scope
// for a UI restructuring pass.
const NAV_ITEMS = [
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'shared', label: 'Shared', icon: ShareNetwork, disabled: true },
  { key: 'devices', label: 'Paired Devices', icon: ShieldCheck },
  { key: 'sync', label: 'Backup / Sync', icon: ArrowsClockwise },
  { key: 'settings', label: 'Settings', icon: Gear, disabled: true },
];

/**
 * Collapsible side nav. `open` is owned by VaultShell (defaulted via a
 * matchMedia check on mount - see VaultShell.jsx - collapsed on narrow
 * widths, open on wide desktop widths) so the hamburger toggle in Header
 * and this component agree on the same state. On narrow viewports this
 * renders as a fixed overlay drawer with a backdrop (see the media query
 * in SideNav.module.css); on wide viewports it's a persistent sidebar
 * that can still be collapsed to width 0 via the same toggle.
 */
function SideNav({ open, onClose, onOpenDocuments, onOpenPairedDevices, onOpenBackup }) {
  const handleClick = (key) => {
    if (key === 'documents') onOpenDocuments();
    else if (key === 'devices') onOpenPairedDevices();
    else if (key === 'sync') onOpenBackup();
    // "shared" and "settings" are disabled - nothing to do.
  };

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />}
      <nav className={`${styles.nav} ${open ? styles.navOpen : styles.navClosed}`} aria-label="Vault sections">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`${styles.item} ${item.key === 'documents' ? styles.itemActive : ''}`}
            onClick={() => handleClick(item.key)}
            disabled={item.disabled}
            title={item.disabled ? 'Coming soon' : undefined}
          >
            <item.icon size={18} weight="light" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

export default SideNav;
