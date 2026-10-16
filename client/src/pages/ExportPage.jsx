import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DownloadSimple, UploadSimple } from '@phosphor-icons/react';

import ImportDropZone, { NOT_A_ZIP, isZipFile } from '../components/ImportDropZone.jsx';

import { fetchDocumentBytes, listDocuments, listFolders } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { reportClientEvent } from '../services/securityService.js';
import { listHeld } from '../services/quarantineService.js';
import { buildExportZip, exportFileName } from '../utils/zipExport.js';
import { IMPORT_LIMITS, inspectZip } from '../utils/zipImport.js';
import { BLOCKED_MESSAGE, importJob, useImportJob } from '../services/importJob.js';
import { filesLink } from '../utils/importCard.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import { useSingleFlight } from '../utils/useSingleFlight.js';
import styles from './ExportPage.module.css';

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isSessionExpired = (err) => err?.response?.status === 401;

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The last import's report: kept in memory until the next import, a reload or a sign-out (not only while the card is up). */
function ImportReport({ job }) {
  const imported = job.results.filter((item) => item.status === 'imported');
  // Quarantine: saved but held for review, and refused outright (nothing saved), are counted apart from the problems.
  const heldItems = job.results.filter((item) => item.status === 'held');
  const refusedItems = job.results.filter((item) => item.status === 'refused');
  const problems = [
    ...job.results.filter((item) => item.status !== 'imported' && item.status !== 'held' && item.status !== 'refused').map((item) => ({ path: item.path, reason: item.reason || 'Not imported' })),
    ...job.ignored,
    ...job.skipped,
  ];
  const renamed = imported.filter((item) => item.savedAs);
  const heading =
    job.status === 'cancelled' ? 'Import cancelled. ' : job.status === 'stopped' ? 'Import stopped. ' : job.status === 'failed' ? 'Import failed. ' : '';
  return (
    <div className={styles.summary} role="status" data-testid="import-report">
      {job.status === 'stopped' || job.status === 'failed' ? (
        <p>{heading}{job.message}</p>
      ) : (
        <p>
          {heading}
          {plural(job.uploaded, 'file')} imported{heldItems.length ? `, ${heldItems.length} held in Quarantine` : ''}{refusedItems.length ? `, ${refusedItems.length} not saved` : ''}{problems.length ? `, ${plural(problems.length, 'problem')}` : ''}.
          {job.message ? ` ${job.message}` : ''}{' '}
          <Link to={filesLink(job.destination)}>Open {job.destination ? `"${job.destination}"` : 'My files'}</Link>
          {heldItems.length > 0 && (
            <>
              {' '}
              <Link to="/quarantine">Review the held files</Link>
            </>
          )}
        </p>
      )}
      {renamed.length > 0 && (
        <p className={styles.small}>
          {plural(renamed.length, 'file')} {renamed.length === 1 ? 'was' : 'were'} saved with a number added to the name, because a file with that name already existed.
        </p>
      )}
      <FailureList items={refusedItems.map((item) => ({ path: item.path, reason: item.reason }))} title="Not saved" />
      <FailureList items={problems} title="Not imported" />
      {imported.length > 0 && (
        <details className={styles.failures}>
          <summary>Imported ({imported.length})</summary>
          <ul>
            {imported.slice(0, 200).map((item, index) => (
              <li key={`${item.path}-${index}`}>
                <strong>{item.path}</strong>{item.savedAs ? ` - saved as "${item.savedAs}"` : ''}
              </li>
            ))}
            {imported.length > 200 && <li>and {imported.length - 200} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function FailureList({ items, title }) {
  if (!items.length) return null;
  return (
    <details className={styles.failures} open>
      <summary>
        {title} ({items.length})
      </summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.path}-${index}`}>
            <strong>{item.path}</strong> - {item.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Export and import of your files as a zip, all in the browser. Nothing here touches a server
 * disk: files are fetched through the normal authenticated download (two at a time), zipped in
 * memory, and saved; an import unzips in memory and uploads through the normal upload.
 */
function ExportPage() {
  usePageMeta('Export / Import', 'Take your files out as a zip, or bring a zip in.');

  // ---- export ----
  const [exportState, setExportState] = useState({ phase: 'idle' }); // idle | running | done | cancelled | error
  const exportAbort = useRef(null);

  const guardExport = useSingleFlight(); // Export and Import each start once per press, even for two clicks in the same tick
  const startExport = async () => {
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportState({ phase: 'running', done: 0, total: 0, bytes: 0, current: '', stage: 'Listing your files…' });
    try {
      // (files held in Quarantine are not in the list, so they are not in the zip; the count says how many were left out)
      const [documents, folderPaths, heldNow] = await Promise.all([listDocuments(), listFolders(), listHeld().then((data) => data.count, () => 0)]);
      if (documents.length === 0 && folderPaths.length <= 1) {
        setExportState({ phase: 'empty' });
        return;
      }
      const { default: JSZip } = await import('jszip');
      const result = await buildExportZip({
        documents,
        folderPaths,
        // An export is one event (below), not one download per file.
        fetchBytes: (id) => fetchDocumentBytes(id, { purpose: 'silent' }),
        JSZip,
        signal: controller.signal,
        // (the builder's own "phase" must not replace the page's: that hid the progress and Cancel)
        onProgress: ({ phase, ...p }) => setExportState((current) => (current.phase === 'running' ? { ...current, ...p, stage: phase === 'zipping' ? 'Building the zip…' : '' } : current)),
      });
      if (result.cancelled) {
        setExportState({ phase: 'cancelled' });
        return;
      }
      const name = exportFileName();
      saveBlob(result.blob, name);
      reportClientEvent('export');
      setExportState({ phase: 'done', name, added: result.added, bytes: result.bytes, failures: result.failures, zipBytes: result.blob.size, heldLeftOut: heldNow });
    } catch (err) {
      if (!isSessionExpired(err)) setExportState({ phase: 'error', message: extractErrorMessage(err, 'The export could not be built.') });
    }
  };

  // ---- import ----
  // The import itself is an app-level job (services/importJob.js): it keeps running when this page is left, and the card at the
  // bottom right follows it. This page only chooses the zip, starts the job, and shows whatever the job reports.
  const job = useImportJob();
  const [chosen, setChosen] = useState({ phase: 'idle' }); // idle | checked | error
  const [blocked, setBlocked] = useState('');
  const zipBytes = useRef(null);
  const running = job.status === 'running';

  const acceptFile = async (file) => {
    setBlocked('');
    if (importJob.isRunning()) {
      setBlocked(BLOCKED_MESSAGE);
      return;
    }
    if (!isZipFile(file)) {
      zipBytes.current = null;
      setChosen({ phase: 'error', message: NOT_A_ZIP(file.name) });
      return;
    }
    if (file.size > IMPORT_LIMITS.maxArchiveBytes) {
      zipBytes.current = null;
      setChosen({ phase: 'error', message: 'That zip is too large to import here.' });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const plan = inspectZip(bytes);
    if (!plan.ok) {
      zipBytes.current = null;
      setChosen({ phase: 'error', message: plan.message });
      return;
    }
    zipBytes.current = bytes;
    setChosen({ phase: 'checked', name: file.name, plan });
  };

  const startImport = () => {
    const started = importJob.start({ name: chosen.name, bytes: zipBytes.current, plan: chosen.plan });
    if (!started.ok) {
      setBlocked(started.message);
      return;
    }
    // The job owns the zip now; this page lets go of it.
    zipBytes.current = null;
    setBlocked('');
    setChosen({ phase: 'idle' });
  };

  const e = exportState;
  const i = chosen;
  const percent = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  const zipSize = i.phase === 'checked' ? formatBytes(i.plan.files.reduce((n, f) => n + f.size, 0)) : '';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Export / Import</h1>
        <p className={styles.lead}>Take your files out as a zip, or bring a zip in.</p>
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="export-title" data-testid="export-card">
          <div className={styles.cardHead}>
            <span className={styles.cardIcon} aria-hidden="true">
              <DownloadSimple size={24} weight="duotone" />
            </span>
            <h2 id="export-title" className={styles.heading}>Export my files</h2>
          </div>
          <ul className={styles.points} aria-label="What the zip holds">
            <li>Every file in My files, as it is now, with its original name.</li>
            <li>Your folders, empty ones too.</li>
            <li>One .zip, built here in your browser.</li>
          </ul>
          <p className={styles.small}>Not included: Trash, share links, previews, private notes and earlier versions.</p>
          <p className={styles.warning}>
            <strong>The zip is not encrypted.</strong> Anyone who gets the file can open it.
          </p>

          <div className={styles.cardFoot}>
            {e.phase !== 'running' && (
              <button type="button" className={styles.primary} onClick={() => guardExport(startExport)}>
                Download all my files (.zip)
              </button>
            )}

            {e.phase === 'running' && (
              <div className={styles.progressBlock} role="status" aria-live="polite">
                <p className={styles.text}>
                  {e.stage || `File ${Math.min(e.done + 1, e.total || 1)} of ${e.total} - ${formatBytes(e.bytes || 0)} so far`}
                  {e.current ? ` - ${e.current}` : ''}
                </p>
                <progress className={styles.bar} max={e.total || 1} value={e.done || 0} aria-label="Export progress" />
                <p className={styles.small}>{plural(e.done || 0, 'file')} of {e.total || 0} ({percent(e.done || 0, e.total || 0)}%)</p>
                <button type="button" className={styles.secondary} onClick={() => exportAbort.current?.abort()}>
                  Cancel
                </button>
              </div>
            )}

            {e.phase === 'empty' && <p className={styles.text} role="status">There is nothing to export yet.</p>}
            {e.phase === 'cancelled' && <p className={styles.text} role="status">Export cancelled. Nothing was saved.</p>}
            {e.phase === 'error' && <p className={styles.error} role="alert">{e.message}</p>}
            {e.phase === 'done' && (
              <div className={styles.summary} role="status">
                <p>
                  <strong>{e.name}</strong> was saved: {plural(e.added, 'file')} ({formatBytes(e.bytes)} of files, {formatBytes(e.zipBytes)} zipped)
                  {e.failures.length ? `, and ${plural(e.failures.length, 'file')} could not be added.` : '.'}
                </p>
                {e.heldLeftOut > 0 && (
                  <p className={styles.small} data-testid="export-held-note">
                    {plural(e.heldLeftOut, 'file')} held in Quarantine {e.heldLeftOut === 1 ? 'was' : 'were'} left out of the zip.
                  </p>
                )}
                <FailureList items={e.failures} title="Not in the zip" />
                {e.failures.length > 0 && <p className={styles.small}>The zip also contains warden-export-report.txt with this list.</p>}
              </div>
            )}
          </div>
        </section>

        <section className={styles.card} aria-labelledby="import-title" data-testid="import-card-panel">
          <div className={styles.cardHead}>
            <span className={styles.cardIcon} aria-hidden="true">
              <UploadSimple size={24} weight="duotone" />
            </span>
            <h2 id="import-title" className={styles.heading}>Import a .zip</h2>
          </div>

          {!running && (
            <ImportDropZone
              onFile={acceptFile}
              error={i.phase === 'error' ? i.message : ''}
              chosen={i.phase === 'checked' ? { name: i.name, files: i.plan.files.length, size: zipSize, folders: i.plan.folders.length } : null}
            >
              {i.phase === 'checked' && (
                <>
                  <FailureList items={i.plan.ignored} title="Ignored" />
                  <FailureList items={i.plan.skipped} title="Will be skipped" />
                </>
              )}
            </ImportDropZone>
          )}

          {blocked && <p className={styles.error} role="alert">{blocked}</p>}

          {i.phase === 'checked' && !running && (
            <button type="button" className={`${styles.primary} ${styles.big}`} onClick={startImport} disabled={i.plan.files.length === 0 && i.plan.folders.length === 0}>
              Import {plural(i.plan.files.length, 'file')}
            </button>
          )}

          {running && (
            <div className={styles.progressBlock} data-testid="import-progress">
              <p className={styles.text}>
                Importing <strong>{job.fileName}</strong>: {job.phase === 'reading' ? 'reading the zip…' : job.phase === 'validating' ? 'checking the zip…' : `${job.done} of ${plural(job.total, 'file')}`}
                {job.current ? ` - ${job.current}` : ''}
              </p>
              <progress className={styles.bar} max={job.total || 1} value={job.done || 0} aria-label="Import progress" />
              <p className={styles.small}>
                {percent(job.done || 0, job.total || 0)}% - {formatBytes(job.bytesDone)} of {formatBytes(job.bytesTotal)}.
              </p>
              <button type="button" className={styles.secondary} onClick={() => importJob.cancel()}>
                Cancel (stops after the current file)
              </button>
            </div>
          )}

          <ul className={styles.points} aria-label="How an import works">
            <li>Each file follows the normal upload rules: storage limit, 4 MB per file.</li>
            <li>A name already in use gets a number added.</li>
            <li>It keeps running if you change page; progress is in the card at the bottom right. Stopping does not undo files already imported.</li>
          </ul>
        </section>

        {!running && job.status !== 'idle' && (
          <div className={styles.report}>
            <ImportReport job={job} />
          </div>
        )}
      </div>
    </div>
  );
}

export default ExportPage;
