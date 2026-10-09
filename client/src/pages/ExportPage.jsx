import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useShell } from '../components/ShellContext.js';
import { createFolder, fetchDocumentBytes, listDocuments, listFolders, uploadDocument } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { buildExportZip, exportFileName } from '../utils/zipExport.js';
import { IMPORT_LIMITS, inspectZip, runImport } from '../utils/zipImport.js';
import { usePageMeta } from '../utils/usePageMeta.js';
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
  usePageMeta('Export', 'Download all your files as a zip, or import a zip.');
  const { showToast, refreshSidebar } = useShell();

  // ---- export ----
  const [exportState, setExportState] = useState({ phase: 'idle' }); // idle | running | done | cancelled | error
  const exportAbort = useRef(null);

  const startExport = async () => {
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportState({ phase: 'running', done: 0, total: 0, bytes: 0, current: '', stage: 'Listing your files…' });
    try {
      const [documents, folderPaths] = await Promise.all([listDocuments(), listFolders()]);
      if (documents.length === 0 && folderPaths.length <= 1) {
        setExportState({ phase: 'empty' });
        return;
      }
      const { default: JSZip } = await import('jszip');
      const result = await buildExportZip({
        documents,
        folderPaths,
        fetchBytes: fetchDocumentBytes,
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
      setExportState({ phase: 'done', name, added: result.added, bytes: result.bytes, failures: result.failures, zipBytes: result.blob.size });
    } catch (err) {
      if (!isSessionExpired(err)) setExportState({ phase: 'error', message: extractErrorMessage(err, 'The export could not be built.') });
    }
  };

  // ---- import ----
  const [importState, setImportState] = useState({ phase: 'idle' }); // idle | checked | running | done | error
  const importAbort = useRef(null);
  const zipBytes = useRef(null);
  const fileInput = useRef(null);

  const chooseZip = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > IMPORT_LIMITS.maxArchiveBytes) {
      setImportState({ phase: 'error', message: 'That zip is too large to import here.' });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const plan = inspectZip(bytes);
    if (!plan.ok) {
      zipBytes.current = null;
      setImportState({ phase: 'error', message: plan.message });
      return;
    }
    zipBytes.current = bytes;
    setImportState({ phase: 'checked', name: file.name, plan });
  };

  const startImport = async () => {
    const plan = importState.plan;
    const controller = new AbortController();
    importAbort.current = controller;
    setImportState({ phase: 'running', name: importState.name, plan, done: 0, total: plan.files.length, current: '' });
    try {
      const { default: JSZip } = await import('jszip');
      const result = await runImport({
        bytes: zipBytes.current,
        plan,
        JSZip,
        signal: controller.signal,
        uploadFile: (file, folder) => uploadDocument({ file, folder }),
        createFolder,
        onProgress: (p) => setImportState((current) => (current.phase === 'running' ? { ...current, ...p } : current)),
      });
      zipBytes.current = null;
      refreshSidebar();
      setImportState({ phase: 'done', name: importState.name, plan, ...result });
      if (result.uploaded > 0) showToast?.(`Imported ${plural(result.uploaded, 'file')}.`);
    } catch (err) {
      zipBytes.current = null;
      if (!isSessionExpired(err)) setImportState({ phase: 'error', message: extractErrorMessage(err, 'That zip could not be imported.') });
    }
  };

  const e = exportState;
  const i = importState;
  const percent = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Export</h1>

      <section className={styles.card} aria-labelledby="export-title">
        <h2 id="export-title" className={styles.heading}>Export my files</h2>
        <p className={styles.text}>
          Download everything in My files as one .zip, with your folders (empty ones too) and the original file names.
          Trash, share links and previews are not included.
        </p>
        <p className={styles.warning}>
          <strong>The zip is not encrypted.</strong> Anyone who gets the file can open it.
        </p>

        {e.phase !== 'running' && (
          <button type="button" className={styles.primary} onClick={startExport}>
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
            <FailureList items={e.failures} title="Not in the zip" />
            {e.failures.length > 0 && <p className={styles.small}>The zip also contains warden-export-report.txt with this list.</p>}
          </div>
        )}
      </section>

      <section className={styles.card} aria-labelledby="import-title">
        <h2 id="import-title" className={styles.heading}>Import a .zip</h2>
        <p className={styles.text}>
          Adds the files in a zip to your vault, keeping its folders. Each file goes through the normal upload: your storage
          limit, up to 4 MB per file, and the usual naming rules. The zip is opened here in your browser; nothing is unpacked on disk.
        </p>

        {(i.phase === 'idle' || i.phase === 'error' || i.phase === 'checked' || i.phase === 'done') && (
          <>
            <input ref={fileInput} type="file" accept=".zip,application/zip" className={styles.hidden} onChange={chooseZip} aria-label="Choose a .zip to import" />
            <button type="button" className={i.phase === 'checked' ? styles.secondary : styles.primary} onClick={() => fileInput.current?.click()}>
              Choose a .zip…
            </button>
          </>
        )}

        {i.phase === 'error' && <p className={styles.error} role="alert">{i.message}</p>}

        {i.phase === 'checked' && (
          <div className={styles.summary} role="status">
            <p>
              <strong>{i.name}</strong>: {plural(i.plan.files.length, 'file')} ({formatBytes(i.plan.files.reduce((n, f) => n + f.size, 0))}) in {plural(i.plan.folders.length, 'folder')}.
            </p>
            <FailureList items={i.plan.ignored} title="Ignored" />
            <FailureList items={i.plan.skipped} title="Will be skipped" />
            <button type="button" className={styles.primary} onClick={startImport} disabled={i.plan.files.length === 0 && i.plan.folders.length === 0}>
              Import {plural(i.plan.files.length, 'file')}
            </button>
          </div>
        )}

        {i.phase === 'running' && (
          <div className={styles.progressBlock} role="status" aria-live="polite">
            <p className={styles.text}>
              Uploading {Math.min(i.done + 1, i.total)} of {i.total}
              {i.current ? ` - ${i.current}` : ''}
            </p>
            <progress className={styles.bar} max={i.total || 1} value={i.done || 0} aria-label="Import progress" />
            <button type="button" className={styles.secondary} onClick={() => importAbort.current?.abort()}>
              Cancel
            </button>
          </div>
        )}

        {i.phase === 'done' && (
          <div className={styles.summary} role="status">
            <p>
              {i.cancelled ? 'Import cancelled. ' : ''}
              {plural(i.uploaded, 'file')} imported{i.failures.length ? `, ${plural(i.failures.length, 'problem')}` : ''}.
              {' '}
              <Link to="/files">Open My files</Link>
            </p>
            <FailureList items={[...i.failures, ...i.plan.ignored, ...i.plan.skipped]} title="Not imported" />
          </div>
        )}
      </section>
    </div>
  );
}

export default ExportPage;
