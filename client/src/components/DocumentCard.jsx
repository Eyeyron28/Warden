import { useState } from 'react';
import { FileText, PencilSimple, ShareNetwork, Trash } from '@phosphor-icons/react';

import StatusBadge from './StatusBadge.jsx';
import { formatDate } from '../utils/formatDate.js';
import styles from './DocumentCard.module.css';

function expiryBadgeLabel(daysUntilExpiry) {
  if (daysUntilExpiry === 0) return 'Expires today';
  return `Expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`;
}

/**
 * Grid-view equivalent of DocumentRow - same document object, same
 * onView/onDelete/onShare/onEdit handlers, same select-mode props, just
 * arranged as a card instead of a row. VaultShell fetches/sorts/filters
 * the document list exactly once; this and DocumentRow are purely two
 * different renderings of that same already-loaded array; neither
 * fetches anything itself.
 */
function DocumentCard({
  document,
  onView,
  onDelete,
  onShare,
  onEdit,
  isViewing,
  isDeleting,
  selectMode,
  selected,
  onToggleSelect,
}) {
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
    <li className={styles.card}>
      {selectMode && (
        <input
          type="checkbox"
          className={styles.selectCheckbox}
          checked={selected}
          onChange={() => onToggleSelect(document.id)}
          aria-label={`Select ${document.filename}`}
        />
      )}

      <button
        type="button"
        className={styles.thumb}
        onClick={() => onView(document.id)}
        disabled={isViewing}
        aria-label={`View ${document.filename}`}
      >
        <FileText size={32} weight="light" />
      </button>

      <div className={styles.meta}>
        <span className={styles.filename} title={document.filename}>
          {document.filename}
        </span>
        <span className={styles.subMeta}>
          <span className={styles.folder}>{document.folder}</span>
          {document.expiryStatus === 'expired' && <StatusBadge label="Expired" tone="danger" />}
          {document.expiryStatus === 'expiring_soon' && (
            <StatusBadge label={expiryBadgeLabel(document.daysUntilExpiry)} tone="warning" />
          )}
        </span>
        <span className={styles.createdAt}>
          {isViewing ? 'Decrypting...' : formatDate(document.createdAt)}
        </span>
      </div>

      <div className={styles.actions}>
        {!confirmingDelete ? (
          <>
            <button
              type="button"
              className={styles.editButton}
              onClick={() => onEdit(document)}
              aria-label={`Edit ${document.filename}`}
            >
              <PencilSimple size={14} />
            </button>
            <button
              type="button"
              className={styles.shareButton}
              onClick={() => onShare(document)}
              aria-label={`Share ${document.filename}`}
            >
              <ShareNetwork size={14} />
            </button>
            <button
              type="button"
              className={styles.deleteButton}
              onClick={handleDeleteClick}
              aria-label={`Delete ${document.filename}`}
            >
              <Trash size={14} />
            </button>
          </>
        ) : (
          <div className={styles.confirmRow}>
            <span className={styles.confirmLabel}>Delete?</span>
            <button type="button" className={styles.confirmYes} onClick={handleDeleteClick} disabled={isDeleting}>
              {isDeleting ? '...' : 'Yes'}
            </button>
            <button type="button" className={styles.confirmNo} onClick={() => setConfirmingDelete(false)}>
              No
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default DocumentCard;
