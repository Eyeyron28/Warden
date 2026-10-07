import { useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import {
  getOwnerManifest,
  getShareProtection,
  removeSharePassword,
  setSharePassword,
  updateShare,
} from '../services/sharesService.js';
import { extractErrorMessage } from '../services/api.js';
import { decryptManifest, importShareKey } from '../utils/shareCrypto.js';
import {
  KDF_PARAMS,
  deriveShareSecrets,
  parseShareLink,
  passwordProblem,
  randomSalt,
  toBase64,
  toBase64Url,
  unwrapShareKey,
  wrapShareKey,
} from '../utils/sharePassword.js';
import { formatDateTime } from '../utils/formatDate.js';
import { getNowDateTimeInputValue } from '../utils/dateInputs.js';
import styles from './ShareModal.module.css';

const PRESETS = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];

const linkFor = (shareId) => `${window.location.origin}/shared/${shareId}`;

/** One labelled block of the dialog with its own status line. */
function Section({ title, hint, children, error, note }) {
  return (
    <section className={styles.field} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
      <span className={styles.label}>{title}</span>
      {hint && <p className={styles.hint}>{hint}</p>}
      {children}
      <p className={styles.error} role="alert" style={{ minHeight: 0 }}>
        {error}
      </p>
      {note && !error && <p className={styles.hint}>{note}</p>}
    </section>
  );
}

/**
 * Edit one share without re-uploading anything: expiry (within 30 days of
 * creation), download limit, recipient email, and the link password.
 *
 * The share key is not stored anywhere, so the password operations need it
 * from somewhere the owner holds: ADDING a password needs the original link
 * (pasted here - it stays in this browser), CHANGING or REMOVING one needs the
 * current password (which unlocks the key from the wrapped copy).
 */
function ShareEditModal({ share, onClose, onChanged }) {
  const [status, setStatus] = useState({}); // section -> { busy, error, note }
  const set = (section, patch) => setStatus((current) => ({ ...current, [section]: { ...current[section], ...patch } }));
  const of = (section) => status[section] || {};

  // expiry
  const [hours, setHours] = useState(null);
  const [customExpiry, setCustomExpiry] = useState('');
  const maxEnd = new Date(share.maxExpiresAt).getTime();
  const customMs = customExpiry ? new Date(customExpiry).getTime() : null;
  const customHours = customMs ? (customMs - Date.now()) / 3600000 : null;
  const customOk = customMs !== null && customMs > Date.now() && customMs <= maxEnd;

  // limits
  const [maxText, setMaxText] = useState(share.maxDownloads ? String(share.maxDownloads) : '');
  const [email, setEmail] = useState(share.recipientEmail || '');

  // password
  const [pastedLink, setPastedLink] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [resultLink, setResultLink] = useState('');
  const [copied, setCopied] = useState(false);

  const run = async (section, task, doneNote) => {
    set(section, { busy: true, error: '', note: '' });
    try {
      await task();
      set(section, { busy: false, note: doneNote });
      await onChanged();
    } catch (err) {
      set(section, { busy: false, error: err?.userMessage || extractErrorMessage(err, 'That didn’t work. Please try again.') });
    }
  };
  const fail = (message) => Object.assign(new Error(message), { userMessage: message });

  const saveExpiry = () => {
    const value = hours ?? customHours;
    return run('expiry', () => updateShare(share.id, { durationHours: value }), 'Expiry updated.');
  };
  const saveMax = () => {
    const value = maxText.trim() === '' ? null : Number(maxText);
    return run('max', () => updateShare(share.id, { maxDownloads: value }), value === null ? 'No download limit.' : 'Download limit updated.');
  };
  const saveEmail = (value) =>
    run('email', () => updateShare(share.id, { recipientEmail: value }), value ? 'Restricted to that address.' : 'Anyone with the link can open it.');

  // ---- password ----
  const wrapAndSave = async (keyBytes, password) => {
    const salt = randomSalt();
    const { wrapKey, verifier } = await deriveShareSecrets(password, salt);
    const wrappedKey = await wrapShareKey(keyBytes, wrapKey, share.id);
    await setSharePassword(share.id, { salt: toBase64(salt), kdf: KDF_PARAMS, wrappedKey, verifier });
  };

  const unlockWithCurrent = async (password) => {
    const protection = await getShareProtection(share.id);
    if (!protection.passwordProtected) throw fail('This share has no password.');
    const { wrapKey } = await deriveShareSecrets(password, Uint8Array.from(atob(protection.salt), (c) => c.charCodeAt(0)), protection.kdf);
    try {
      return await unwrapShareKey(protection.wrappedKey, wrapKey, share.id);
    } catch {
      throw fail('That is not the current password.');
    }
  };

  const addPassword = () =>
    run(
      'password',
      async () => {
        const problem = passwordProblem(newPw);
        if (problem) throw fail(problem);
        const parsed = parseShareLink(pastedLink);
        if (!parsed || parsed.shareId !== share.id || !parsed.keyText) {
          throw fail('Paste the full original link for this share, including everything after the #.');
        }
        // Check the pasted key really opens this share before locking it away.
        try {
          const { manifest } = await getOwnerManifest(share.id);
          await decryptManifest(await importShareKey(parsed.keyText), share.id, manifest);
        } catch {
          throw fail('That link’s key does not open this share.');
        }
        const keyBytes = Uint8Array.from(atob(parsed.keyText.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0));
        await wrapAndSave(keyBytes, newPw);
        setResultLink(linkFor(share.id));
        setPastedLink('');
        setNewPw('');
      },
      'Password added. The old link no longer opens it without the password.'
    );

  const changePassword = () =>
    run(
      'password',
      async () => {
        const problem = passwordProblem(newPw);
        if (problem) throw fail(problem);
        const keyBytes = await unlockWithCurrent(currentPw);
        await wrapAndSave(keyBytes, newPw);
        setResultLink(linkFor(share.id));
        setCurrentPw('');
        setNewPw('');
      },
      'Password changed. The old password no longer works.'
    );

  const removePassword = () =>
    run(
      'password',
      async () => {
        const keyBytes = await unlockWithCurrent(currentPw);
        await removeSharePassword(share.id);
        // The key goes back into the link, and only this browser has it now.
        setResultLink(`${linkFor(share.id)}#k=${toBase64Url(keyBytes)}`);
        setCurrentPw('');
      },
      'Password removed. Copy the new link now: it has the key in it, and we don’t keep it.'
    );

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(resultLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the link is visible in the field to copy by hand */
    }
  };

  const pw = of('password');

  return (
    <Modal title={`Edit "${share.name}"`} onClose={onClose}>
      <div className={styles.generateSection}>
        <p className={styles.hint}>
          Nothing is re-uploaded. We never keep a share&apos;s link or key, so changing the password needs your original
          link or the current password.
        </p>

        <Section
          title="Expires"
          hint={`Currently ${formatDateTime(share.expiresAt)}. A share can last at most 30 days from when it was made (until ${formatDateTime(share.maxExpiresAt)}).`}
          error={of('expiry').error}
          note={of('expiry').note}
        >
          <div className={styles.presetRow}>
            {PRESETS.map((preset) => {
              const tooLate = Date.now() + preset.hours * 3600000 > maxEnd;
              return (
                <button
                  key={preset.hours}
                  type="button"
                  className={`${styles.presetButton} ${hours === preset.hours ? styles.presetActive : ''}`}
                  disabled={tooLate || of('expiry').busy}
                  onClick={() => {
                    setHours(preset.hours);
                    setCustomExpiry('');
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <input
            type="datetime-local"
            className={styles.textInput}
            value={customExpiry}
            min={getNowDateTimeInputValue()}
            max={getNowDateTimeInputValue(maxEnd - Date.now())}
            onChange={(event) => {
              setCustomExpiry(event.target.value);
              setHours(null);
            }}
            aria-label="Custom expiry date and time"
            style={{ marginTop: 8 }}
          />
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={saveExpiry}
            disabled={of('expiry').busy || (hours === null && !customOk)}
            style={{ marginTop: 8 }}
          >
            Save expiry
          </button>
        </Section>

        <Section
          title="Download limit"
          hint={`${share.downloadCount} download${share.downloadCount === 1 ? '' : 's'} so far. After the limit (1 to 100) the share is deleted. Each file delivered counts once.`}
          error={of('max').error}
          note={of('max').note}
        >
          <input
            type="number"
            min="1"
            max="100"
            className={styles.textInput}
            value={maxText}
            onChange={(event) => setMaxText(event.target.value)}
            placeholder="No limit"
            aria-label="Maximum downloads"
          />
          <button type="button" className={styles.secondaryButton} onClick={saveMax} disabled={of('max').busy} style={{ marginTop: 8 }}>
            Save limit
          </button>
        </Section>

        <Section
          title="Only this email address"
          hint="The viewer must enter a 6-digit code emailed to this address before the server hands over anything. The link is still a secret: send it over a trusted channel."
          error={of('email').error}
          note={of('email').note}
        >
          <input
            type="email"
            className={styles.textInput}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Anyone with the link"
            autoComplete="off"
            aria-label="Recipient email"
          />
          <div className={styles.presetRow} style={{ marginTop: 8 }}>
            <button type="button" className={styles.secondaryButton} onClick={() => saveEmail(email.trim() || null)} disabled={of('email').busy}>
              Save
            </button>
            {share.emailRestricted && (
              <button type="button" className={styles.secondaryButton} onClick={() => { setEmail(''); saveEmail(null); }} disabled={of('email').busy}>
                Remove restriction
              </button>
            )}
          </div>
        </Section>

        <Section
          title={share.passwordProtected ? 'Password: on' : 'Password: off'}
          hint={
            share.passwordProtected
              ? 'Change it or remove it with the current password. Your browser unlocks the key with it and locks it again; we never see either password.'
              : 'To add a password, paste this share’s original link: its key is in the part after the #, and only your browser handles it.'
          }
          error={pw.error}
          note={pw.note}
        >
          {share.passwordProtected ? (
            <>
              <input type="password" className={styles.textInput} value={currentPw} onChange={(event) => setCurrentPw(event.target.value)} placeholder="Current password" autoComplete="off" aria-label="Current password" />
              <input type="password" className={styles.textInput} value={newPw} onChange={(event) => setNewPw(event.target.value)} placeholder="New password (to change it)" autoComplete="new-password" aria-label="New password" style={{ marginTop: 8 }} />
              <div className={styles.presetRow} style={{ marginTop: 8 }}>
                <button type="button" className={styles.secondaryButton} onClick={changePassword} disabled={pw.busy || !currentPw || !newPw}>
                  {pw.busy ? 'Working…' : 'Change password'}
                </button>
                <button type="button" className={styles.secondaryButton} onClick={removePassword} disabled={pw.busy || !currentPw}>
                  Remove password
                </button>
              </div>
            </>
          ) : (
            <>
              <input type="text" className={styles.textInput} value={pastedLink} onChange={(event) => setPastedLink(event.target.value)} placeholder="https://…/shared/…#k=…" autoComplete="off" spellCheck={false} aria-label="Original share link" />
              <input type="password" className={styles.textInput} value={newPw} onChange={(event) => setNewPw(event.target.value)} placeholder="New password" autoComplete="new-password" aria-label="New password" style={{ marginTop: 8 }} />
              <button type="button" className={styles.secondaryButton} onClick={addPassword} disabled={pw.busy || !pastedLink || !newPw} style={{ marginTop: 8 }}>
                {pw.busy ? 'Working…' : 'Add password'}
              </button>
            </>
          )}

          {resultLink && (
            <div className={styles.field} style={{ marginTop: 12 }}>
              <span className={styles.label}>Link to send</span>
              <div className={styles.linkRow}>
                <input type="text" className={styles.linkInput} value={resultLink} readOnly onFocus={(event) => event.target.select()} />
                <button type="button" className={styles.copyButton} onClick={copyLink}>
                  {copied ? <Check size={16} weight="bold" /> : <Copy size={16} weight="bold" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <p className={styles.hint}>
                {resultLink.includes('#k=')
                  ? 'This link has the key in it, and this is the only time you will see it.'
                  : 'This link has no key in it: viewers need the password. Tell them the password by a different route.'}
              </p>
            </div>
          )}
        </Section>
      </div>
    </Modal>
  );
}

export default ShareEditModal;
