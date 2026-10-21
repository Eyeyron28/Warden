import { X } from '@phosphor-icons/react';

import styles from './Banner.module.css';

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
