import { useEffect, useRef, useState } from 'react';

import FileTypeIcon from './FileTypeIcon.jsx';
import { getCachedThumbnail, releaseThumbnail, requestThumbnail } from '../services/thumbnailCache.js';
import styles from './DocumentThumb.module.css';

/**
 * Preview for a document card or row. Always the same fixed box (no layout
 * shift), showing, in order of preference:
 *   - the decrypted thumbnail, once it has loaded;
 *   - a soft shimmer while it is loading;
 *   - the file-type icon when the document has no thumbnail, or fetching or
 *     decrypting it failed.
 *
 * A thumbnail is only requested once the box scrolls into view, so a long
 * list costs nothing for the documents nobody has scrolled to.
 */
function DocumentThumb({ document, variant = 'card' }) {
  const { id, filename, hasThumb } = document;
  const boxRef = useRef(null);
  const [src, setSrc] = useState(() => (hasThumb ? getCachedThumbnail(id) ?? null : null));
  const [state, setState] = useState(() => {
    if (!hasThumb) return 'none';
    const cached = getCachedThumbnail(id);
    if (cached) return 'ready';
    return cached === null ? 'none' : 'idle';
  });

  useEffect(() => {
    if (!hasThumb) {
      setState('none');
      return undefined;
    }
    const cached = getCachedThumbnail(id);
    if (cached) {
      setSrc(cached);
      setState('ready');
      return undefined;
    }
    if (cached === null) {
      setState('none');
      return undefined;
    }

    let cancelled = false;
    let requested = false;
    const node = boxRef.current;

    const start = () => {
      if (requested) return;
      requested = true;
      setState('loading');
      requestThumbnail(id).then((url) => {
        if (cancelled) return;
        if (url) {
          setSrc(url);
          setState('ready');
        } else {
          // undefined = the session ended meanwhile; null = no usable thumbnail.
          setState('none');
        }
      });
    };

    if (typeof IntersectionObserver === 'undefined' || !node) {
      start();
      return () => {
        cancelled = true;
        if (requested) releaseThumbnail(id);
      };
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (requested) releaseThumbnail(id);
    };
  }, [id, hasThumb]);

  const iconSize = variant === 'row' ? 18 : variant === 'fill' ? 44 : 34;

  return (
    <span ref={boxRef} className={`${styles.box} ${styles[variant]}`} data-state={state}>
      {state === 'ready' && src ? (
        <img src={src} alt={filename} className={styles.image} draggable={false} decoding="async" />
      ) : (
        <>
          {state === 'loading' && <span className={styles.shimmer} aria-hidden="true" />}
          <FileTypeIcon filename={filename} size={iconSize} />
        </>
      )}
    </span>
  );
}

export default DocumentThumb;
