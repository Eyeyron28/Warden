const dayOf = (doc) => {
  const iso = doc?.docExpiresAt || doc?.expiryDate;
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
};

export function selectExpired(docs, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const expired = (doc) => (doc.expiryStatus ? doc.expiryStatus === 'expired' : dayOf(doc) !== '' && dayOf(doc) < today);
  return (Array.isArray(docs) ? docs : [])
    .filter((doc) => !doc.deletedAt && expired(doc))
    .sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : String(a.filename).localeCompare(String(b.filename))));
}
