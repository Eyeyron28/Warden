import { describeCard, filesLink, outcomeOf } from './importCard.js';
import { formatBytes } from './listing.js';

/**
 * What the transfer tray shows, as plain data computed from the two stores (services/transfers.js and services/importJob.js), so
 * every state can be tested without a browser: the rows, their words and rings, the header's live title and the overall progress.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const WORKING = new Set(['waiting', 'sending', 'sealing']);

/** The ring of a row: idle (waiting), progress (bytes sent), pulse (the server is sealing), sealed (a lock), failed. */
export const RING = Object.freeze({ IDLE: 'idle', PROGRESS: 'progress', PULSE: 'pulse', SEALED: 'sealed', FAILED: 'failed', HELD: 'held', REFUSED: 'refused' });

/** Short words for the scanner's reason codes (the Quarantine page shows the full sentences, which the server sends). */
const SHORT_REASON = Object.freeze({
  TYPE_MISMATCH: 'name and content do not match',
  DOUBLE_EXTENSION: 'program-like file name',
  PDF_ACTIVE: 'PDF with active content',
  OFFICE_MACRO: 'contains macros',
  ACTIVE_MARKUP: 'contains script code',
  ARCHIVE_ABUSE: 'unsafe archive',
  EXECUTABLE_CONTENT: 'it is a program',
  KNOWN_TEST_SIGNATURE: 'antivirus test file',
  PLAIN_ZIP: 'zips go through Export / Import',
  ARCHIVE_UNINSPECTABLE: 'archive Warden cannot look inside',
});
/** A reason is a code, or { code, text } with the server's plain sentence (from the shared table). */
const codeOf = (reason) => (typeof reason === 'string' ? reason : reason?.code);
const endSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
/** The server's sentences for these reasons, joined ("never raw codes"; a bare code falls back to its short words). */
export const reasonSentences = (reasons) =>
  (reasons || [])
    .map((reason) => (typeof reason === 'string' ? SHORT_REASON[reason] && `${SHORT_REASON[reason][0].toUpperCase()}${SHORT_REASON[reason].slice(1)}` : reason?.text))
    .filter(Boolean)
    .map(endSentence)
    .join(' ');
export const shortReasons = (codes) => {
  const words = (codes || []).map((code) => SHORT_REASON[codeOf(code)]).filter(Boolean);
  if (words.length === 0) return '';
  return words.length === 1 ? words[0] : `${words[0]} and ${words.length - 1} more`;
};

/** What the status icon explains on hover, focus or tap. Plain words; the file's name is already in the row, its content never is. */
export const TIPS = Object.freeze({
  waiting: 'Waiting its turn. Warden sends two files at a time.',
  sending: 'Sending this file to your vault.',
  sealing: 'Encrypting and saving. Almost done.',
  sealed: "Sealed: encrypted with your vault key and saved. Warden's simple rules found nothing risky. This is not a full antivirus.",
  unchecked: 'Sealed and saved. This file could not be checked.',
  canceled: 'Canceled. Nothing was saved.',
  importRunning: 'Opening the zip and sending each file inside, two at a time. Every file is checked on its own.',
  importDone: "Imported: each file inside the zip was checked on its own. Warden's simple rules are not a full antivirus.",
});

function tipOfTransfer(t) {
  switch (t.phase) {
    case 'waiting':
    case 'sending':
    case 'sealing':
      return TIPS[t.phase];
    case 'sealed':
      if (t.held) return `Held for review: Warden's rules found something risky. Reasons: ${reasonSentences(t.held) || 'see Quarantine.'} Open Quarantine to decide.`;
      return t.unchecked ? TIPS.unchecked : TIPS.sealed;
    case 'canceled':
      return t.error?.maybeSaved ? t.error.message : TIPS.canceled;
    default:
      if (t.error?.refused) {
        return `Not saved: ${t.error.version ? 'this new version looks risky, so the current version is kept.' : reasonSentences(t.error.reasons) || 'the file was refused.'}`;
      }
      if (t.error?.notSaved) return `Not saved: ${t.error.message}`;
      return `Could not finish: ${String(t.error?.message || 'something went wrong').replace(/[.\s]+$/, '')}.${t.error?.retryable ? ' You can try again.' : ''}`;
  }
}

function rowOfTransfer(t) {
  const row = rowOfTransferLine(t);
  return { ...row, tip: tipOfTransfer(t) };
}

function rowOfTransferLine(t) {
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
      if (t.held) {
        // Saved, but held in Quarantine until the owner decides: amber, with a way to the page.
        const why = shortReasons(t.held);
        return { ...common, held: true, heldCount: 1, line: `Held for review${why ? `: ${why}` : ''}`, ring: RING.HELD, percent: 100, actions: { cancel: false, retry: false, dismiss: true, show: '/quarantine' }, showLabel: 'Open Quarantine' };
      }
      return {
        ...common,
        line: `${t.savedAs ? `Sealed as "${t.savedAs}"` : t.kind === 'newVersion' ? 'New version sealed' : 'Sealed'} · ${t.unchecked ? 'not checked' : 'checked'}`,
        ring: RING.SEALED,
        percent: 100,
        actions: { cancel: false, retry: false, dismiss: true, show: filesLink(t.destination) },
      };
    case 'canceled':
      return { ...common, line: t.error?.message || 'Canceled', ring: RING.FAILED, percent, warn: Boolean(t.error?.maybeSaved), actions: { cancel: false, retry: false, dismiss: true, show: null } };
    default:
      if (t.error?.refused) {
        const why = t.error.version ? 'looks risky, the current version is kept' : shortReasons(t.error.reasons);
        const zip = (t.error.reasons || []).some((r) => codeOf(r) === 'PLAIN_ZIP');
        return { ...common, failed: true, refused: true, refusedCount: 1, line: `Not saved${why ? `: ${why}` : ''}`, ring: RING.REFUSED, percent: 100, actions: { cancel: false, retry: false, dismiss: true, show: zip ? '/export' : null }, ...(zip ? { showLabel: 'Open Export / Import' } : {}) };
      }
      if (t.error?.notSaved) return { ...common, failed: true, refused: true, refusedCount: 1, line: `Not saved: ${t.error.message}`, ring: RING.REFUSED, percent: 100, actions: { cancel: false, retry: Boolean(t.error.retryable), dismiss: true, show: null } };
      return { ...common, line: t.error?.message || 'Failed', ring: RING.FAILED, percent, failed: true, actions: { cancel: false, retry: Boolean(t.error?.retryable), dismiss: true, show: null } };
  }
}

function rowOfImport(job) {
  const view = describeCard(job);
  if (!view) return null;
  const common = { id: 'import', source: 'import', kind: 'import', name: job.fileName || 'Import', size: job.bytesTotal, phase: job.status === 'running' ? 'sending' : 'sealed' };
  if (view.kind === 'running') {
    const preparing = job.phase === 'reading' || job.phase === 'validating';
    return { ...common, tip: TIPS.importRunning, working: true, line: view.line, ring: preparing ? RING.PULSE : RING.PROGRESS, percent: view.percent, actions: { cancel: true, retry: false, dismiss: false, show: '/export' }, importFiles: { done: job.done, total: job.total } };
  }
  const bad = view.kind === 'failed' || view.kind === 'stopped' || view.kind === 'cancelled';
  // The summary line carries what Quarantine did with the files inside: how many were held and how many were not saved.
  // A held file is not imported: the row, its colour and its icon say what Quarantine did (amber warning shield; red for not saved).
  const { held: heldN, refused: refusedN } = outcomeOf(job);
  return {
    ...common,
    tip: bad ? view.line || 'The import did not finish.' : TIPS.importDone,
    working: false,
    failed: view.kind === 'failed' || view.kind === 'stopped',
    held: heldN > 0,
    heldCount: heldN,
    refusedCount: refusedN,
    line: bad ? `${view.title}. ${view.line}` : `${view.title} · each file checked`,
    ring: bad ? RING.FAILED : heldN > 0 ? RING.HELD : refusedN > 0 ? RING.REFUSED : RING.SEALED,
    percent: view.percent,
    warn: view.kind === 'warning',
    actions: { cancel: false, retry: false, dismiss: true, show: view.target, review: heldN > 0 ? '/quarantine' : null },
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
  // real counts of files (an import row can hold several), not of rows
  const held = rows.reduce((sum, row) => sum + (row.heldCount || 0), 0);
  const refused = rows.reduce((sum, row) => sum + (row.refusedCount || 0), 0);
  const sealedUploads = rows.filter((row) => row.source === 'transfer' && row.phase === 'sealed' && !row.held).length;
  const sealed = sealedUploads + (importRow && !importRow.working && importRow.importDone ? importRow.importDone.uploaded : 0);

  let title;
  if (filesWorking > 0) title = importRow?.working && uploadsWorking === 0 ? `Importing ${plural(importRow.importFiles.total, 'file')}` : `Sealing ${plural(filesWorking, 'file')}`;
  else if (held > 0 || refused > 0) {
    // Quarantine outcomes: "Sealed 2, 1 held", "1 file held for review", "1 not saved".
    const bad = rows.filter((row) => row.failed && !row.refused).length;
    const parts = [sealed > 0 ? `Sealed ${sealed}` : null, held > 0 ? `${held} held for review` : null, bad > 0 ? `${bad} failed` : null, refused > 0 ? `${refused} not saved` : null].filter(Boolean);
    title = parts.length === 1 && held > 0 ? `${plural(held, 'file')} held for review` : parts.length === 1 && refused > 0 ? `${refused} not saved` : parts.join(', ');
  } else if (failed > 0 && sealed > 0) title = `Sealed ${sealed}, ${failed} failed`;
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
    anyHeld: held > 0,
    anyRefused: refused > 0,
    // the tray closes by itself only when nothing runs and nothing failed
    // (a held file needs a decision, so it keeps the tray open until it is dismissed, like a failure)
    autoDismiss: rows.length > 0 && working.length === 0 && failed === 0 && held === 0 && refused === 0,
    announce: transfers.announce || job.announce || '',
  };
}
