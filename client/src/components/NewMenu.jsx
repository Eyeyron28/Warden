import { useRef } from 'react';
import { FolderSimplePlus, Plus, UploadSimple } from '@phosphor-icons/react';

import DropdownMenu from './DropdownMenu.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import styles from './NewMenu.module.css';

/**
 * Replaces the old standalone "Add document" button. "New folder" and
 * "Upload file" just open the existing NewFolderModal/UploadForm flows
 * (this component doesn't talk to the backend itself); "Upload folder"
 * is the one option that needs its own hidden <input type="file"
 * webkitdirectory> here, since there's no existing UI for picking a
 * whole folder at once.
 */
function NewMenu({ onOpenNewFolder, onOpenUploadForm, onFolderFilesSelected }) {
  const folderInputRef = useRef(null);

  const handleFolderInputChange = (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      onFolderFilesSelected(files);
    }
    // Reset so selecting the exact same folder again still fires onChange.
    event.target.value = '';
  };

  return (
    <>
      <DropdownMenu
        trigger={({ toggle, open }) => (
          <button type="button" className={styles.newButton} onClick={toggle} aria-expanded={open}>
            <Plus size={16} weight="bold" />
            <span>New</span>
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
                onOpenNewFolder();
              }}
            >
              <FolderSimplePlus size={18} weight="light" className={dropdownStyles.optionIcon} />
              <span>New folder</span>
            </button>
            <button
              type="button"
              className={dropdownStyles.option}
              onClick={() => {
                close();
                onOpenUploadForm();
              }}
            >
              <UploadSimple size={18} weight="light" className={dropdownStyles.optionIcon} />
              <span>Upload file</span>
            </button>
            <button
              type="button"
              className={dropdownStyles.option}
              onClick={() => {
                close();
                folderInputRef.current?.click();
              }}
            >
              <UploadSimple size={18} weight="light" className={dropdownStyles.optionIcon} />
              <span>Upload folder</span>
            </button>
          </>
        )}
      </DropdownMenu>

      <input
        ref={folderInputRef}
        type="file"
        className={styles.hiddenInput}
        onChange={handleFolderInputChange}
        // webkitdirectory/mozdirectory are non-standard but universally
        // supported in Chromium/Firefox for "pick a whole folder" - React
        // passes unrecognized lowercase attributes straight through to
        // the DOM, so this works with no extra plumbing.
        webkitdirectory=""
        mozdirectory=""
        multiple
      />
    </>
  );
}

export default NewMenu;
