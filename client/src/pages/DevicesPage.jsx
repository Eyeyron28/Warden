import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Desktop,
  DownloadSimple,
  Eye,
  Lifebuoy,
  ShareNetwork,
  ShieldCheck,
  Trash,
  UploadSimple,
  UserCircle,
  Warning,
} from '@phosphor-icons/react';

import Modal from '../components/Modal.jsx';
import { clearToken } from '../services/session.js';
import {
  forgetTrustedDevice,
  getActivity,
  listDevices,
  signOutDevice,
  signOutOtherDevices,
  verifyActivityLog,
} from '../services/securityService.js';
import { extractErrorMessage } from '../services/api.js';
import { GROUP_OPTIONS, describeEvent, formatManila, iconKind, manilaDayBoundary, placeText } from '../utils/activityText.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './DevicesPage.module.css';

const ICONS = { emergency: Lifebuoy, account: UserCircle, sharing: ShareNetwork, download: DownloadSimple, upload: UploadSimple, trash: Trash, vault: Eye };

/**
 * Devices & activity: the browsers signed in to this account (and a way to end any of them), and a timeline of
 * what happened - sign-ins, files opened, links shared - kept for 30 days. Unusual activity is flagged. The log
 * is a hash chain that detects edits and gaps (not the removal of the newest entries by someone who can write to the database): "Verify log" checks it.
 */
function DevicesPage() {
  usePageMeta('Devices & activity', 'The browsers signed in to your account, and what has happened on it.');
  const navigate = useNavigate();

  const [devices, setDevices] = useState([]);
  const [devicesError, setDevicesError] = useState('');
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [confirm, setConfirm] = useState(null); // { kind: 'device' | 'others', device? }
  const [forgetToo, setForgetToo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const [filters, setFilters] = useState({ device: '', group: '', from: '', to: '', flagged: false });
  const [events, setEvents] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [flaggedRecent, setFlaggedRecent] = useState(0);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const requestId = useRef(0);

  const [verdict, setVerdict] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const query = useMemo(
    () => ({
      device: filters.device,
      group: filters.group,
      flagged: filters.flagged,
      from: manilaDayBoundary(filters.from, false),
      to: manilaDayBoundary(filters.to, true),
    }),
    [filters]
  );

  const loadDevices = useCallback(async () => {
    setDevicesError('');
    try {
      setDevices(await listDevices());
    } catch (err) {
      setDevicesError(extractErrorMessage(err, 'Could not load your devices.'));
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const loadEvents = useCallback(
    async (append = false, before = null) => {
      const mine = ++requestId.current;
      setLoadingEvents(true);
      setEventsError('');
      try {
        const data = await getActivity({ ...query, ...(before ? { before } : {}) });
        if (mine !== requestId.current) return;
        setEvents((current) => (append ? [...current, ...data.events] : data.events));
        setNextBefore(data.nextBefore);
        setFlaggedRecent(data.flaggedRecent);
        setRetentionDays(data.retentionDays);
      } catch (err) {
        if (mine === requestId.current) setEventsError(extractErrorMessage(err, 'Could not load the activity.'));
      } finally {
        if (mine === requestId.current) setLoadingEvents(false);
      }
    },
    [query]
  );

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    loadEvents(false);
  }, [loadEvents]);

  const runConfirmed = async () => {
    if (!confirm) return;
    setBusy(true);
    setNotice('');
    try {
      if (confirm.kind === 'others') {
        const result = await signOutOtherDevices({ forgetTrusted: forgetToo });
        setNotice(
          result.devices === 0
            ? 'There are no other devices to sign out.'
            : `Signed out ${result.devices} other device${result.devices === 1 ? '' : 's'}${forgetToo ? ' and removed their trust' : ''}.`
        );
      } else if (confirm.kind === 'device') {
        const result = await signOutDevice(confirm.device.id);
        if (result.self) {
          clearToken();
          navigate('/login', { replace: true });
          return;
        }
        setNotice(`Signed out ${confirm.device.label}.`);
      } else if (confirm.kind === 'forget') {
        await forgetTrustedDevice(confirm.device.id);
        setNotice(`${confirm.device.label} will ask for an emailed code next time.`);
      }
      setConfirm(null);
      await Promise.all([loadDevices(), loadEvents(false)]);
    } catch (err) {
      setNotice(extractErrorMessage(err, 'That did not work. Please try again.'));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    setVerdict(null);
    try {
      setVerdict(await verifyActivityLog());
    } catch (err) {
      setVerdict({ error: extractErrorMessage(err, 'Could not check the log.') });
    } finally {
      setVerifying(false);
    }
  };

  const setFilter = (name, value) => setFilters((current) => ({ ...current, [name]: value }));
  const listRef = useRef(null);
  const review = () => {
    setFilters((current) => ({ ...current, flagged: true }));
    listRef.current?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <h1 className={styles.title}>Devices &amp; activity</h1>
        <button type="button" className={styles.secondary} onClick={verify} disabled={verifying}>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>{verifying ? 'Checking…' : 'Verify log'}</span>
        </button>
      </header>

      {verdict && (
        <div className={`${styles.verdict} ${verdict.ok ? styles.verdictOk : styles.verdictBad}`} role="status">
          {verdict.error ? (
            <p>{verdict.error}</p>
          ) : verdict.ok ? (
            <p>
              <strong>No edits or gaps found.</strong> {verdict.checked} event{verdict.checked === 1 ? '' : 's'} checked, every link matches.
            </p>
          ) : (
            <p>
              <strong>Broken at event #{verdict.brokenAtSeq}.</strong> {verdict.reason}
            </p>
          )}
          <p className={styles.small}>
            This detects edits and gaps. It cannot detect the removal of the newest entries by someone who can write to the database, or protect
            against someone who also holds the server’s signing key. The oldest events leave the log on their own after {verdict.retentionDays || retentionDays} days.
          </p>
        </div>
      )}

      {flaggedRecent > 0 && !filters.flagged && (
        <div className={styles.banner} role="alert">
          <Warning size={20} weight="fill" aria-hidden="true" />
          <p>
            <strong>{flaggedRecent} thing{flaggedRecent === 1 ? '' : 's'} in the last 7 days look unusual.</strong> Check they were you.
          </p>
          <button type="button" className={styles.review} onClick={review}>Review</button>
        </div>
      )}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <section className={styles.card} aria-labelledby="devices-title">
        <div className={styles.cardHead}>
          <h2 id="devices-title" className={styles.heading}>Devices</h2>
          <button type="button" className={styles.danger} onClick={() => setConfirm({ kind: 'others' })} disabled={devices.length < 2}>
            Sign out all other devices
          </button>
        </div>
        {devicesError && <p className={styles.error} role="alert">{devicesError}</p>}
        {loadingDevices && <p className={styles.small}>Loading…</p>}
        <ul className={styles.deviceList}>
          {devices.map((device) => (
            <li key={device.id} className={styles.device}>
              <Desktop size={22} className={styles.deviceIcon} aria-hidden="true" />
              <div className={styles.deviceMeta}>
                <span className={styles.deviceName}>
                  {device.label}
                  {device.current && <span className={`${styles.badge} ${styles.badgeHere}`}>This device</span>}
                  <span className={styles.badge}>{device.trusted ? 'Trusted' : 'Not trusted'}</span>
                  {device.signedOutAt && <span className={styles.badge}>Signed out</span>}
                </span>
                <span className={styles.sub}>
                  {placeText(device)} · First seen {formatManila(device.firstSeenAt)} · Last active {formatManila(device.lastSeenAt)}
                </span>
              </div>
              <div className={styles.deviceActions}>
                {device.trusted && (
                  <button type="button" className={styles.small2} onClick={() => setConfirm({ kind: 'forget', device })}>
                    Forget trusted browser
                  </button>
                )}
                <button type="button" className={styles.small2} onClick={() => setConfirm({ kind: 'device', device })}>
                  Sign out this device
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${styles.card} ${styles.activityCard}`} aria-labelledby="activity-title" ref={listRef}>
        <div className={styles.cardHead}>
          <h2 id="activity-title" className={styles.heading}>Activity</h2>
          <p className={styles.small}>Kept for {retentionDays} days. Times are in Manila.</p>
        </div>
        <div className={styles.filters}>
          <label className={styles.filter}>
            <span>Device</span>
            <select value={filters.device} onChange={(event) => setFilter('device', event.target.value)}>
              <option value="">All devices</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}{device.current ? ' (this one)' : ''}</option>
              ))}
            </select>
          </label>
          <label className={styles.filter}>
            <span>Type</span>
            <select value={filters.group} onChange={(event) => setFilter('group', event.target.value)}>
              {GROUP_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.filter}>
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilter('from', event.target.value)} />
          </label>
          <label className={styles.filter}>
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilter('to', event.target.value)} />
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={filters.flagged} onChange={(event) => setFilter('flagged', event.target.checked)} />
            <span>Only unusual</span>
          </label>
        </div>

        {eventsError && <p className={styles.error} role="alert">{eventsError}</p>}
        <ul className={styles.timeline} aria-label="Activity">
          {events.map((event) => {
            const Icon = ICONS[iconKind(event.type)] || Eye;
            return (
              <li key={event.id} className={`${styles.event} ${event.flags.length ? styles.eventFlagged : ''}`}>
                <Icon size={20} className={styles.eventIcon} aria-hidden="true" />
                <div className={styles.eventBody}>
                  <span className={styles.eventText}>
                    {describeEvent(event)}
                    {event.flags.map((flag) => (
                      <span key={flag.code} className={styles.chip}>{flag.label}</span>
                    ))}
                  </span>
                  <span className={styles.sub}>
                    {event.actor === 'emergency' ? 'Trusted contact' : event.device ? `${event.device.label}${event.device.current ? ' (this device)' : ''}` : event.type.startsWith('share_') ? 'A visitor' : 'A device'}
                    {event.countryName ? ` · ${event.countryName}` : ''} · {formatManila(event.at)}
                  </span>
                </div>
              </li>
            );
          })}
          {!loadingEvents && events.length === 0 && !eventsError && <li className={styles.empty}>Nothing to show{filters.flagged ? ' - nothing unusual.' : ' yet.'}</li>}
          {nextBefore && (
            <li className={styles.more}>
              <button type="button" className={styles.secondary} onClick={() => loadEvents(true, nextBefore)} disabled={loadingEvents}>
                {loadingEvents ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}
          {loadingEvents && events.length === 0 && <li className={styles.empty}>Loading…</li>}
        </ul>
      </section>

      {confirm && (
        <Modal title={confirm.kind === 'others' ? 'Sign out all other devices?' : confirm.kind === 'forget' ? 'Forget this trusted browser?' : 'Sign out this device?'} onClose={() => !busy && setConfirm(null)}>
          {confirm.kind === 'others' && (
            <>
              <p className={styles.text}>Every other browser signed in to your account is signed out now. This browser stays signed in.</p>
              <label className={styles.check}>
                <input type="checkbox" checked={forgetToo} onChange={(event) => setForgetToo(event.target.checked)} />
                <span>Also make them ask for an emailed code next time (forget their trust)</span>
              </label>
            </>
          )}
          {confirm.kind === 'device' && (
            <p className={styles.text}>
              {confirm.device.current ? 'This is the browser you are using: you will be signed out here too. ' : ''}
              <strong>{confirm.device.label}</strong> is signed out and no longer trusted, so it needs your password and an emailed code to come back.
            </p>
          )}
          {confirm.kind === 'forget' && (
            <p className={styles.text}><strong>{confirm.device.label}</strong> stays signed in, but the next sign-in there asks for an emailed code.</p>
          )}
          <div className={styles.modalActions}>
            <button type="button" className={styles.secondary} onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            <button type="button" className={styles.danger} onClick={runConfirmed} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default DevicesPage;
