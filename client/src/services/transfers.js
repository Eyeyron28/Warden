import { useSyncExternalStore } from 'react';

import { importJob } from './importJob.js';
import { getToken, subscribeToken } from './session.js';
import { uploadSlots } from './uploadSlots.js';
import { describeTransferError } from '../utils/transferRules.js';
import { newUploadKey } from '../utils/uuid.js';

export const PROGRESS_THROTTLE_MS = 250;
const ANNOUNCE_STEP = 25;
const WORKING = new Set(['waiting', 'sending', 'sealing']);

export const isWorking = (row) => WORKING.has(row.phase);

export const STOP_SEALING_PROMPT = 'Stop sealing? Files already sealed stay in your vault.';

export function createTransfersManager(deps) {
  const {
    loadRuntime,
    slots,
    getToken: currentToken,
    subscribeToken: watchToken,
    importState = () => ({ status: 'idle' }),
    clearImport = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    newKey = newUploadKey,
    throttleMs = PROGRESS_THROTTLE_MS,
    window: win = typeof window === 'undefined' ? null : window,
  } = deps;

  let rows = [];
  let state = { rows: [], signOutPrompt: null, announce: '', batch: 0 };
  let nextId = 1;
  let batch = null;
  let lastEmit = 0;
  let timer = null;
  let pendingSignOut = null;
  let token = currentToken();
  const internal = new Map();
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener());
  const beforeUnload = (event) => {
    event.preventDefault();
    // eslint-disable-next-line no-param-reassign
    event.returnValue = 'Files are still being sealed. If you leave, they will stop.';
    return event.returnValue;
  };
  const guardUnload = (on) => {
    if (!win) return;
    if (on) win.addEventListener('beforeunload', beforeUnload);
    else win.removeEventListener('beforeunload', beforeUnload);
  };

  const overallPercent = () => {
    const live = rows.filter((row) => row.phase !== 'canceled');
    const total = live.reduce((sum, row) => sum + row.size, 0);
    if (total === 0) return live.length && live.every((row) => !isWorking(row)) ? 100 : 0;
    return Math.min(100, Math.floor((live.reduce((sum, row) => sum + (row.phase === 'sealed' ? row.size : row.bytesDone), 0) / total) * 100));
  };

  function publish({ force = false, announce = null } = {}) {
    const send = () => {
      timer = null;
      lastEmit = now();
      let line = announce ?? state.announce;
      if (announce === null && batch) {
        const step = Math.floor(overallPercent() / ANNOUNCE_STEP) * ANNOUNCE_STEP;
        if (step > batch.announcedStep && step < 100) {
          batch.announcedStep = step;
          line = `Sealing files: ${step}% done.`;
        }
      }
      state = { ...state, rows: rows.map((row) => ({ ...row, error: row.error ? { ...row.error } : null })), announce: line };
      emit();
    };
    if (force || announce !== null || now() - lastEmit >= throttleMs) {
      if (timer) clearTimer(timer);
      send();
    } else if (!timer) {
      timer = setTimer(send, throttleMs - (now() - lastEmit));
    }
  }

  const summary = () => {
    const sealed = rows.filter((row) => row.phase === 'sealed').length;
    const failed = rows.filter((row) => row.phase === 'failed').length;
    if (failed && sealed) return `Sealed ${sealed}, ${failed} failed.`;
    if (failed) return `${failed} failed.`;
    return `${sealed} file${sealed === 1 ? '' : 's'} sealed.`;
  };

  async function maybeFinishBatch() {
    if (!batch || rows.some(isWorking)) return;
    const finished = batch;
    batch = null;
    guardUnload(importState().status === 'running');
    publish({ force: true, announce: summary() });
    if (finished.touched) {
      try {
        const runtime = await loadRuntime();
        runtime.onFinished({
          sealed: rows.filter((row) => row.phase === 'sealed').length,
          replacedIds: rows.filter((row) => row.kind === 'newVersion' && row.phase === 'sealed').map((row) => row.resultId),
        });
      } catch {
      }
    }
  }

  const finishRow = (row, patch) => {
    Object.assign(row, { finishedAt: now(), ...patch });
    const mine = internal.get(row.id);
    if (mine) {
      mine.controller = null;
      if (row.phase === 'sealed' || row.phase === 'canceled') internal.delete(row.id);
    }
  };

  async function run(row) {
    const mine = internal.get(row.id);
    if (!mine) return;
    const controller = new AbortController();
    mine.controller = controller;
    try {
      await slots.acquire(controller.signal);
    } catch {
      finishRow(row, { phase: 'canceled', state: 'canceled', error: { message: 'Canceled.', code: 'canceled', retryable: false } });
      publish({ force: true });
      maybeFinishBatch();
      return;
    }
    try {
      row.phase = 'sending';
      row.state = 'running';
      row.startedAt = now();
      publish({ force: true });
      const runtime = await loadRuntime();
      if (batch?.limited && row.kind === 'upload') throw Object.assign(new Error(), { described: batch.limited });
      const onProgress = (percent) => {
        if (controller.signal.aborted) return;
        row.bytesDone = Math.round((row.size * percent) / 100);
        if (percent >= 100 && row.phase === 'sending') row.phase = 'sealing';
        publish({ force: row.phase === 'sealing' && row.bytesDone === row.size });
      };
      let data;
      if (row.kind === 'newVersion') data = await runtime.uploadNewVersion(mine.documentId, mine.file, onProgress, { signal: controller.signal });
      else data = await runtime.uploadDocument({ file: mine.file, folder: mine.folder || undefined, expiryDate: mine.expiryDate, signal: controller.signal, uploadKey: row.uploadKey }, onProgress);
      batch ??= { announcedStep: 0, total: 0, touched: true };
      batch.touched = true;
      const folder = data?.folder && data.folder !== 'root' ? data.folder : '';
      finishRow(row, {
        phase: 'sealed',
        state: 'done',
        bytesDone: row.size,
        error: null,
        resultId: data?.id ?? row.documentId ?? null,
        destination: row.kind === 'upload' ? folder : folder || row.destination,
        savedAs: data?.nameChanged ? data.filename : null,
        held: data?.held,
        unchecked: data?.scan === 'unchecked',
      });
    } catch (error) {
      if (batch) batch.touched = true;
      if (controller.signal.aborted) {
        const wasSealing = row.phase === 'sealing';
        finishRow(row, {
          phase: 'canceled',
          state: 'canceled',
          error: {
            message: wasSealing ? 'Canceled while sealing. It may already be in your vault: the list is refreshed.' : 'Canceled. Nothing was saved.',
            code: 'canceled',
            retryable: false,
            maybeSaved: wasSealing,
          },
        });
      } else if (row.kind === 'newVersion' && error?.response?.data?.error?.code === 'VERSION_IDENTICAL') {
        finishRow(row, { phase: 'sealed', state: 'done', bytesDone: row.size, error: null, resultId: mine.documentId });
      } else {
        const described = describeTransferError(error);
        if (described.limit && batch) batch.limited ??= described;
        finishRow(row, { phase: 'failed', state: 'failed', error: described });
      }
    } finally {
      slots.release();
    }
    publish({ force: true });
    maybeFinishBatch();
  }

  const api = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning: () => rows.some(isWorking) || importState().status === 'running',

    enqueue(items) {
      const ids = [];
      for (const item of items) {
        const id = nextId;
        nextId += 1;
        const row = {
          id,
          kind: item.kind,
          name: item.file.name,
          size: item.file.size,
          phase: item.refused ? 'failed' : 'waiting',
          state: item.refused ? 'failed' : 'queued',
          bytesDone: 0,
          error: item.refused || null,
          destination: item.destination ?? item.folder ?? '',
          resultId: null,
          documentId: item.documentId ?? null,
          uploadKey: item.kind === 'upload' ? newKey() : null,
          savedAs: null,
          startedAt: 0,
          finishedAt: 0,
        };
        rows.push(row);
        if (!item.refused) internal.set(id, { file: item.file, folder: item.folder, expiryDate: item.expiryDate, documentId: item.documentId, controller: null });
        ids.push(id);
      }
      if (ids.length === 0) return ids;
      const live = ids.filter((id) => rows.find((row) => row.id === id).phase === 'waiting');
      if (live.length && !batch) batch = { announcedStep: 0, total: 0, touched: false };
      if (live.length) guardUnload(true);
      publish({ force: true, announce: live.length ? `Sealing ${live.length} file${live.length === 1 ? '' : 's'}.` : '' });
      for (const id of live) run(rows.find((row) => row.id === id));
      return ids;
    },

    cancel(id) {
      const row = rows.find((entry) => entry.id === id);
      const mine = internal.get(id);
      if (!row || !isWorking(row) || !mine?.controller) return;
      mine.controller.abort();
    },
    cancelAll() {
      for (const row of rows) if (isWorking(row)) api.cancel(row.id);
    },

    retry(id) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || row.phase !== 'failed' || !row.error?.retryable || !internal.get(id)) return;
      Object.assign(row, { phase: 'waiting', state: 'queued', bytesDone: 0, error: null, finishedAt: 0 });
      if (!batch) batch = { announcedStep: 0, total: 0, touched: false };
      batch.limited = null;
      guardUnload(true);
      publish({ force: true });
      run(row);
    },

    dismiss(id) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || isWorking(row)) return;
      rows = rows.filter((entry) => entry.id !== id);
      internal.delete(id);
      publish({ force: true });
    },
    dismissFinished() {
      rows = rows.filter((row) => {
        if (isWorking(row)) return true;
        internal.delete(row.id);
        return false;
      });
      publish({ force: true });
    },

    clear() {
      for (const mine of internal.values()) mine.controller?.abort();
      internal.clear();
      rows = [];
      batch = null;
      if (timer) clearTimer(timer);
      timer = null;
      guardUnload(importState().status === 'running');
      state = { rows: [], signOutPrompt: null, announce: '', batch: state.batch + 1 };
      emit();
    },

    requestSignOut(action, { confirm = false } = {}) {
      const importing = importState().status === 'running';
      const working = importing || rows.some(isWorking);
      if (!working && !confirm) return Promise.resolve(action()).then(() => true);
      if (pendingSignOut) return Promise.resolve(false);
      return new Promise((resolve) => {
        pendingSignOut = { action, resolve };
        state = {
          ...state,
          signOutPrompt: { confirm, working, text: importing ? 'An import is running. Stop it and sign out?' : 'Files are still being sealed. Stop sealing and sign out?', importing },
        };
        emit();
      });
    },
    async answerSignOut(stop) {
      const pending = pendingSignOut;
      pendingSignOut = null;
      if (!pending) return;
      state = { ...state, signOutPrompt: null };
      emit();
      if (!stop) {
        pending.resolve(false);
        return;
      }
      clearImport();
      api.clear();
      await pending.action();
      pending.resolve(true);
    },
  };

  watchToken((next) => {
    const previous = token;
    token = next;
    if (next === previous) return;
    if (next && !previous) return;
    if (rows.length === 0 && !state.signOutPrompt) return;
    api.clear();
  });

  return api;
}

export const transfers = createTransfersManager({
  loadRuntime: () => import('./transferRuntime.js').then((module) => module.runtime),
  slots: uploadSlots,
  getToken,
  subscribeToken,
  importState: () => importJob.getState(),
  clearImport: () => importJob.clear(),
});

export function useTransfers() {
  return useSyncExternalStore(transfers.subscribe, transfers.getState, transfers.getState);
}
