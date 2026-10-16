/**
 * What the import card shows and does, as plain functions of the job's state (services/importJob.js), so every state can be tested
 * without a browser: the words, the percentage, where a click goes, whether the card closes by itself, and the timer that does it.
 */

// How long a FINISHED card stays when nobody touches it. A named, overridable value: tests (and the browser check) change it.
// (A browser run may shorten it through window.__WARDEN_TEST__.importCardMs, set before the page loads; it only ever makes the card go sooner.)
export const DEFAULT_DISMISS_MS = 45_000;
const override = Number(globalThis.__WARDEN_TEST__?.importCardMs);
export const importCardConfig = { dismissMs: Number.isFinite(override) && override >= 500 && override < DEFAULT_DISMISS_MS ? override : DEFAULT_DISMISS_MS };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const isFinished = (state) => ['done', 'cancelled', 'stopped', 'failed'].includes(state.status);

/**
 * Files that were not imported and are not accounted for apart: failures and skips in the report, plus zip entries that were ignored
 * or too big up front. A file held in Quarantine, or refused outright, is counted on its own (see outcomeOf), never as "imported".
 */
export function skippedCount(state) {
  return state.results.filter((item) => !['imported', 'held', 'refused'].includes(item.status)).length + state.skipped.length + state.ignored.length;
}

/** What an import did, in real counts: files imported (clean and saved), held for review, not saved, and skipped. */
export function outcomeOf(state) {
  const held = state.results.filter((item) => item.status === 'held').length;
  const refused = state.results.filter((item) => item.status === 'refused').length;
  return { imported: state.uploaded, held, refused, other: skippedCount(state) };
}

/**
 * "Imported 4 files" only when every file was clean; "Imported 1 file, 3 held for review"; "Imported 1 file, 2 held for review, 1 not
 * saved"; "No files imported. 4 held for review". A held file is never counted as imported.
 */
export function outcomeText({ imported, held, refused, other }) {
  const bits = [held ? `${held} held for review` : '', refused ? `${refused} not saved` : '', other ? `${other} skipped` : ''].filter(Boolean);
  if (imported === 0 && (held || refused)) return `No files imported. ${bits.join(', ')}`;
  return [`Imported ${plural(imported, 'file')}`, ...bits].join(', ');
}

export const percentOf = (state) => (state.total ? Math.min(100, Math.floor((state.done / state.total) * 100)) : 0);

/** The folder view an imported-files click opens. */
export const filesLink = (destination) => (destination ? `/files?path=${encodeURIComponent(destination)}` : '/files');

/**
 * @returns {null | {
 *   kind: 'running' | 'done' | 'warning' | 'cancelled' | 'stopped' | 'failed',
 *   title: string, name: string, line: string, percent: number,
 *   target: string | null, canCancel: boolean, closable: boolean, autoDismiss: boolean,
 * }}
 */
export function describeCard(state) {
  if (state.status === 'idle' || !state.cardVisible) return null;
  const skipped = skippedCount(state);
  const name = state.fileName;
  if (state.status === 'running') {
    const preparing = state.phase === 'reading' ? 'Reading the zip…' : state.phase === 'validating' ? 'Checking the zip…' : '';
    return {
      kind: 'running',
      title: 'Importing',
      name,
      line: preparing || `${state.done} of ${plural(state.total, 'file')}`,
      percent: percentOf(state),
      target: '/export',
      canCancel: true,
      closable: false,
      autoDismiss: false,
    };
  }
  const imported = plural(state.uploaded, 'file');
  const toFiles = state.uploaded > 0 ? filesLink(state.destination) : '/export';
  if (state.status === 'cancelled') {
    return { kind: 'cancelled', title: 'Import cancelled', name, line: `${imported} imported before it stopped`, percent: percentOf(state), target: toFiles, canCancel: false, closable: true, autoDismiss: true };
  }
  if (state.status === 'stopped') {
    return { kind: 'stopped', title: 'Import stopped', name: '', line: state.message, percent: percentOf(state), target: null, canCancel: false, closable: true, autoDismiss: true };
  }
  if (state.status === 'failed') {
    return { kind: 'failed', title: 'Import failed', name, line: state.message || 'That zip could not be imported.', percent: 0, target: '/export', canCancel: false, closable: true, autoDismiss: true };
  }
  const outcome = outcomeOf(state);
  const trouble = outcome.held + outcome.refused + outcome.other > 0;
  return {
    kind: trouble ? 'warning' : 'done',
    // the look: ok (the normal success), held (amber), refused (amber and red)
    tone: outcome.refused ? 'refused' : trouble ? 'held' : 'ok',
    held: outcome.held,
    refused: outcome.refused,
    title: outcomeText(outcome),
    name,
    line: state.message || (outcome.held ? 'Held files wait in Quarantine until you decide.' : skipped > 0 ? 'Some files were not imported. Open the report.' : 'Open the folder to see them.'),
    percent: 100,
    // imported something: its folder; nothing imported: Quarantine when something is held, else the report
    target: state.uploaded > 0 ? toFiles : outcome.held ? '/quarantine' : '/export',
    canCancel: false,
    closable: true,
    autoDismiss: true,
  };
}

/**
 * The timer behind "disappears after 45 seconds": it can be paused (while the card has keyboard focus) and resumed with what was
 * left, and cancelled. Clock and timers are injectable.
 */
export function createDismissTimer({ ms, onExpire, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let remaining = ms;
  let startedAt = 0;
  let handle = null;
  let spent = false;
  const arm = () => {
    startedAt = now();
    handle = setTimer(() => {
      handle = null;
      spent = true;
      onExpire();
    }, remaining);
  };
  return {
    start() {
      if (handle || spent) return;
      remaining = ms;
      arm();
    },
    pause() {
      if (!handle) return;
      clearTimer(handle);
      handle = null;
      remaining = Math.max(0, remaining - (now() - startedAt));
    },
    resume() {
      if (handle || spent || remaining <= 0) return;
      arm();
    },
    cancel() {
      if (handle) clearTimer(handle);
      handle = null;
      spent = true;
    },
    remaining: () => (handle ? Math.max(0, remaining - (now() - startedAt)) : remaining),
  };
}
