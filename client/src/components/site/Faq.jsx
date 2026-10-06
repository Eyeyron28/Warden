import { useId, useState } from 'react';

import Icon from './Icon.jsx';
import styles from './Faq.module.css';

/**
 * Accessible accordion: each question is a real <button> inside a
 * heading, with aria-expanded/aria-controls pointing at its answer
 * region. Several can be open at once.
 */
function Faq({ items }) {
  const baseId = useId();
  const [open, setOpen] = useState(() => new Set());

  const toggle = (index) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className={styles.faq}>
      {items.map((item, index) => {
        const isOpen = open.has(index);
        const buttonId = `${baseId}-q${index}`;
        const panelId = `${baseId}-a${index}`;
        return (
          <div key={item.question} className={styles.item}>
            <h3 className={styles.heading}>
              <button
                type="button"
                id={buttonId}
                className={styles.question}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(index)}
              >
                <span>{item.question}</span>
                <Icon name="chevronDown" className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              className={styles.answer}
              hidden={!isOpen}
            >
              {item.answer}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default Faq;
