import { useState } from 'react';
import { FileText, Trash } from '@phosphor-icons/react';

import { formatDate } from '../utils/formatDate.js';
import styles from './DocumentRow.module.css';

/**
 * One row in the document list. Delete has its own inline confirm step
 * (rather than a separate modal component) so a misclick can't destroy a
 * document - the row itself owns that confirmation state.
 */
function DocumentRow({ document, onView, onDelete, isViewing, isDeleting }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      setConfirmingDelete(false);
      onDelete(document.id);
    } else {
      setConfirmingDelete(true);
    }
  };

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.main}
        onClick={() => onView(document.id)}
        disabled={isViewing}
        aria-label={`View ${document.filename}`}
      >
        <FileText size={20} weight="light" className={styles.fileIcon} />
        <span className={styles.meta}>
          <span className={styles.filename}>{document.filename}</span>
          <span className={styles.subMeta}>
            <span className={styles.folder}>{document.folder}</span>
            {document.expiryDate && (
              <span className={styles.expiry}>Expires {formatDate(document.expiryDate)}</span>
            )}
          </span>
        </span>
        <span className={styles.createdAt}>
          {isViewing ? 'Decrypting...' : formatDate(document.createdAt)}
        </span>
      </button>

      <div className={styles.actions}>
        {!confirmingDelete ? (
          <button
            type="button"
            className={styles.deleteButton}
            onClick={handleDeleteClick}
            aria-label={`Delete ${document.filename}`}
          >
            <Trash size={16} />
          </button>
        ) : (
          <div className={styles.confirmRow}>
            <span className={styles.confirmLabel}>Delete?</span>
            <button
              type="button"
              className={styles.confirmYes}
              onClick={handleDeleteClick}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Confirm'}
            </button>
            <button type="button" className={styles.confirmNo} onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default DocumentRow;
