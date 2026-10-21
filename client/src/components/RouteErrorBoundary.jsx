import { Component } from 'react';

import { isChunkFailure } from '../utils/chunkFailure.js';
import styles from './RouteErrorBoundary.module.css';

class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkFailure(error);
    return (
      <div className={styles.box} role="alert">
        <h2 className={styles.title}>{stale ? 'A new version of Warden is available' : 'This page could not be shown'}</h2>
        <p className={styles.text}>
          {stale
            ? 'This tab is running an older version. Reload to get the new one; you stay signed in.'
            : 'Something went wrong while drawing this page. The rest of the app still works: pick another page, or try this one again.'}
        </p>
        <div className={styles.actions}>
          {stale ? (
            <button type="button" className={styles.primary} onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : (
            <button type="button" className={styles.primary} onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }
}

export default RouteErrorBoundary;
