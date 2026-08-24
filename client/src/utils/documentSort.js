const URGENCY_RANK = { expired: 0, expiring_soon: 1, ok: 2 };

/**
 * Surfaces expired/expiring-soon documents near the top of the list
 * instead of strict upload order - the point of the expiry indicator is
 * making it visible without the user having to hunt for it. Within the
 * urgent group, soonest-due first; everything else keeps the order the
 * server returned (newest-first).
 */
export function sortByExpiryUrgency(documents) {
  return [...documents].sort((a, b) => {
    const rankA = URGENCY_RANK[a.expiryStatus] ?? URGENCY_RANK.ok;
    const rankB = URGENCY_RANK[b.expiryStatus] ?? URGENCY_RANK.ok;
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === URGENCY_RANK.ok) return 0;
    return a.daysUntilExpiry - b.daysUntilExpiry;
  });
}
