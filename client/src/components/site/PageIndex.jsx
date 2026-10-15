import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import styles from './PageIndex.module.css';

/** The id of the section nearest the top of the screen, kept up to date while scrolling. Null at the very top. */
function useActiveSection(ids) {
  const [active, setActive] = useState(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => seen.set(entry.target.id, entry.isIntersecting));
        const current = ids.find((id) => seen.get(id));
        setActive(current ?? null);
      },
      // A band across the upper middle of the screen: the section crossing it is "current".
      { rootMargin: '-25% 0px -65% 0px', threshold: 0 }
    );
    // The sections below the hero arrive in their own chunk, so some ids are not in the page yet: keep looking for a while.
    const watching = new Set();
    const attach = () => {
      ids.forEach((id) => {
        const node = watching.has(id) ? null : document.getElementById(id);
        if (node) {
          observer.observe(node);
          watching.add(id);
        }
      });
      return watching.size === ids.length;
    };
    const timer = attach() ? null : setInterval(() => attach() && clearInterval(timer), 250);
    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, [ids]);
  return active;
}

/**
 * A slim bar of in-page links under the header: sticks while the page scrolls, highlights the section you are in and
 * scrolls smoothly (the layout does the scrolling when the hash changes). On a phone it scrolls sideways.
 */
function PageIndex({ items }) {
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const active = useActiveSection(ids);
  return (
    <nav className={styles.bar} aria-label="On this page">
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id}>
            <Link to={`/#${item.id}`} className={styles.link} aria-current={active === item.id ? 'location' : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default PageIndex;
