/**
 * Vault health: a score out of 100 from settings and facts Warden can actually see. Nothing here guesses about
 * things Warden cannot know (where a recovery key is kept, how strong a password is outside Warden, ...), and
 * it is not a security guarantee. Pure: give it facts, get the score.
 *
 * Each item has a MAXIMUM penalty; the nine maximums add up to exactly 100, so a vault with every item at its
 * worst scores 0 and one with none scores 100. A "warn" costs half of an item's maximum (rounded down), a "bad"
 * costs all of it. `points` on an item is what it cost (0 when ok).
 *
 * facts = {
 *   openShares:          active links with neither a link password nor an email restriction
 *   oldShares:           active links created more than 14 days ago
 *   trustedBrowsers:     trusted browsers still valid
 *   staleTrusted:        of those, unused for 20+ days
 *   suspiciousFlags:     unusual-activity flags in the last 30 days
 *   expiredDocs:         live documents whose "Expires on" day has passed
 *   expiringDocs:        live documents expiring within 30 days
 *   remindersOn:         the expiry-email setting
 *   trashNearPurge:      Trash files within 7 days of being deleted for good
 *   hasExpiryDates:      whether any live document has an expiry date (the reminders item only matters then)
 * }
 */

const WEIGHTS = Object.freeze({
  open_shares: 15,
  old_shares: 10,
  trusted_browsers: 10,
  stale_trusted: 10,
  suspicious: 25,
  expired_docs: 15,
  expiring_docs: 5,
  reminders_off: 5,
  trash_near_purge: 5,
});

const TRUSTED_WARN_ABOVE = 3;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function item(id, label, status, detail, actionPath) {
  const max = WEIGHTS[id];
  const points = status === 'bad' ? max : status === 'warn' ? Math.floor(max / 2) : 0;
  return { id, label, status, points, detail, actionPath };
}

/** @returns {{ score: number, items: Array<{ id: string, label: string, status: 'ok'|'warn'|'bad', points: number, detail: string, actionPath: string }> }} */
function computeVaultHealth(facts = {}) {
  const openShares = num(facts.openShares);
  const oldShares = num(facts.oldShares);
  const trusted = num(facts.trustedBrowsers);
  const staleTrusted = num(facts.staleTrusted);
  const flags = num(facts.suspiciousFlags);
  const expired = num(facts.expiredDocs);
  const expiring = num(facts.expiringDocs);
  const trashNear = num(facts.trashNearPurge);
  const remindersOn = facts.remindersOn !== false;

  const items = [
    openShares > 0
      ? item('open_shares', 'Share links anyone can open', 'bad', `${plural(openShares, 'active link')} with no link password and no email restriction. Anyone who gets the link can open it.`, '/shared')
      : item('open_shares', 'Share links anyone can open', 'ok', 'Every active share link has a password or is limited to one email address (or you have none).', '/shared'),

    oldShares > 0
      ? item('old_shares', 'Old share links', 'warn', `${plural(oldShares, 'link')} created more than 14 days ago ${oldShares === 1 ? 'is' : 'are'} still active. Stop links you no longer need.`, '/shared')
      : item('old_shares', 'Old share links', 'ok', 'No share link has been active for more than 14 days.', '/shared'),

    trusted > TRUSTED_WARN_ABOVE
      ? item('trusted_browsers', 'Trusted browsers', 'warn', `${trusted} browsers skip the emailed code. More than ${TRUSTED_WARN_ABOVE} is more than most people need.`, '/devices')
      : item('trusted_browsers', 'Trusted browsers', 'ok', trusted === 0 ? 'No browser skips the emailed code.' : `${plural(trusted, 'browser')} skip${trusted === 1 ? 's' : ''} the emailed code.`, '/devices'),

    staleTrusted > 0
      ? item('stale_trusted', 'Trusted browsers you have not used', 'warn', `${plural(staleTrusted, 'trusted browser')} not used for 20 days or more. Forget the ones you do not recognise.`, '/devices')
      : item('stale_trusted', 'Trusted browsers you have not used', 'ok', 'Every trusted browser was used in the last 20 days (or you have none).', '/devices'),

    flags > 0
      ? item('suspicious', 'Unusual activity', 'bad', `${plural(flags, 'unusual event')} flagged in the last 30 days. Check that ${flags === 1 ? 'it was' : 'they were'} you.`, '/devices')
      : item('suspicious', 'Unusual activity', 'ok', 'Nothing unusual flagged in the last 30 days.', '/devices'),

    expired > 0
      ? item('expired_docs', 'Expired documents', 'bad', `${plural(expired, 'document')} past ${expired === 1 ? 'its' : 'their'} expiry date. Renew or remove ${expired === 1 ? 'it' : 'them'}.`, '/overview#expiring')
      : item('expired_docs', 'Expired documents', 'ok', 'No document has passed its expiry date.', '/overview#expiring'),

    expiring > 0
      ? item('expiring_docs', 'Documents expiring soon', 'warn', `${plural(expiring, 'document')} ${expiring === 1 ? 'expires' : 'expire'} within 30 days.`, '/overview#expiring')
      : item('expiring_docs', 'Documents expiring soon', 'ok', 'Nothing expires in the next 30 days.', '/overview#expiring'),

    !remindersOn && facts.hasExpiryDates
      ? item('reminders_off', 'Expiry reminders', 'warn', 'You have documents with expiry dates but "Email me about expiring documents" is off.', '/account#reminders')
      : item('reminders_off', 'Expiry reminders', 'ok', remindersOn ? 'Expiry reminder emails are on.' : 'Reminders are off, and no document has an expiry date.', '/account#reminders'),

    trashNear > 0
      ? item('trash_near_purge', 'Trash about to be emptied', 'warn', `${plural(trashNear, 'file')} in Trash will be deleted for good within 7 days. Restore anything you still need.`, '/trash')
      : item('trash_near_purge', 'Trash about to be emptied', 'ok', 'Nothing in Trash is close to being deleted for good.', '/trash'),
  ];

  const lost = items.reduce((sum, row) => sum + row.points, 0);
  return { score: Math.max(0, Math.min(100, 100 - lost)), items };
}

module.exports = { computeVaultHealth, WEIGHTS, TRUSTED_WARN_ABOVE };
