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

/** Files that were not imported: failures and skips in the report, plus zip entries that were ignored or too big up front. */
export function skippedCount(state) {
  return state.results.filter((item) => item.status !== 'imported').length + state.skipped.length + state.ignored.length;
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
  return {
    kind: skipped > 0 ? 'warning' : 'done',
    title: skipped > 0 ? `Imported ${imported}, ${skipped} skipped` : `Imported ${imported}`,
    name,
    line: state.message || (skipped > 0 ? 'Some files were not imported. Open the report.' : 'Open the folder to see them.'),
    percent: 100,
    target: toFiles,
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
