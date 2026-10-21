import { useCallback, useEffect, useRef, useState } from 'react';

import { createDragCounter, hasFiles } from './fileDrag.js';

export function useFileDrag(accept = hasFiles) {
  const [active, setActive] = useState(false);
  const counter = useRef(createDragCounter());

  const reset = useCallback(() => {
    counter.current.reset();
    setActive(false);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => event.key === 'Escape' && reset();
    const onHidden = () => document.hidden && reset();
    const onLeaveWindow = (event) => !event.relatedTarget && reset();
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHidden);
    document.addEventListener('dragleave', onLeaveWindow);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('dragleave', onLeaveWindow);
    };
  }, [active, reset]);

  const handlers = {
    onDragEnter: (event) => {
      if (!accept(event)) return;
      counter.current.enter();
      setActive(true);
    },
    onDragOver: (event) => {
      if (!accept(event)) return;
      if (!counter.current.active) counter.current.enter();
      setActive(true);
    },
    onDragLeave: (event) => {
      if (!accept(event)) return;
      if (!counter.current.leave()) setActive(false);
    },
  };
  return { active, reset, handlers };
}
