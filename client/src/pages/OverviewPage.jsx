import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import Modal from '../components/Modal.jsx';
import VaultHealthCard from '../components/VaultHealthCard.jsx';
import { getOverview, getStaleFiles } from '../services/insightsService.js';
import { deleteDocument, listExpiringDocuments } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { expiryPhrase } from '../utils/expiry.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './OverviewPage.module.css';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const folderLabel = (folder) => (!folder || folder === 'root' ? 'My files' : folder);
const openLink = (doc) => `/files?path=${encodeURIComponent(doc.folder && doc.folder !== 'root' ? doc.folder : '')}&open=${encodeURIComponent(doc.id)}`;

function FileList({ items, count, empty, extra }) {
  if (!items.length) return <p className={styles.empty}>{empty}</p>;
  return (
    <ol className={styles.list}>
      {items.map((doc) => (
        <li key={doc.id} className={styles.row}>
          <Link to={openLink(doc)} className={styles.fileLink}>{doc.filename}</Link>
          <span className={styles.meta}>
            {count(doc)}
            {extra ? ` · ${extra(doc)}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Overview: how the vault is used, from this account's own counters and activity. Nothing about other people.
 * Trashed files are never counted.
 */
function OverviewPage() {
  usePageMeta('Overview', 'Which files you use most, which you have not touched in months, and how your share links are doing.');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [cleanup, setCleanup] = useState(null); // { items, selected:Set, busy, message }
  const [expiring, setExpiring] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await getOverview());
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load the overview.'));
    }
  }, []);

  useEffect(() => {
    load();
    listExpiringDocuments()
      .then((list) => setExpiring(Array.isArray(list) ? list : []))
      .catch(() => setExpiring([]));
  }, [load]);

  // /overview#expiring (from the banner and the health card) scrolls to the expiring-documents card.
  useEffect(() => {
    if (data && window.location.hash === '#expiring') document.getElementById('expiring')?.scrollIntoView?.({ block: 'start' });
  }, [data]);

  const openCleanup = async () => {
    setCleanup({ items: [], selected: new Set(), busy: true, message: '' });
    try {
      const stale = await getStaleFiles();
      setCleanup({ items: stale.items, selected: new Set(), busy: false, message: '' });
    } catch (err) {
      setCleanup({ items: [], selected: new Set(), busy: false, message: extractErrorMessage(err, 'Could not load the list.') });
    }
  };

  const toggle = (id) =>
    setCleanup((current) => {
      const selected = new Set(current.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...current, selected };
    });

  const allSelected = useMemo(() => cleanup && cleanup.items.length > 0 && cleanup.selected.size === cleanup.items.length, [cleanup]);

  const trashSelected = async () => {
    const ids = [...cleanup.selected];
    setCleanup((current) => ({ ...current, busy: true, message: '' }));
    const failed = [];
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteDocument(id);
      } catch {
        failed.push(id);
      }
    }
    const moved = ids.length - failed.length;
    try {
      const stale = await getStaleFiles();
      setCleanup({
        items: stale.items,
        selected: new Set(),
        busy: false,
        message: `${plural(moved, 'file')} moved to Trash${failed.length ? `, ${failed.length} could not be moved` : ''}. You can restore them from Trash for 30 days.`,
      });
    } catch {
      setCleanup((current) => ({ ...current, busy: false, message: `${plural(moved, 'file')} moved to Trash.` }));
    }
    load();
  };

  if (error) return <div className={styles.page}><h1 className={styles.title}>Overview</h1><p className={styles.error} role="alert">{error}</p></div>;
  if (!data) return <div className={styles.page}><h1 className={styles.title}>Overview</h1><p className={styles.empty}>Loading…</p></div>;

  const sharing = data.sharing;
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Overview</h1>
      <p className={styles.lede}>{plural(data.totals.files, 'file')} in your vault. These numbers come from how you use it; they never leave your account.</p>

      <VaultHealthCard reloadKey={cleanup ? 0 : data.totals.files} />

      <section className={`${styles.card} ${styles.wide}`} id="expiring" aria-labelledby="ov-expiring" data-testid="expiring-card">
        <h2 id="ov-expiring" className={styles.heading}>Expiring documents</h2>
        {expiring === null ? (
          <p className={styles.empty}>Loading…</p>
        ) : expiring.length === 0 ? (
          <p className={styles.empty}>Nothing has expired or expires in the next 60 days. Give a file an expiry date from its menu in My files (the “…” button, then Set expiry date).</p>
        ) : (
          <ol className={styles.list}>
            {expiring.map((doc) => (
              <li key={doc.id} className={styles.row}>
                <Link to={openLink(doc)} className={styles.fileLink}>{doc.filename}</Link>
                <span className={`${styles.meta} ${doc.expiryStatus === 'expired' ? styles.expired : styles.soon}`}>{expiryPhrase(doc)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="ov-viewed">
          <h2 id="ov-viewed" className={styles.heading}>Most viewed</h2>
          <FileList items={data.mostViewed} count={(d) => plural(d.viewCount, 'view')} extra={(d) => `last ${formatDateTime(d.lastOpenedAt)}`} empty="Nothing viewed yet. Open a file and it shows up here." />
        </section>

        <section className={styles.card} aria-labelledby="ov-downloaded">
          <h2 id="ov-downloaded" className={styles.heading}>Most downloaded</h2>
          <FileList items={data.mostDownloaded} count={(d) => plural(d.downloadCount, 'download')} extra={(d) => `last ${formatDateTime(d.lastOpenedAt)}`} empty="Nothing downloaded yet." />
        </section>

        <section className={styles.card} aria-labelledby="ov-recent">
          <h2 id="ov-recent" className={styles.heading}>Recently opened</h2>
          <FileList items={data.recentlyOpened} count={(d) => formatDateTime(d.lastOpenedAt)} extra={(d) => folderLabel(d.folder)} empty="Nothing opened yet." />
        </section>

        <section className={styles.card} aria-labelledby="ov-stale">
          <h2 id="ov-stale" className={styles.heading}>Files you have not opened in {data.stale.days} days</h2>
          {data.stale.count === 0 ? (
            <p className={styles.empty}>Nothing has been left untouched that long.</p>
          ) : (
            <>
              <p className={styles.big}>{data.stale.count}</p>
              <p className={styles.note}>Keeping fewer documents lowers your risk: a file you no longer need cannot leak.</p>
              <button type="button" className={styles.primary} onClick={openCleanup}>Review and clean up</button>
            </>
          )}
        </section>

        <section className={`${styles.card} ${styles.wide}`} aria-labelledby="ov-sharing">
          <h2 id="ov-sharing" className={styles.heading}>Sharing</h2>
          {sharing.active === 0 ? (
            <p className={styles.empty}>You have no active share links.</p>
          ) : (
            <dl className={styles.stats}>
              <div><dt>Active links</dt><dd>{sharing.active}</dd></div>
              <div><dt>Never opened</dt><dd>{sharing.neverOpened}</dd></div>
              <div><dt>Expiring within 7 days</dt><dd>{sharing.expiringSoon}</dd></div>
              <div>
                <dt>Most opened</dt>
                <dd>{sharing.mostOpened ? `${plural(sharing.mostOpened.openCount, 'open')}${sharing.mostOpened.name ? ` · ${sharing.mostOpened.name}` : ''}` : 'None opened yet'}</dd>
              </div>
            </dl>
          )}
          <p className={styles.note}>Counts only. Nobody who opened a link is identified.</p>
          <Link to="/shared" className={styles.textLink}>Manage share links</Link>
        </section>
      </div>

      {cleanup && (
        <Modal title="Review and clean up" onClose={() => !cleanup.busy && setCleanup(null)} wide>
          <p className={styles.note}>
            These files have not been opened for {data.stale.days} days or more (oldest first). Choose the ones you no longer need; they go to
            Trash and can be restored for 30 days. Keeping fewer documents lowers your risk.
          </p>
          {cleanup.message && <p className={styles.notice} role="status">{cleanup.message}</p>}
          {cleanup.busy && cleanup.items.length === 0 ? (
            <p className={styles.empty}>Loading…</p>
          ) : cleanup.items.length === 0 ? (
            <p className={styles.empty}>Nothing left to review.</p>
          ) : (
            <>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setCleanup((current) => ({ ...current, selected: allSelected ? new Set() : new Set(current.items.map((d) => d.id)) }))}
                />
                <span>Select all ({cleanup.items.length})</span>
              </label>
              <ul className={styles.cleanList}>
                {cleanup.items.map((doc) => (
                  <li key={doc.id} className={styles.cleanRow}>
                    <label className={styles.check}>
                      <input type="checkbox" checked={cleanup.selected.has(doc.id)} onChange={() => toggle(doc.id)} />
                      <span className={styles.cleanName}>{doc.filename}</span>
                    </label>
                    <span className={styles.meta}>{folderLabel(doc.folder)} · idle {doc.idleDays} days</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setCleanup(null)} disabled={cleanup.busy}>Close</button>
            <button type="button" className={styles.danger} onClick={trashSelected} disabled={cleanup.busy || cleanup.selected.size === 0}>
              {cleanup.busy ? 'Working…' : `Move ${cleanup.selected.size || ''} to Trash`.replace('  ', ' ')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default OverviewPage;
