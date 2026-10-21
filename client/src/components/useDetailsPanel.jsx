import { Suspense, lazy, useState } from 'react';

const DetailsPanel = lazy(() => import('./DetailsPanel.jsx'));

export function useDetailsPanel({ isStarred, toggleStar, onChanged }) {
  const [target, setTarget] = useState(null);
  const element = target ? (
    <Suspense fallback={null}>
      <DetailsPanel
        key={target.id}
        id={target.id}
        name={target.name}
        opener={target.opener}
        starred={isStarred(target.id)}
        onToggleStar={() => toggleStar(target.id)}
        onChanged={onChanged}
        onClose={() => setTarget(null)}
      />
    </Suspense>
  ) : null;
  return { show: (id, name, opener) => setTarget({ id, name, opener }), element };
}
