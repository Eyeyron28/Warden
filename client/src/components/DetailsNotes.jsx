import { useEffect, useRef, useState } from 'react';

import { MAX_NOTE_CHARS, setDocumentNote } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './DetailsPanel.module.css';

function DetailsNotes({ id, note, onSaved }) {
  const [text, setText] = useState(note ?? '');
  const [saved, setSaved] = useState(note ?? '');
  const [state, setState] = useState({ phase: 'idle', message: '' });
  const live = useRef({ text, saved, id });
  const mounted = useRef(true);
  live.current = { text, saved, id };

  const save = async (value) => {
    const next = value.trim() === '' ? '' : value;
    if (next === live.current.saved) return;
    if (mounted.current) setState({ phase: 'saving', message: '' });
    try {
      const result = await setDocumentNote(live.current.id, next);
      const stored = result.note ?? '';
      live.current.saved = stored;
      if (mounted.current) {
        setSaved(stored);
        if (stored === '') setText('');
        setState({ phase: 'saved', message: stored === '' ? 'Note removed.' : 'Saved.' });
      }
      onSaved?.(result.note);
    } catch (err) {
      if (mounted.current) setState({ phase: 'error', message: extractErrorMessage(err, 'Could not save the note.') });
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const { text: typed, saved: stored } = live.current;
      if (typed !== stored && !(typed.trim() === '' && stored === '')) save(typed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = text !== saved && !(text.trim() === '' && saved === '');

  return (
    <section className={styles.notes} aria-labelledby={`note-label-${id}`}>
      <h3 id={`note-label-${id}`} className={styles.sub}>
        Private note
      </h3>
      <textarea
        className={styles.noteBox}
        value={text}
        rows={4}
        maxLength={MAX_NOTE_CHARS}
        onChange={(event) => {
          setText(event.target.value);
          if (state.phase !== 'idle') setState({ phase: 'idle', message: '' });
        }}
        onBlur={() => save(text)}
        placeholder="Only you can see this. For example where the original is kept."
        aria-labelledby={`note-label-${id}`}
        aria-describedby={`note-help-${id}`}
        spellCheck
      />
      <div className={styles.noteBar}>
        <span className={styles.counter} aria-live="off">
          {text.length} / {MAX_NOTE_CHARS}
        </span>
        <span className={styles.noteStatus} role="status">
          {state.phase === 'saving' ? 'Saving…' : state.message}
        </span>
        <button
          type="button"
          className={styles.smallButton}
          onClick={() => save(text)}
          disabled={!dirty || state.phase === 'saving'}
        >
          Save
        </button>
        <button
          type="button"
          className={styles.smallButton}
          onClick={() => {
            setText('');
            save('');
          }}
          disabled={text === '' && saved === ''}
        >
          Clear
        </button>
      </div>
      {state.phase === 'error' && (
        <p className={styles.error} role="alert">
          {state.message}
        </p>
      )}
      <p id={`note-help-${id}`} className={styles.help}>
        This note is encrypted with your vault key and is not searchable. It is never added to a share link, and an emergency contact
        never sees it.
      </p>
    </section>
  );
}

export default DetailsNotes;
