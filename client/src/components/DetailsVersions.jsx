import { useRef, useState } from 'react';
import { ArrowCounterClockwise, DownloadSimple, Trash, UploadSimple } from '@phosphor-icons/react';

import { deleteDocumentVersion, downloadBytes, fetchVersionBytes, getStorage, restoreDocumentVersion } from '../services/documentsService.js';
import { transfers } from '../services/transfers.js';
import { validateUpload } from '../utils/transferRules.js';
import { ZIP_MESSAGE, isZipName } from '../utils/uploadSelection.js';
import { extractErrorMessage } from '../services/api.js';
import { formatManila } from '../utils/activityText.js';
import { formatBytes } from '../utils/listing.js';
import { useSingleFlight } from '../utils/useSingleFlight.js';
import styles from './DetailsPanel.module.css';

/** "Upload new version": picks a file and replaces this file's contents, keeping the old ones as a previous version. */
export function UploadVersion({ id, name, folder = '' }) {
  const input = useRef(null);
  const [state, setState] = useState({ busy: false, message: '', error: '' });
  const run = useSingleFlight();

  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (isZipName(file.name)) {
      setState({ busy: false, message: '', error: ZIP_MESSAGE });
      return;
    }
    setState({ busy: true, message: '', error: '' });
    const usage = await getStorage().catch(() => null);
    const check = validateUpload(file, { usage });
    if (!check.ok) {
      setState({ busy: false, message: '', error: check.reason });
      return;
    }
    // Handed to the transfer tray (the panel does not wait): the earlier contents are kept as a version once it is sealed.
    transfers.enqueue([{ kind: 'newVersion', file, documentId: id, destination: folder }]);
    setState({ busy: false, message: 'Sending. Follow it in the tray at the bottom right.', error: '' });
  };

  return (
    <div className={styles.uploadRow}>
      <input ref={input} type="file" hidden onChange={(event) => run(() => choose(event))} aria-label={`Choose the new version of ${name}`} />
      <button type="button" className={styles.wideButton} onClick={() => input.current?.click()} disabled={state.busy}>
        <UploadSimple size={18} />
        {state.busy ? 'Uploading…' : 'Upload new version'}
        <span className={styles.hint}>keeps the name, folder and links</span>
      </button>
      {state.message && (
        <p className={styles.muted} role="status">
          {state.message}
        </p>
      )}
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

/** The previous versions of a file, with Restore, Download and Delete (each of Restore and Delete asks first). Hidden when there are none. */
function DetailsVersions({ id, versions, limits, onChanged }) {
  const [ask, setAsk] = useState(null); // { id, action: 'restore' | 'delete' }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!versions || versions.length === 0) return null;

  const run = async (work, fallback) => {
    setBusy(true);
    setError('');
    try {
      await work();
      setAsk(null);
      onChanged?.('file');
    } catch (err) {
      setError(extractErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const download = async (version) => {
    setBusy(true);
    setError('');
    try {
      const { bytes, filename } = await fetchVersionBytes(id, version.id);
      downloadBytes(bytes, filename);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not download that version.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.versions} aria-labelledby={`versions-title-${id}`}>
      <h3 id={`versions-title-${id}`} className={styles.sub}>
        Versions
      </h3>
      <p className={styles.muted}>
        Versions are kept for {limits?.days ?? 30} days, up to {limits?.max ?? 3} per file.
      </p>
      <ul className={styles.versionList}>
        {versions.map((version) => {
          const asking = ask?.id === version.id ? ask.action : null;
          return (
            <li key={version.id} className={styles.version}>
              <div className={styles.versionInfo}>
                <strong>Version {version.version}</strong>
                <span className={styles.when}>
                  {formatManila(version.createdAt)} · {formatBytes(version.size)}
                  {version.device ? ` · ${version.device}${version.thisDevice ? ' (this browser)' : ''}` : ''}
                </span>
              </div>
              {asking ? (
                <div className={styles.confirm} role="group" aria-label={`${asking === 'restore' ? 'Restore' : 'Delete'} version ${version.version}`}>
                  <p>
                    {asking === 'restore'
                      ? `Restore version ${version.version}? The current file is kept as a new version.`
                      : `Delete version ${version.version} for good? This cannot be undone.`}
                  </p>
                  <button
                    type="button"
                    className={asking === 'delete' ? styles.dangerButton : styles.smallButton}
                    disabled={busy}
                    onClick={() =>
                      asking === 'restore'
                        ? run(() => restoreDocumentVersion(id, version.id), 'Could not restore that version.')
                        : run(() => deleteDocumentVersion(id, version.id), 'Could not delete that version.')
                    }
                  >
                    {asking === 'restore' ? 'Restore' : 'Delete'}
                  </button>
                  <button type="button" className={styles.smallButton} disabled={busy} onClick={() => setAsk(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className={styles.versionActions}>
                  <button type="button" className={styles.smallButton} disabled={busy} onClick={() => setAsk({ id: version.id, action: 'restore' })} aria-label={`Restore version ${version.version}`}>
                    <ArrowCounterClockwise size={14} /> Restore
                  </button>
                  <button type="button" className={styles.smallButton} disabled={busy} onClick={() => download(version)} aria-label={`Download version ${version.version}`}>
                    <DownloadSimple size={14} /> Download
                  </button>
                  <button type="button" className={styles.smallButton} disabled={busy} onClick={() => setAsk({ id: version.id, action: 'delete' })} aria-label={`Delete version ${version.version}`}>
                    <Trash size={14} /> Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export default DetailsVersions;
