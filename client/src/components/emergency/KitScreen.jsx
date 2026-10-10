import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Printer } from '@phosphor-icons/react';

import KitSheet from './KitSheet.jsx';
import { KIT_ACK_TEXT, canLeaveKitScreen, describeWait } from '../../utils/emergencyWizard.js';
import { kitRows } from '../../utils/kitHolder.js';
import styles from './emergency.module.css';

/**
 * The Emergency Kit, shown ONCE. The kit code and its QR code exist only in this component's memory: they are never
 * written to localStorage, sessionStorage, a cookie, the address bar or a log, and they are gone when this screen is
 * left. The screen cannot be left until the owner confirms they have saved or printed it (and a refresh or tab
 * close asks first). The QR is drawn here in the browser: nothing is sent to any service.
 */
function KitScreen({ kit, contactName, contactUrl, waitMinutes, replaced = false, onDone }) {
  const [qr, setQr] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = contactUrl || `${window.location.origin}/emergency`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(kit, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
      setQr(null);
    };
  }, [kit]);

  // Closing the tab or reloading would lose the kit for good: ask first.
  useEffect(() => {
    const guard = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(kit);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="kit-title" data-testid="kit-screen">
      <h2 id="kit-title" className={styles.cardTitle}>Your Emergency Kit</h2>
      <p className={styles.muted}>
        Give this to {contactName ? <strong>{contactName}</strong> : 'your contact'} in person or on paper. It is half of the key to your vault; Warden holds the
        other half and uses it only after the waiting period ({describeWait(waitMinutes)}) ends without you denying the request.
        {replaced ? ' The previous kit no longer works.' : ''}
      </p>

      <div className={styles.kitLayout}>
        <div className={styles.kitCode} data-testid="kit-code" aria-label="Emergency kit code">
          {kitRows(kit).map((row) => (
            <div key={row.join('-')} className={styles.kitRow}>
              {row.map((group) => (
                <span key={group}>{group}</span>
              ))}
            </div>
          ))}
        </div>
        {qr && <img className={styles.kitQr} src={qr} alt="QR code of the same kit code" width="150" height="150" />}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={copy}>
          <Copy size={18} aria-hidden="true" /> {copied ? 'Copied' : 'Copy code'}
        </button>
        <button type="button" className={styles.secondary} onClick={() => window.print()}>
          <Printer size={18} aria-hidden="true" /> Print kit sheet
        </button>
      </div>

      <label className={styles.check}>
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>{KIT_ACK_TEXT}</span>
      </label>
      <p className={styles.small}>Anyone with this kit and a copy of Warden’s database could open your vault. Keep it private.</p>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={!canLeaveKitScreen({ acknowledged })} onClick={onDone}>
          Done
        </button>
      </div>

      <KitSheet contactName={contactName} address={address} waitMinutes={waitMinutes} kit={kit} qr={qr} />
    </section>
  );
}

export default KitScreen;
