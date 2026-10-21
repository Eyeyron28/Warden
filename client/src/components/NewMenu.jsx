import { useRef } from 'react';
import { FolderSimplePlus, Plus, UploadSimple } from '@phosphor-icons/react';

import DropdownMenu from './DropdownMenu.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import styles from './NewMenu.module.css';

function NewMenu({ onOpenNewFolder, onOpenUploadForm, onFolderFilesSelected, allowFolderUpload = true }) {
  const folderInputRef = useRef(null);

  const handleFolderInputChange = (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      onFolderFilesSelected(files);
    }
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
              role="menuitem"
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
              role="menuitem"
              className={dropdownStyles.option}
              onClick={() => {
                close();
                onOpenUploadForm();
              }}
            >
              <UploadSimple size={18} weight="light" className={dropdownStyles.optionIcon} />
              <span>Upload file</span>
            </button>
            {allowFolderUpload && (
              <button
                type="button"
                role="menuitem"
                className={dropdownStyles.option}
                onClick={() => {
                  close();
                  folderInputRef.current?.click();
                }}
              >
                <UploadSimple size={18} weight="light" className={dropdownStyles.optionIcon} />
                <span>Upload folder</span>
              </button>
            )}
          </>
        )}
      </DropdownMenu>

      {allowFolderUpload && (
        <input
          ref={folderInputRef}
          type="file"
          className={styles.hiddenInput}
          onChange={handleFolderInputChange}
          webkitdirectory=""
          mozdirectory=""
          multiple
        />
      )}
    </>
  );
}

export default NewMenu;
