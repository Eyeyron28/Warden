import { useCallback, useEffect, useRef, useState } from 'react';
import { Lifebuoy } from '@phosphor-icons/react';

import Modal from '../components/Modal.jsx';
import EmergencyWizard from '../components/emergency/EmergencyWizard.jsx';
import FreshCodeDialog from '../components/emergency/FreshCodeDialog.jsx';
import KitScreen from '../components/emergency/KitScreen.jsx';
import RequestCard from '../components/emergency/RequestCard.jsx';
import { getMe } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { approveNow, denyRequest, getEmergencyStatus, regenerateKit, revokeEmergency } from '../services/emergencyService.js';
import { formatManila } from '../utils/activityText.js';
import { openRequestOf } from '../utils/emergencyBanner.js';
import { describeWait } from '../utils/emergencyWizard.js';
import { createKitHolder } from '../utils/kitHolder.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from '../components/emergency/emergency.module.css';

const POLL_MS = 30 * 1000;

/**
 * Emergency Access, for the owner: set it up, see who may ask and what they can see, replace the kit, turn it off,
 * and (when a request is open) deny it or approve it early.
 *
 * Honest wording on this page, as everywhere: Warden encrypts files on its server, so this is not end-to-end. The
 * kit is half a key; the server holds the other half and uses it only after the waiting period ends without a
 * denial. The kit exists only in this page's memory while it is shown, and never in any browser storage or URL.
 */
function EmergencyAccessPage() {
  usePageMeta('Emergency Access', 'Let a person you trust request read-only access if you cannot be reached.');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ownEmail, setOwnEmail] = useState('');
  const [view, setView] = useState('main'); // main | wizard | kit
  const [replaceMode, setReplaceMode] = useState(false);
  const [kitMeta, setKitMeta] = useState(null);
  const [dialog, setDialog] = useState(null); // { type, ... }
  const [busy, setBusy] = useState(false);
  const holder = useRef(createKitHolder()).current;
  const [, redraw] = useState(0);

  const load = useCallback(async () => {
    try {
      setStatus(await getEmergencyStatus());
      setError('');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load Emergency Access.'));
    }
  }, []);

  useEffect(() => {
    load();
    getMe().then((me) => setOwnEmail(me.email || '')).catch(() => {});
    const timer = setInterval(load, POLL_MS);
    // The kit is gone the moment this page is left.
    return () => {
      clearInterval(timer);
      holder.clear();
    };
  }, [load, holder]);

  const showKit = (result, meta) => {
    holder.set(result.kit);
    setKitMeta(meta);
    setView('kit');
    redraw((n) => n + 1);
  };

  const finishKit = () => {
    holder.clear();
    setKitMeta(null);
    setView('main');
    setReplaceMode(false);
    redraw((n) => n + 1);
    load();
  };

  const run = async (work, successMessage) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      if (successMessage) setNotice(successMessage);
      await load();
    } catch (err) {
      setError(
        err?.response?.status === 401
          ? 'That code didn’t work. Ask for a new one and try again.'
          : extractErrorMessage(err, 'That didn’t work. Please try again.')
      );
    } finally {
      setBusy(false);
    }
  };

  const request = openRequestOf(status);
  const configured = status?.configured === true;

  if (view === 'kit' && holder.has()) {
    return (
      <div className={styles.page}>
        <KitScreen
          kit={holder.get()}
          contactName={kitMeta?.contactName}
          contactUrl={status?.contactUrl}
          waitMinutes={kitMeta?.waitMinutes ?? status?.waitMinutes}
          replaced={kitMeta?.replaced}
          onDone={finishKit}
        />
      </div>
    );
  }

  if (view === 'wizard') {
    return (
      <div className={styles.page}>
        <EmergencyWizard
          demoMode={status?.demoMode === true}
          ownEmail={ownEmail}
          replace={replaceMode}
          onCancel={() => {
            setView('main');
            setReplaceMode(false);
          }}
          onCreated={(result, meta) => showKit(result, { contactName: meta.contactName || result.contactLabel, waitMinutes: result.waitMinutes, replaced: replaceMode })}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <h1 className={styles.title}>
          <Lifebuoy size={26} aria-hidden="true" /> Emergency Access
        </h1>
        {status?.demoMode && <span className={styles.demoBadge} data-testid="demo-badge">Demo mode: short waits are enabled.</span>}
      </header>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.ok} role="status">{notice}</p>}
      {!status && !error && <p className={styles.muted}>Loading…</p>}

      {status && !configured && (
        <section className={styles.card} aria-labelledby="ea-intro">
          <h2 id="ea-intro" className={styles.cardTitle}>Not set up</h2>
          <p className={styles.lede}>
            If you can’t be reached, a person you trust can request read-only access. You get emailed and can deny it during the waiting period.
          </p>
          <ul className={styles.points}>
            <li>You choose who, how long the waiting period is (3, 7 or 14 days), and what they can see.</li>
            <li>They get a kit (half a key). Warden keeps the other half and uses it only after the wait ends without a denial.</li>
            <li>Access is read-only, lasts a few hours at most, and everything they do is in your activity log.</li>
          </ul>
          <p className={styles.small}>
            This is not end-to-end encryption: Warden encrypts files on its server. A stolen kit alone cannot open your vault, but a kit together with a leak of
            Warden’s database could. Folder limits are enforced by the server.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => { setReplaceMode(false); setView('wizard'); }}>
              Set up
            </button>
          </div>
        </section>
      )}

      {status && configured && request && (
        <RequestCard
          request={request}
          busy={busy}
          onDeny={() => run(() => denyRequest(request.id), 'The request was denied. Your contact cannot ask again for 24 hours.')}
          onApproveNow={() => setDialog({ type: 'confirmApprove', request })}
          onTurnOff={() => setDialog({ type: 'confirmRevoke' })}
        />
      )}

      {status && configured && (
        <section className={styles.card} aria-labelledby="ea-status" data-testid="status-card">
          <h2 id="ea-status" className={styles.cardTitle}>Emergency Access is on</h2>
          <dl className={styles.summary}>
            <div><dt>Contact</dt><dd>{status.contactLabel ? `${status.contactLabel} <${status.contactEmail}>` : status.contactEmail}</dd></div>
            <div><dt>Waiting period</dt><dd>{describeWait(status.waitMinutes)}</dd></div>
            <div>
              <dt>They can see</dt>
              <dd>{status.scope.mode === 'all' ? 'Everything' : status.scope.folders.map((folder) => folder.path).join(', ') || 'Selected folders (none left)'}</dd>
            </div>
            <div><dt>Kit version</dt><dd>{status.kitVersion}</dd></div>
            <div><dt>Set up</dt><dd>{formatManila(status.createdAt)}</dd></div>
            <div>
              <dt>Recent sessions</dt>
              <dd data-testid="recent-sessions">
                {status.recentSessions?.last30Days
                  ? `${status.recentSessions.last30Days} in the last 30 days · last ${formatManila(status.recentSessions.lastStartedAt)}`
                  : 'None in the last 30 days'}
              </dd>
            </div>
          </dl>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDialog({ type: 'regenerate' })}>Regenerate kit</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDialog({ type: 'confirmReplace' })}>Change contact or settings</button>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => setDialog({ type: 'confirmRevoke' })}>Turn off</button>
          </div>
        </section>
      )}

      {dialog?.type === 'regenerate' && (
        <FreshCodeDialog
          action="regenerate"
          title="Replace the kit"
          intro="The old kit stops working at once, and any open request or session ends. We’ll email you a code to confirm."
          onClose={() => setDialog(null)}
          onVerified={(fresh) => {
            setDialog(null);
            run(async () => {
              const result = await regenerateKit(fresh);
              showKit(result, { contactName: result.contactLabel, waitMinutes: result.waitMinutes, replaced: true });
            });
          }}
        />
      )}

      {dialog?.type === 'confirmRevoke' && (
        <Modal title="Turn off Emergency Access?" onClose={() => setDialog(null)}>
          <div className={styles.codeDialog}>
            <p className={styles.muted}>Your contact’s kit stops working, any open request is cancelled, and a running session ends at once.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>Keep it on</button>
              <button type="button" className={styles.danger} onClick={() => setDialog({ type: 'revoke' })}>Turn off</button>
            </div>
          </div>
        </Modal>
      )}

      {dialog?.type === 'revoke' && (
        <FreshCodeDialog
          action="revoke"
          title="Confirm turning it off"
          intro="We’ll email you a code to confirm."
          onClose={() => setDialog(null)}
          onVerified={(fresh) => {
            setDialog(null);
            run(() => revokeEmergency(fresh), 'Emergency Access is off.');
          }}
        />
      )}

      {dialog?.type === 'confirmApprove' && (
        <Modal title="Approve access now?" onClose={() => setDialog(null)}>
          <div className={styles.codeDialog}>
            <p className={styles.muted}>Your contact will be able to open a read-only session immediately instead of waiting. You’ll confirm with an emailed code.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className={styles.primary} onClick={() => setDialog({ type: 'approve', request: dialog.request })}>Continue</button>
            </div>
          </div>
        </Modal>
      )}

      {dialog?.type === 'approve' && (
        <FreshCodeDialog
          action="approve-now"
          title="Confirm approving access"
          intro="We’ll email you a code to confirm."
          onClose={() => setDialog(null)}
          onVerified={(fresh) => {
            setDialog(null);
            run(() => approveNow(dialog.request.id, fresh), 'Access approved. Your contact has been told.');
          }}
        />
      )}

      {dialog?.type === 'confirmReplace' && (
        <Modal title="Change contact or settings?" onClose={() => setDialog(null)}>
          <div className={styles.codeDialog}>
            <p className={styles.warn}>This replaces your current setup. The current kit stops working, and any open request or session ends.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>Cancel</button>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  setDialog(null);
                  setReplaceMode(true);
                  setView('wizard');
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default EmergencyAccessPage;
