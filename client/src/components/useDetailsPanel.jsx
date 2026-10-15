import { Suspense, lazy, useState } from 'react';

// The panel is loaded the first time someone opens it, so it is not part of the main bundle.
const DetailsPanel = lazy(() => import('./DetailsPanel.jsx'));

/**
 * Opening and closing the details panel for a file. `isStarred(id)` and `toggleStar(id)` come from the page (the star is shown
 * and changed inside the panel too). Returns `show(id, name, opener)` and the `element` to render once in the page.
 */
export function useDetailsPanel({ isStarred, toggleStar }) {
  const [target, setTarget] = useState(null); // { id, name, opener }
  const element = target ? (
    <Suspense fallback={null}>
      <DetailsPanel
        key={target.id}
        id={target.id}
        name={target.name}
        opener={target.opener}
        starred={isStarred(target.id)}
        onToggleStar={() => toggleStar(target.id)}
        onClose={() => setTarget(null)}
      />
    </Suspense>
  ) : null;
  return { show: (id, name, opener) => setTarget({ id, name, opener }), element };
}
