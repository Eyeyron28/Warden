import { X } from '@phosphor-icons/react';

import styles from './Banner.module.css';

/**
 * An inline message box. The page passes its own class (colors and padding), the role and the message. With onDismiss a
 * Dismiss button sits at the right end; the page clears the message state, so the same action can show it again.
 */
function Banner({ as: Tag = 'div', className = '', onDismiss, children, ...rest }) {
  if (!onDismiss) return <Tag className={className} {...rest}>{children}</Tag>;
  return (
    <Tag className={`${className} ${styles.withClose}`} {...rest}>
      {children}
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={onDismiss}>
        <X size={16} weight="bold" aria-hidden="true" />
      </button>
    </Tag>
  );
}

export default Banner;
