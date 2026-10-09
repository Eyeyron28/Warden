import { useEffect, useState } from 'react';

import { getPreferences, setExpiryReminders } from '../services/accountService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './ReminderSetting.module.css';

/** Account settings: "Email me about expiring documents" (on by default). Saves as soon as it is changed. */
function ReminderSetting() {
  const [on, setOn] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    getPreferences()
      .then((prefs) => !cancelled && setOn(prefs.expiryReminders !== false))
      .catch(() => !cancelled && setMessage('Could not load this setting.'));
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (next) => {
    const previous = on;
    setOn(next);
    setBusy(true);
    setMessage('');
    try {
      await setExpiryReminders(next);
      setMessage(next ? 'Reminders are on.' : 'Reminders are off.');
    } catch (err) {
      setOn(previous);
      setMessage(extractErrorMessage(err, 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} id="reminders" aria-labelledby="reminders-title">
      <h2 id="reminders-title" className={styles.title}>
        Expiry reminders
      </h2>
      <label className={styles.row}>
        <input
          type="checkbox"
          checked={on === true}
          disabled={on === null || busy}
          onChange={(event) => change(event.target.checked)}
        />
        <span>Email me about expiring documents</span>
      </label>
      <p className={styles.hint}>
        When a file you gave an expiry date to is 60, 30 or 7 days away, and on the day, Warden sends one email (a count, never file names).
        Turn this off and no reminder is sent.
      </p>
      <p className={styles.status} role="status">
        {message}
      </p>
    </section>
  );
}

export default ReminderSetting;
