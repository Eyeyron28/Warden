import { useEffect, useRef, useState } from 'react';

import FileTypeIcon from './FileTypeIcon.jsx';
import { getCachedThumbnail, releaseThumbnail, requestThumbnail } from '../services/thumbnailCache.js';
import styles from './DocumentThumb.module.css';

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

  const iconSize = variant === 'row' ? 20 : variant === 'fill' ? 44 : 34;

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
