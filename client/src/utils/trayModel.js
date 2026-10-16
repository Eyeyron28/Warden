import { describeCard, filesLink } from './importCard.js';
import { formatBytes } from './listing.js';

/**
 * What the transfer tray shows, as plain data computed from the two stores (services/transfers.js and services/importJob.js), so
 * every state can be tested without a browser: the rows, their words and rings, the header's live title and the overall progress.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const WORKING = new Set(['waiting', 'sending', 'sealing']);

/** The ring of a row: idle (waiting), progress (bytes sent), pulse (the server is sealing), sealed (a lock), failed. */
export const RING = Object.freeze({ IDLE: 'idle', PROGRESS: 'progress', PULSE: 'pulse', SEALED: 'sealed', FAILED: 'failed' });

function rowOfTransfer(t) {
  const common = { id: `t${t.id}`, source: 'transfer', transferId: t.id, kind: t.kind, name: t.name, size: t.size, phase: t.phase, working: WORKING.has(t.phase) };
  const percent = t.size ? Math.min(100, Math.floor((t.bytesDone / t.size) * 100)) : t.phase === 'sealing' ? 100 : 0;
  switch (t.phase) {
    case 'waiting':
      return { ...common, line: 'Waiting', ring: RING.IDLE, percent: 0, actions: { cancel: true, retry: false, dismiss: false, show: null } };
    case 'sending':
      return { ...common, line: `Sending ${formatBytes(t.bytesDone)} of ${formatBytes(t.size)}`, ring: RING.PROGRESS, percent, actions: { cancel: true, retry: false, dismiss: false, show: null } };
    case 'sealing':
      return { ...common, line: 'Sealing: the server is encrypting and saving', ring: RING.PULSE, percent: 100, actions: { cancel: true, retry: false, dismiss: false, show: null } };
    case 'sealed':
      return {
        ...common,
        line: t.savedAs ? `Sealed as "${t.savedAs}"` : t.kind === 'newVersion' ? 'New version sealed' : 'Sealed',
        ring: RING.SEALED,
        percent: 100,
        actions: { cancel: false, retry: false, dismiss: true, show: filesLink(t.destination) },
      };
    case 'canceled':
      return { ...common, line: t.error?.message || 'Canceled', ring: RING.FAILED, percent, warn: Boolean(t.error?.maybeSaved), actions: { cancel: false, retry: false, dismiss: true, show: null } };
    default:
      return { ...common, line: t.error?.message || 'Failed', ring: RING.FAILED, percent, failed: true, actions: { cancel: false, retry: Boolean(t.error?.retryable), dismiss: true, show: null } };
  }
}

function rowOfImport(job) {
  const view = describeCard(job);
  if (!view) return null;
  const common = { id: 'import', source: 'import', kind: 'import', name: job.fileName || 'Import', size: job.bytesTotal, phase: job.status === 'running' ? 'sending' : 'sealed' };
  if (view.kind === 'running') {
    const preparing = job.phase === 'reading' || job.phase === 'validating';
    return { ...common, working: true, line: view.line, ring: preparing ? RING.PULSE : RING.PROGRESS, percent: view.percent, actions: { cancel: true, retry: false, dismiss: false, show: '/export' }, importFiles: { done: job.done, total: job.total } };
  }
  const bad = view.kind === 'failed' || view.kind === 'stopped' || view.kind === 'cancelled';
  return {
    ...common,
    working: false,
    failed: view.kind === 'failed' || view.kind === 'stopped',
    line: `${view.title}${view.kind === 'warning' || view.kind === 'done' ? '' : `. ${view.line}`}`,
    ring: bad ? RING.FAILED : RING.SEALED,
    percent: view.percent,
    warn: view.kind === 'warning',
    actions: { cancel: false, retry: false, dismiss: true, show: view.target },
    importDone: { uploaded: job.uploaded },
  };
}

/**
 * @param {{ rows: object[] }} transfers  the transfers manager's state
 * @param {object} job                    the import job's state
 */
export function buildTray(transfers, job) {
  const rows = transfers.rows.map(rowOfTransfer);
  const importRow = rowOfImport(job);
  if (importRow) rows.push(importRow);

  const working = rows.filter((row) => row.working);
  const uploadsWorking = working.filter((row) => row.source === 'transfer').length;
  const importRemaining = importRow?.working ? Math.max(1, importRow.importFiles.total - importRow.importFiles.done) : 0;
  const filesWorking = uploadsWorking + importRemaining;
  const failed = rows.filter((row) => row.failed).length;
  const sealedUploads = rows.filter((row) => row.source === 'transfer' && row.phase === 'sealed').length;
  const sealed = sealedUploads + (importRow && !importRow.working && importRow.importDone ? importRow.importDone.uploaded : 0);

  let title;
  if (filesWorking > 0) title = importRow?.working && uploadsWorking === 0 ? `Importing ${plural(importRow.importFiles.total, 'file')}` : `Sealing ${plural(filesWorking, 'file')}`;
  else if (failed > 0 && sealed > 0) title = `Sealed ${sealed}, ${failed} failed`;
  else if (failed > 0) title = `${failed} failed`;
  else if (sealed > 0) title = `${plural(sealed, 'file')} sealed`;
  else title = rows.length ? 'Canceled' : '';

  // overall progress by bytes: sealed rows count in full, canceled rows not at all
  const counted = rows.filter((row) => row.phase !== 'canceled' && !(row.source === 'import' && !row.working && row.ring === RING.FAILED));
  const total = counted.reduce((sum, row) => sum + (row.size || 0), 0);
  const done = counted.reduce((sum, row) => sum + (row.ring === RING.SEALED ? row.size || 0 : Math.round(((row.size || 0) * row.percent) / 100)), 0);
  const overall = total ? Math.min(100, Math.floor((done / total) * 100)) : working.length ? 0 : 100;

  return {
    visible: rows.length > 0,
    rows,
    title,
    overall,
    running: working.length > 0,
    anyFailed: failed > 0,
    // the tray closes by itself only when nothing runs and nothing failed
    autoDismiss: rows.length > 0 && working.length === 0 && failed === 0,
    announce: transfers.announce || job.announce || '',
  };
}
