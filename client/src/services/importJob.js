import { useSyncExternalStore } from 'react';

import { getToken, peekSessionNotice, subscribeToken } from './session.js';

export const PROGRESS_THROTTLE_MS = 250;
const ANNOUNCE_STEP = 25;

export const BLOCKED_MESSAGE = 'An import is already running. Wait for it to finish, or cancel it, before starting another.';
export const SIGN_OUT_PROMPT = 'An import is running. Stop it and sign out?';

const EMPTY = Object.freeze({
  id: 0,
  status: 'idle',
  phase: 'idle',
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
  prepared: null,
});

export function destinationOf(plan) {
  const tops = new Set(plan.files.map((file) => (file.dir ? file.dir.split('/')[0] : '')));
  return tops.size === 1 ? [...tops][0] : '';
}

export function createImportJobManager(deps) {
  const {
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
  let live = null;
  let pendingSignOut = null;
  let prepared = null;

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
      const { runImport: run, loadJSZip, inspect, uploadFile, createFolder: makeFolder, onFinished = () => {}, outcomeLine = () => '', stoppedLine = () => '' } = await loadRuntime();
      const JSZip = await loadJSZip();
      if (!live || live.controller !== controller) return;
      live.phase = 'validating';
      publish({ force: true });
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
          if (item.sessionEnded && !live.stopReason) {
            live.stopReason = 'session';
            controller.abort();
          }
        },
      });
      if (!live || live.controller !== controller) return;
      const sessionStopped = live.stopReason === 'session';
      const uploaded = Math.max(result.uploaded, live.uploaded);
      if (sessionStopped) {
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
      if (result.limitHit) {
        const message = stoppedLine({ results: live.results, uploaded }, result.limitHit.message);
        finish({ status: 'stopped', uploaded, limit: true, message, announce: message });
        onFinished({ uploaded, stopped: true, token });
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
    }
  }

  const api = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning: () => state.status === 'running',

    start({ name, bytes, plan }) {
      if (state.status === 'running') return { ok: false, message: BLOCKED_MESSAGE };
      prepared = null;
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

    prepare({ name, bytes, plan }) {
      if (state.status === 'running') return;
      prepared = { name, bytes, plan, token: currentToken() };
      set({ prepared: { name, plan } });
    },
    unprepare() {
      prepared = null;
      if (state.prepared) set({ prepared: null });
    },
    startPrepared: () => (prepared ? api.start(prepared) : { ok: false, message: 'Choose a zip first.' }),

    cancel() {
      if (!live || state.status !== 'running') return;
      live.controller.abort();
      set({ announce: 'Cancelling the import after the current file.' });
    },

    dismissCard() {
      if (state.cardVisible) set({ cardVisible: false });
    },

    clear,

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

  watchToken((next) => {
    if (prepared && next !== prepared.token) api.unprepare();
    if (state.status === 'idle') return;
    const jobToken = live?.token ?? null;
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
      clear();
    });
  });

  return api;
}

export const importJob = createImportJobManager({
  loadRuntime: () => import('./importRuntime.js').then((module) => module.runtime),
  getToken,
  subscribeToken,
  peekSessionNotice,
});

export function useImportJob() {
  return useSyncExternalStore(importJob.subscribe, importJob.getState, importJob.getState);
}
