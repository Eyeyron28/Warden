import { ArrowsClockwise, ClockCounterClockwise, DeviceMobile, HardDrive } from '@phosphor-icons/react';

import DropdownMenu from './DropdownMenu.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import styles from './SyncMenu.module.css';

/**
 * Consolidates the three previously-separate toolbar buttons ("Back up
 * to USB", "Restore from backup", "Pair a device") into one dropdown.
 * Pure repositioning - each option calls the exact same VaultShell
 * handler the old dedicated button called, opening the exact same
 * panels/modal as before.
 */
function SyncMenu({ onOpenBackup, onOpenRestore, onOpenPair }) {
  return (
    <DropdownMenu
      align="right"
      trigger={({ toggle, open }) => (
        <button type="button" className={styles.syncButton} onClick={toggle} aria-expanded={open}>
          <ArrowsClockwise size={16} weight="bold" />
          <span>Sync</span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          <button
            type="button"
            className={dropdownStyles.option}
            onClick={() => {
              close();
              onOpenBackup();
            }}
          >
            <HardDrive size={18} weight="light" className={dropdownStyles.optionIcon} />
            <span>Back up to USB</span>
          </button>
          <button
            type="button"
            className={dropdownStyles.option}
            onClick={() => {
              close();
              onOpenRestore();
            }}
          >
            <ClockCounterClockwise size={18} weight="light" className={dropdownStyles.optionIcon} />
            <span>Restore from backup</span>
          </button>
          <button
            type="button"
            className={dropdownStyles.option}
            onClick={() => {
              close();
              onOpenPair();
            }}
          >
            <DeviceMobile size={18} weight="light" className={dropdownStyles.optionIcon} />
            <span>Pair a device</span>
          </button>
        </>
      )}
    </DropdownMenu>
  );
}

export default SyncMenu;
