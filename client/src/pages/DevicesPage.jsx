import { useState } from 'react';

import PairDevicePanel from '../components/PairDevicePanel.jsx';
import PairedDevicesPanel from '../components/PairedDevicesPanel.jsx';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './DevicesPage.module.css';

/**
 * Devices: pair a phone (emailed code, then a QR with a countdown) and manage
 * the phones already paired. One page for both, so the list updates the moment
 * a pairing completes.
 */
function DevicesPage() {
  usePageMeta('Devices', 'Pair a phone and manage the phones paired with your account.');
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Devices</h1>

      <section className={styles.card} aria-labelledby="pair-title">
        <h2 id="pair-title" className={styles.heading}>Pair a phone</h2>
        <PairDevicePanel onPaired={() => setReloadKey((key) => key + 1)} />
      </section>

      <section className={styles.card} aria-labelledby="paired-title">
        <h2 id="paired-title" className={styles.heading}>Paired devices</h2>
        <PairedDevicesPanel reloadKey={reloadKey} />
      </section>
    </div>
  );
}

export default DevicesPage;
