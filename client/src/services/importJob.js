import { useSyncExternalStore } from 'react';

import { getToken, peekSessionNotice, subscribeToken } from './session.js';

/**
 * The zip import as an APP-LEVEL job.
 *
 * It used to live in the Import page's own state (pages/ExportPage.jsx), so leaving that page left the upload loop with nowhere to
 * report to: no progress, no result, no way to cancel. This store is a module, not a component: it exists for as long as the tab
 * does, so changing page cannot touch it. The Import page starts a job and reads its state; the card at the bottom right
 * (components/TransferTray.jsx, mounted above the router in main.jsx) reads the same state on every page.
 *
 * What it holds, in memory only: the zip's bytes while the job runs (dropped the moment it ends), the file name, and a per-file
 * report. Nothing goes to localStorage, sessionStorage, IndexedDB or a cache. One import at a time.
 *
 * The import is NOT atomic: every file is its own upload, so files already imported stay imported when a job is cancelled, stops,
 * or fails part-way.
 */

// Progress reaches the screen at most this often (a trailing update is always sent), however many files finish.
export const PROGRESS_THROTTLE_MS = 250;
// The progress announcement for screen readers: the start, then each quarter, then the end.
const ANNOUNCE_STEP = 25;

export const BLOCKED_MESSAGE = 'An import is already running. Wait for it to finish, or cancel it, before starting another.';
export const SIGN_OUT_PROMPT = 'An import is running. Stop it and sign out?';

const EMPTY = Object.freeze({
  id: 0,
  status: 'idle', // idle | running | done | cancelled | stopped | failed
  phase: 'idle', // reading | validating | uploading | finished
  fileName: '',
  destination: '',
  done: 0,
  total: 0,
  bytesDone: 0,
  bytesTotal: 0,
  current: '',
  uploaded: 0,
  results: [],
  ignored: [],
  skipped: [],
  startedAt: 0,
  finishedAt: 0,
  message: '',
  announce: '',
  cardVisible: false,
  signOutPrompt: false,
  prepared: null, // a zip that was chosen and checked and is waiting for "Import": { name, plan } (its bytes are kept in the closure)
});

/** The folder the imported files land in: the zip's one top-level folder when all of them are inside it, otherwise the top level. */
export function destinationOf(plan) {
  const tops = new Set(plan.files.map((file) => (file.dir ? file.dir.split('/')[0] : '')));
  return tops.size === 1 ? [...tops][0] : '';
}

/**
 * @param {object} deps everything the job touches, so a test can supply fakes (the real ones are wired at the bottom).
 */
export function createImportJobManager(deps) {
  const {
    // Everything heavy (the zip code, the uploads) arrives from loadRuntime() the first time a job starts, so a page that never
    // imports pays nothing for it. It resolves { runImport, loadJSZip, inspect, uploadFile, createFolder, onFinished }.
    loadRuntime,
    getToken: currentToken,
    subscribeToken: watchToken,
    peekSessionNotice: sessionNotice = () => null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    throttleMs = PROGRESS_THROTTLE_MS,
    window: win = typeof window === 'undefined' ? null : window,
  } = deps;

  let state = EMPTY;
  let nextId = 1;
  const listeners = new Set();
  // What runs now. Never part of the published state.
  let live = null; // { controller, token, results, bytesDone, lastEmit, timer, announcedStep, stopReason, bytes }
  let pendingSignOut = null; // { action, resolve }
  let prepared = null; // { name, bytes, plan, token }: the chosen zip, in memory only

  const emit = () => listeners.forEach((listener) => listener());
  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  const beforeUnload = (event) => {
    event.preventDefault();
    // eslint-disable-next-line no-param-reassign
    event.returnValue = 'An import is running. If you leave, it will stop.';
    return event.returnValue;
  };
  const guardUnload = (on) => {
    if (!win) return;
    if (on) win.addEventListener('beforeunload', beforeUnload);
    else win.removeEventListener('beforeunload', beforeUnload);
  };

  /** Publishes the live counters, at most once per `throttleMs` (and once more, later, if more arrived in between). */
  function publish({ force = false } = {}) {
    if (!live) return;
    const elapsed = now() - live.lastEmit;
    const send = () => {
      if (!live) return;
      live.timer = null;
      live.lastEmit = now();
      const percent = state.total ? Math.floor((live.done / state.total) * 100) : 0;
      const step = Math.floor(percent / ANNOUNCE_STEP) * ANNOUNCE_STEP;
      let { announce } = state;
      if (step > live.announcedStep && step < 100) {
        live.announcedStep = step;
        announce = `Import ${step}% done: ${live.done} of ${state.total} files.`;
      }
      state = {
        ...state,
        phase: live.phase,
        done: live.done,
        uploaded: live.uploaded,
        current: live.current,
        bytesDone: live.bytesDone,
        results: live.results.slice(),
        announce,
      };
      emit();
    };
    if (force || elapsed >= throttleMs) {
      if (live.timer) clearTimer(live.timer);
      send();
    } else if (!live.timer) {
      live.timer = setTimer(send, throttleMs - elapsed);
    }
  }

  function finish(patch) {
    const wasLive = live;
    if (wasLive?.timer) clearTimer(wasLive.timer);
    live = null;
    guardUnload(false);
    state = {
      ...state,
      ...(wasLive ? { done: wasLive.done, uploaded: wasLive.uploaded, bytesDone: wasLive.bytesDone, results: wasLive.results.slice() } : {}),
      current: '',
      phase: 'finished',
      finishedAt: now(),
      cardVisible: true,
      ...patch,
    };
    emit();
  }

  /** Throws everything away: no name, no result, no bytes. */
  function clear() {
    if (live) {
      live.controller.abort();
      if (live.timer) clearTimer(live.timer);
      live = null;
    }
    guardUnload(false);
    prepared = null;
    state = EMPTY;
    emit();
  }

  async function execute({ plan, token }) {
    const controller = live.controller;
    try {
      const { runImport: run, loadJSZip, inspect, uploadFile, createFolder: makeFolder, onFinished = () => {}, outcomeLine = () => '' } = await loadRuntime();
      const JSZip = await loadJSZip();
      if (!live || live.controller !== controller) return;
      live.phase = 'validating';
      publish({ force: true });
      // The same check the page made before offering the import: nothing is uploaded from a zip that does not pass it.
      const again = inspect(live.bytes);
      if (!again.ok) throw Object.assign(new Error(again.message), { shown: true });
      live.phase = 'uploading';
      publish({ force: true });
      const result = await run({
        bytes: live.bytes,
        plan,
        JSZip,
        signal: controller.signal,
        uploadFile,
        createFolder: makeFolder,
        onProgress: (p) => {
          if (!live) return;
          live.done = p.done;
          live.uploaded = p.uploaded;
          live.current = p.current;
          if (live.phase !== 'uploading') live.phase = 'uploading';
          publish();
        },
        onResult: (item) => {
          if (!live) return;
          live.results.push({ path: item.path, status: item.status, ...(item.reason ? { reason: item.reason } : {}), ...(item.savedAs ? { savedAs: item.savedAs } : {}), ...(item.reasons ? { reasons: item.reasons } : {}) });
          if (item.status === 'imported') live.bytesDone += item.size || 0;
          // A request the server refused because the session is over: stop here instead of failing every file that is left.
          if (item.sessionEnded && !live.stopReason) {
            live.stopReason = 'session';
            controller.abort();
          }
        },
      });
      if (!live || live.controller !== controller) return; // cleared meanwhile (sign-out, another account): nothing to report
      const sessionStopped = live.stopReason === 'session';
      const uploaded = Math.max(result.uploaded, live.uploaded);
      if (sessionStopped) {
        // Keep what was imported (it is on the server), report it, and let go of every name and result.
        const count = uploaded;
        live.results = [];
        finish({
          status: 'stopped',
          fileName: '',
          uploaded: count,
          results: [],
          ignored: [],
          skipped: [],
          message: `Your session ended, so the import stopped. ${count} file${count === 1 ? ' was' : 's were'} imported before that and ${count === 1 ? 'is' : 'are'} kept.`,
          announce: 'The import stopped because your session ended.',
        });
        onFinished({ uploaded: count, stopped: true });
        return;
      }
      const cancelled = result.cancelled;
      finish({
        status: cancelled ? 'cancelled' : 'done',
        uploaded,
        message: result.quotaHit ? 'Your storage filled up, so the rest were not imported.' : '',
        announce: `Import ${cancelled ? 'cancelled' : 'finished'}. ${outcomeLine({ results: live.results, uploaded, skipped: state.skipped, ignored: state.ignored }) || `${uploaded} file${uploaded === 1 ? '' : 's'} imported`}.`,
      });
      onFinished({ uploaded, cancelled, token });
    } catch (error) {
      if (!live || live.controller !== controller) return;
      finish({
        status: 'failed',
        message: error?.shown ? error.message : error?.response?.data?.error?.message || 'That zip could not be imported.',
        announce: 'The import failed.',
      });
    } finally {
      if (live?.controller === controller) live = null;
      // the zip's bytes are not kept
    }
  }

  const api = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning: () => state.status === 'running',

    /** Starts an import of an already-inspected zip. One at a time: a second is refused, with the reason. */
    start({ name, bytes, plan }) {
      if (state.status === 'running') return { ok: false, message: BLOCKED_MESSAGE };
      prepared = null; // the job takes over the zip
      const token = currentToken();
      live = {
        controller: new AbortController(),
        token,
        bytes,
        phase: 'reading',
        done: 0,
        uploaded: 0,
        current: '',
        results: [],
        bytesDone: 0,
        lastEmit: 0,
        timer: null,
        announcedStep: 0,
        stopReason: null,
      };
      state = {
        ...EMPTY,
        id: nextId,
        status: 'running',
        phase: 'reading',
        fileName: name,
        destination: destinationOf(plan),
        total: plan.files.length,
        bytesTotal: plan.files.reduce((sum, file) => sum + (file.size || 0), 0),
        ignored: plan.ignored || [],
        skipped: plan.skipped || [],
        startedAt: now(),
        announce: `Importing ${name}: ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}.`,
        cardVisible: true,
      };
      nextId += 1;
      guardUnload(true);
      emit();
      execute({ plan, token });
      return { ok: true };
    },

    /** Keeps a chosen, checked zip while the person looks at other pages (memory only; one at a time; a reload loses it). */
    prepare({ name, bytes, plan }) {
      if (state.status === 'running') return;
      prepared = { name, bytes, plan, token: currentToken() };
      set({ prepared: { name, plan } });
    },
    /** "Clear": forgets the chosen zip. */
    unprepare() {
      prepared = null;
      if (state.prepared) set({ prepared: null });
    },
    startPrepared: () => (prepared ? api.start(prepared) : { ok: false, message: 'Choose a zip first.' }),

    /** Stops after the file(s) being uploaded now; what was imported stays imported. */
    cancel() {
      if (!live || state.status !== 'running') return;
      live.controller.abort();
      set({ announce: 'Cancelling the import after the current file.' });
    },

    /** Hides the card (the report stays for the Import page). */
    dismissCard() {
      if (state.cardVisible) set({ cardVisible: false });
    },

    /** Forgets the last job entirely. */
    clear,

    /**
     * Run `action` (sign out, lock the vault) - after asking, when an import is running. Resolves true when the action ran.
     */
    requestSignOut(action) {
      if (state.status !== 'running') {
        return Promise.resolve(action()).then(() => true);
      }
      if (pendingSignOut) return Promise.resolve(false);
      return new Promise((resolve) => {
        pendingSignOut = { action, resolve };
        set({ signOutPrompt: true });
      });
    },
    async answerSignOut(stop) {
      const pending = pendingSignOut;
      pendingSignOut = null;
      if (!pending) return;
      set({ signOutPrompt: false });
      if (!stop) {
        pending.resolve(false);
        return;
      }
      clear(); // files already imported stay imported; the job and its report go
      await pending.action();
      pending.resolve(true);
    },
  };

  // A signed-out or different session ends the job. (Subscribed once, for the life of the tab.)
  watchToken((next) => {
    // A chosen zip never outlives its session: sign-out, lock, expiry or another account clears it.
    if (prepared && next !== prepared.token) api.unprepare();
    if (state.status === 'idle') return;
    const jobToken = live?.token ?? null;
    // expireSession() sets its notice just AFTER telling listeners, so look one tick later.
    Promise.resolve().then(() => {
      if (next && jobToken && next === jobToken) return;
      const expired = !next && Boolean(sessionNotice());
      if (expired && live) {
        const count = Math.max(live.uploaded, live.results.filter((item) => item.status === 'imported').length);
        const controller = live.controller;
        controller.abort();
        live.results = [];
        finish({
          status: 'stopped',
          fileName: '',
          uploaded: count,
          results: [],
          ignored: [],
          skipped: [],
          message: `Your session ended, so the import stopped. ${count} file${count === 1 ? ' was' : 's were'} imported before that and ${count === 1 ? 'is' : 'are'} kept.`,
          announce: 'The import stopped because your session ended.',
        });
        return;
      }
      if (expired && state.status === 'stopped') return;
      // Signed out on purpose, or another account signed in: nothing of the job may be left.
      clear();
    });
  });

  return api;
}

/** The one manager of this tab, wired to the real upload (services/importRuntime.js, loaded on first use) and the real session. */
export const importJob = createImportJobManager({
  loadRuntime: () => import('./importRuntime.js').then((module) => module.runtime),
  getToken,
  subscribeToken,
  peekSessionNotice,
});

/** The job's state, re-read when it changes. */
export function useImportJob() {
  return useSyncExternalStore(importJob.subscribe, importJob.getState, importJob.getState);
}
