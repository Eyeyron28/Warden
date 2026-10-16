import { CaretDown, CaretUp, LockSimple, Prohibit, ShieldWarning, Vault, WarningCircle, X } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import FileTypeIcon from './FileTypeIcon.jsx';
import { RING } from '../utils/trayModel.js';
import { STOP_SEALING_PROMPT } from '../services/transfers.js';
import { formatBytes } from '../utils/listing.js';
import styles from './TransferTray.module.css';

const R = 14;
const C = 2 * Math.PI * R;

/** The seal ring: fills as bytes are sent, pulses while the server seals, closes into a lock; a warning ring when it failed. */
export function SealRing({ ring, percent = 0, small = false }) {
  const filled = ring === RING.SEALED || ring === RING.HELD || ring === RING.REFUSED ? 100 : ring === RING.PULSE ? 100 : ring === RING.PROGRESS ? percent : ring === RING.FAILED ? 100 : 0;
  return (
    <span className={`${styles.ring} ${small ? styles.ringSmall : ''}`} data-ring={ring} aria-hidden="true">
      <svg viewBox="0 0 36 36" className={styles.ringSvg}>
        <circle cx="18" cy="18" r={R} className={styles.ringTrack} />
        <circle cx="18" cy="18" r={R} className={styles.ringArc} strokeDasharray={C} strokeDashoffset={C * (1 - filled / 100)} />
      </svg>
      {ring === RING.SEALED && <LockSimple size={small ? 11 : 15} weight="fill" className={styles.lock} />}
      {ring === RING.FAILED && <WarningCircle size={small ? 11 : 15} weight="fill" className={styles.warn} />}
      {ring === RING.HELD && <ShieldWarning size={small ? 11 : 15} weight="fill" className={styles.warn} />}
      {ring === RING.REFUSED && <Prohibit size={small ? 11 : 15} weight="fill" className={styles.warn} />}
    </span>
  );
}

function Row({ row, onAction }) {
  const ext = row.kind === 'import' ? 'zip' : '';
  return (
    <li className={styles.row} data-phase={row.phase} data-ring={row.ring} data-testid="transfer-row">
      <span className={styles.fileIcon}>
        <FileTypeIcon filename={row.name || `file.${ext}`} size={28} />
      </span>
      <span className={styles.rowText}>
        <span className={styles.nameLine}>
          <FileNameLabel name={row.name} className={styles.rowName} />
          {row.size > 0 && <span className={styles.size}>{formatBytes(row.size)}</span>}
        </span>
        <span className={`${styles.status} ${row.refused ? styles.statusFailed : row.held ? styles.statusHeld : row.failed ? styles.statusFailed : ''}`} data-testid="transfer-status">
          {row.line}
        </span>
        <span className={styles.actions}>
          {row.actions.cancel && (
            <button type="button" className={styles.action} data-action="cancel" onClick={() => onAction(row, 'cancel')} aria-label={`Cancel ${row.name}`}>
              Cancel
            </button>
          )}
          {row.actions.retry && (
            <button type="button" className={styles.action} data-action="retry" onClick={() => onAction(row, 'retry')} aria-label={`Retry ${row.name}`}>
              Retry
            </button>
          )}
          {row.actions.show && (
            <button type="button" className={styles.action} data-action="show" data-target={row.actions.show} onClick={() => onAction(row, 'show')} aria-label={row.showLabel ? `${row.showLabel} (${row.name})` : row.actions.show === '/export' ? `Show details of ${row.name}` : row.actions.show === '/quarantine' ? `Open Quarantine for ${row.name}` : `Show ${row.name} in its folder`}>
              {row.showLabel || (row.actions.show === '/export' ? 'Show details' : 'Show in folder')}
            </button>
          )}
          {row.actions.dismiss && (
            <button type="button" className={styles.action} data-action="dismiss" onClick={() => onAction(row, 'dismiss')} aria-label={`Dismiss ${row.name}`}>
              Dismiss
            </button>
          )}
        </span>
      </span>
      <SealRing ring={row.ring} percent={row.percent} />
    </li>
  );
}

/**
 * The transfer tray as markup, for one model (utils/trayModel.js buildTray) and nothing else: no store, no router, no timers, so
 * every state can be rendered on its own. TransferTray.jsx is the part that is wired up.
 */
export function TransferTrayView({
  model,
  announce = '',
  minimized = false,
  confirmClose = false,
  paused = false,
  dismissMs = 45000,
  onToggleMinimize,
  onClose,
  onStop,
  onKeepGoing,
  onAction,
  onKeyDown,
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
}) {
  return (
    <aside
      className={styles.tray}
      data-testid="transfer-tray"
      data-state={model.running ? 'running' : model.anyFailed ? 'failed' : 'done'}
      data-minimized={minimized || undefined}
      aria-label="Transfers"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* The only live region: it changes at the start, every quarter and the end, not with every byte. */}
      <div className={styles.sr} role="status" aria-live="polite">
        {announce}
      </div>

      <header className={styles.head}>
        <span className={styles.mark} aria-hidden="true">
          <Vault size={20} weight="duotone" />
        </span>
        <h2 className={styles.title} data-testid="tray-title">
          {model.title}
        </h2>
        {minimized && <SealRing ring={model.running ? RING.PROGRESS : model.anyFailed ? RING.FAILED : RING.SEALED} percent={model.overall} small />}
        <button type="button" className={styles.headButton} onClick={onToggleMinimize} aria-expanded={!minimized} aria-label={minimized ? 'Expand the transfers' : 'Minimize the transfers'} data-action="minimize">
          {minimized ? <CaretUp size={16} weight="bold" /> : <CaretDown size={16} weight="bold" />}
        </button>
        <button type="button" className={styles.headButton} onClick={onClose} aria-label="Close the transfers" data-action="close">
          <X size={16} weight="bold" />
        </button>
      </header>

      {confirmClose && (
        <div className={styles.confirm} role="group" aria-label="Stop sealing?">
          <p>{STOP_SEALING_PROMPT}</p>
          <span className={styles.confirmButtons}>
            <button type="button" className={styles.danger} data-action="stop" onClick={onStop}>
              Stop
            </button>
            <button type="button" className={styles.action} data-action="keep-going" onClick={onKeepGoing}>
              Keep sealing
            </button>
          </span>
        </div>
      )}

      {!minimized && (
        <ul className={styles.rows} aria-label="Files being sealed">
          {model.rows.map((row) => (
            <Row key={row.id} row={row} onAction={onAction} />
          ))}
        </ul>
      )}

      {model.autoDismiss && (
        <div className={styles.countdown} aria-hidden="true">
          <div className={styles.countdownFill} data-paused={paused || undefined} style={{ '--dismiss-ms': `${dismissMs}ms` }} />
        </div>
      )}
    </aside>
  );
}

export default TransferTrayView;
