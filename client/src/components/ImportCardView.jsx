import { CheckCircle, CircleNotch, WarningCircle, X, XCircle } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import styles from './ImportCard.module.css';

const ICONS = { done: CheckCircle, warning: WarningCircle, cancelled: WarningCircle, stopped: WarningCircle, failed: XCircle };

/**
 * What the import card looks like for one description of it (utils/importCard.js describeCard) - and nothing else: no store, no
 * router, no timers, so every state can be rendered on its own (the tests do). ImportCard.jsx is the part that is wired up.
 */
export function ImportCardView({ view, announce, focused = false, confirming = false, dismissMs, onOpen, onClose, onAskCancel, onStop, onKeepGoing, onFocus, onBlur }) {
  const Icon = ICONS[view.kind];
  const label = `${view.title}${view.name ? ` ${view.name}` : ''}. ${view.line}`;
  const body = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {view.kind === 'running' ? <CircleNotch size={22} className={styles.spin} /> : <Icon size={22} weight="fill" />}
      </span>
      <span className={styles.text}>
        <span className={styles.title}>
          <span className={styles.titleWord}>{view.name ? `${view.title} ` : view.title}</span>
          {view.name && <FileNameLabel name={view.name} className={styles.name} />}
        </span>
        <span className={styles.line}>{view.line}</span>
      </span>
    </>
  );

  return (
    <aside className={styles.card} data-kind={view.kind} data-testid="import-card" aria-label="Import" onFocus={onFocus} onBlur={onBlur}>
      {/* The only live region: it changes rarely (start, each quarter, the end), so a long import does not chatter. */}
      <div className={styles.sr} role="status" aria-live="polite">
        {announce}
      </div>

      <div className={styles.row}>
        {view.target ? (
          <button type="button" className={styles.body} data-action="open" data-target={view.target} onClick={onOpen} aria-label={label}>
            {body}
          </button>
        ) : (
          <div className={styles.body}>{body}</div>
        )}
        {view.closable && (
          <button type="button" className={styles.close} data-action="dismiss" onClick={onClose} aria-label="Dismiss">
            <X size={16} weight="bold" />
          </button>
        )}
      </div>

      {view.kind === 'running' && (
        <>
          <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-label="Import progress">
            <div className={styles.fill} style={{ width: `${view.percent}%` }} />
          </div>
          <div className={styles.foot}>
            <span className={styles.percent}>{view.percent}%</span>
            {confirming ? (
              <span className={styles.confirm} role="group" aria-label="Stop the import?">
                <span>Stop the import?</span>
                <button type="button" className={styles.danger} data-action="stop" onClick={onStop}>
                  Stop
                </button>
                <button type="button" className={styles.plain} data-action="keep-going" onClick={onKeepGoing}>
                  Keep going
                </button>
              </span>
            ) : (
              <button type="button" className={styles.plain} data-action="cancel" onClick={onAskCancel}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {view.autoDismiss && (
        <div className={styles.countdown} aria-hidden="true">
          <div className={styles.countdownFill} data-paused={focused || undefined} style={{ '--dismiss-ms': `${dismissMs}ms` }} />
        </div>
      )}
    </aside>
  );
}

export default ImportCardView;
