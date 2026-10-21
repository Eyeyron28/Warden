import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, Camera, Plus, Trash } from '@phosphor-icons/react';

import Modal from '../Modal.jsx';
import CropOverlay from './CropOverlay.jsx';
import { getStorage } from '../../services/documentsService.js';
import { transfers } from '../../services/transfers.js';
import { validateUpload } from '../../utils/transferRules.js';
import { extractErrorMessage } from '../../services/api.js';
import { FULL_CROP, cleanScanName, defaultScanName, rotateCrop } from '../../utils/scan/imageOps.js';
import { applyDocumentMode, canvasToJpeg, loadPage, releaseCanvas, renderFinal, renderRotated } from '../../utils/scan/canvasOps.js';
import { planScan } from '../../utils/scan/scanPlan.js';
import styles from './ScanDialog.module.css';

export const MAX_PAGES = 10;
const PREVIEW_SIDE = 900;
const GALLERY_NOTICE = "Your phone's camera app may keep its own copy of the photo in your gallery. Delete it there after saving.";

let nextId = 1;

const makePage = (loaded) => ({
  id: nextId++,
  work: loaded.work,
  rotation: 0,
  crop: { ...FULL_CROP },
  documentMode: false,
  threshold: 0,
});

function Preview({ page }) {
  const canvas = useRef(null);
  const { work, rotation, documentMode, threshold } = page;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = canvas.current;
      if (!target || work.width === 0) return;
      const drawn = renderRotated(work, rotation, PREVIEW_SIDE);
      if (documentMode) applyDocumentMode(drawn, threshold);
      target.width = drawn.width;
      target.height = drawn.height;
      target.getContext('2d').drawImage(drawn, 0, 0);
      releaseCanvas(drawn);
    });
    return () => cancelAnimationFrame(frame);
  }, [work, rotation, documentMode, threshold]);

  return <canvas ref={canvas} className={styles.canvas} role="img" aria-label="Preview of this page" />;
}

function ScanDialog({ folderPaths = [], currentPath = '', onClose }) {
  const [step, setStep] = useState('edit');
  const [pages, setPages] = useState([]);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(() => defaultScanName());
  const [folder, setFolder] = useState(currentPath);
  const [format, setFormat] = useState('pdf');
  const [work, setWork] = useState({ busy: false, label: '', percent: 0 });
  const [tooLarge, setTooLarge] = useState(null);
  const input = useRef(null);
  const pagesRef = useRef(pages);
  const alive = useRef(true);
  const saving = useRef(false);
  pagesRef.current = pages;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const page of pagesRef.current) releaseCanvas(page.work);
    };
  }, []);

  const page = pages[Math.min(current, pages.length - 1)];
  const update = useCallback((id, patch) => setPages((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item))), []);

  const addFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (pages.length >= MAX_PAGES) {
      setError(`A scan can have up to ${MAX_PAGES} pages.`);
      return;
    }
    setError('');
    setLoading(true);
    try {
      const loaded = await loadPage(file);
      if (!alive.current) {
        releaseCanvas(loaded.work);
        return;
      }
      setPages((list) => [...list, makePage(loaded)]);
      setCurrent(pages.length);
      setStep('edit');
    } catch {
      if (alive.current) setError('That file could not be read as a picture. Try another photo.');
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  const removePage = () => {
    if (!page) return;
    releaseCanvas(page.work);
    setPages((list) => list.filter((item) => item.id !== page.id));
    setCurrent((value) => Math.max(0, Math.min(value, pages.length - 2)));
  };

  const turn = (direction) => update(page.id, { rotation: page.rotation + (direction === 'right' ? 90 : -90), crop: rotateCrop(page.crop, direction) });

  const save = async (chosenFormat = format) => {
    if (saving.current) return;
    saving.current = true;
    const cleaned = cleanScanName(name);
    if (!cleaned) {
      setError('Give the scan a name.');
      saving.current = false;
      return;
    }
    setError('');
    setTooLarge(null);
    setWork({ busy: true, label: 'Preparing your scan…', percent: 0 });
    const canvases = pages.map((item) => renderFinal(item));
    try {
      const cache = new Map();
      const encode = async (index, quality) => {
        const key = `${index}:${quality}`;
        if (!cache.has(key)) cache.set(key, await canvasToJpeg(canvases[index], quality));
        return cache.get(key);
      };
      const plan = await planScan({
        count: canvases.length,
        format: chosenFormat,
        encode,
        sizeOf: (index) => ({ width: canvases[index].width, height: canvases[index].height }),
      });
      cache.clear();
      if (!plan.ok) {
        setTooLarge(plan);
        return;
      }
      const files = plan.files.map((item) => new File([item.bytes], `${cleaned}${item.suffix}.${item.type === 'application/pdf' ? 'pdf' : 'jpg'}`, { type: item.type }));
      const usage = await getStorage().catch(() => null);
      let pending = 0;
      for (const item of files) {
        const check = validateUpload(item, { usage, pendingBytes: pending });
        if (!check.ok) {
          setError(check.reason);
          return;
        }
        pending += item.size;
      }
      transfers.enqueue(files.map((item) => ({ kind: 'upload', file: item, folder: folder || '' })));
      onClose();
    } catch (err) {
      if (alive.current) setError(extractErrorMessage(err, 'Could not prepare the scan.'));
    } finally {
      saving.current = false;
      for (const canvas of canvases) releaseCanvas(canvas);
      if (alive.current) setWork({ busy: false, label: '', percent: 0 });
    }
  };

  const folderOptions = useMemo(() => {
    const set = new Set(['', currentPath, ...folderPaths.filter((path) => path && path !== 'root')]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [folderPaths, currentPath]);

  const guardedClose = () => {
    if (!work.busy) onClose();
  };

  return (
    <Modal title="Scan documents" onClose={guardedClose} wide>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} aria-hidden="true" data-testid="scan-input" onChange={addFile} />

      {step === 'edit' && (
        <>
          {pages.length === 0 ? (
            <div className={styles.start}>
              <Camera size={40} weight="light" aria-hidden="true" />
              <p>Take a photo of a page with your phone&apos;s camera, or choose a picture. You can add up to {MAX_PAGES} pages.</p>
              <button type="button" className={styles.primary} onClick={() => input.current?.click()} disabled={loading}>
                <Camera size={18} /> {loading ? 'Reading the photo…' : 'Take a photo or choose a picture'}
              </button>
            </div>
          ) : (
            <>
              <div className={styles.pageBar} role="group" aria-label="Pages">
                {pages.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.pageButton}
                    aria-current={index === Math.min(current, pages.length - 1) ? 'true' : undefined}
                    onClick={() => setCurrent(index)}
                  >
                    Page {index + 1}
                  </button>
                ))}
                {pages.length < MAX_PAGES && (
                  <button type="button" className={styles.addPage} onClick={() => input.current?.click()} disabled={loading}>
                    <Plus size={14} weight="bold" /> {loading ? 'Reading…' : 'Add page'}
                  </button>
                )}
                <span className={styles.count}>
                  {pages.length} of {MAX_PAGES}
                </span>
              </div>

              <div className={styles.stage}>
                <div className={styles.frame}>
                  <Preview page={page} />
                  <CropOverlay crop={page.crop} onChange={(crop) => update(page.id, { crop })} />
                </div>
              </div>

              <div className={styles.tools}>
                <button type="button" className={styles.tool} onClick={() => turn('left')}>
                  <ArrowCounterClockwise size={18} /> Rotate left
                </button>
                <button type="button" className={styles.tool} onClick={() => turn('right')}>
                  <ArrowClockwise size={18} /> Rotate right
                </button>
                <button type="button" className={styles.tool} onClick={() => update(page.id, { crop: { ...FULL_CROP } })}>
                  Reset crop
                </button>
                <button type="button" className={styles.tool} onClick={removePage}>
                  <Trash size={18} /> Remove page
                </button>
              </div>

              <div className={styles.docMode}>
                <label className={styles.check}>
                  <input type="checkbox" checked={page.documentMode} onChange={(event) => update(page.id, { documentMode: event.target.checked })} />
                  <span>
                    <strong>Document mode</strong> <span className={styles.muted}>high-contrast black and white, for text</span>
                  </span>
                </label>
                <label className={styles.slider}>
                  <span>Black and white level {page.threshold === 0 ? '(off)' : page.threshold}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={page.threshold}
                    disabled={!page.documentMode}
                    onChange={(event) => update(page.id, { threshold: Number(event.target.value) })}
                  />
                </label>
              </div>
            </>
          )}

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <p className={styles.notice}>{GALLERY_NOTICE}</p>

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={guardedClose}>
              Cancel
            </button>
            <button type="button" className={styles.primary} disabled={pages.length === 0 || loading} onClick={() => { setError(''); setStep('save'); }}>
              Next: save
            </button>
          </div>
        </>
      )}

      {step === 'save' && (
        <form
          className={styles.saveForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!work.busy) save();
          }}
        >
          <label className={styles.field} data-required>
            <span>Name</span>
            <input type="text" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} disabled={work.busy} required />
          </label>
          <label className={styles.field}>
            <span>Folder</span>
            <select value={folder} onChange={(event) => setFolder(event.target.value)} disabled={work.busy}>
              {folderOptions.map((path) => (
                <option key={path || 'root'} value={path}>
                  {path || 'My files'}
                </option>
              ))}
            </select>
          </label>
          <fieldset className={styles.formats} disabled={work.busy}>
            <legend>Format</legend>
            <label className={styles.check}>
              <input type="radio" name="scan-format" checked={format === 'pdf'} onChange={() => { setFormat('pdf'); setTooLarge(null); }} />
              <span>PDF (all pages in one file)</span>
            </label>
            <label className={styles.check}>
              <input type="radio" name="scan-format" checked={format === 'images'} onChange={() => { setFormat('images'); setTooLarge(null); }} />
              <span>Images (JPEG){pages.length > 1 ? ', one file per page' : ''}</span>
            </label>
          </fieldset>
          <p className={styles.muted}>
            {pages.length} page{pages.length === 1 ? '' : 's'}. Pages are made at most about 2000 pixels on the longest side and compressed to fit the 4 MB limit for a file.
          </p>

          {tooLarge && (
            <div className={styles.error} role="alert">
              <p>
                {tooLarge.format === 'pdf'
                  ? `These ${tooLarge.pages} pages do not fit in one PDF under the 4 MB limit, even at the lowest quality.`
                  : `Page ${tooLarge.failedPage} does not fit under the 4 MB limit, even at the lowest quality.`}{' '}
                Save fewer pages{tooLarge.separateWouldFit ? ', or save them as separate images' : ''}.
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} onClick={() => { setTooLarge(null); setStep('edit'); }}>
                  Back to the pages
                </button>
                {tooLarge.separateWouldFit && (
                  <button type="button" className={styles.primary} onClick={() => { setFormat('images'); save('images'); }}>
                    Save as separate images
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {work.busy && (
            <div role="status" className={styles.progress}>
              {work.label} {work.percent > 0 ? `${work.percent}%` : ''}
              <progress max="100" value={work.percent || undefined} aria-label="Saving" />
            </div>
          )}
          <p className={styles.notice}>{GALLERY_NOTICE}</p>
          <p className={styles.muted}>The pages exist only in this window until you save or cancel; cancelling discards them.</p>

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setStep('edit')} disabled={work.busy}>
              Back
            </button>
            <button type="submit" className={styles.primary} disabled={work.busy}>
              {work.busy ? 'Saving…' : 'Save to the vault'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default ScanDialog;
