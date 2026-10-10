/**
 * Folder scope for an emergency session. Enforced by the SERVER as a policy on every read (not by cryptography:
 * the session holds the whole DEK). An emergency session has `req.emergency = { scopeMode, scopePaths }`; a normal
 * session has req.emergency === null and none of this applies.
 *
 * Out-of-scope files and folders are a 404, never a 403, and never appear in lists, counts or search.
 *
 * PRIVACY: the contact never learns the names of folders ABOVE a scoped folder. Every path the server sends an
 * emergency session starts at the scope folder itself ("virtual paths"): with the scope "Taxes/2024", a file in
 * "Taxes/2024/Receipts" is reported as "2024/Receipts", and a request for "2024" means the real "Taxes/2024".
 * Two scoped folders with the same last name get "(2)", "(3)", ... so the top level stays unambiguous.
 */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A Mongo filter fragment for documents: {} for the whole vault, otherwise only the scoped folders and below. */
function documentScope(emergency) {
  if (!emergency || emergency.scopeMode !== 'folders') return {};
  const paths = emergency.scopePaths || [];
  if (paths.length === 0) return { _id: null }; // nothing is in scope
  return {
    $or: paths.flatMap((path) => [{ folder: path }, { folder: { $regex: `^${escapeRegex(path)}/` } }]),
  };
}

/** Whether a REAL folder path is inside the scope (the scoped folder itself or anything below it). */
function pathInScope(emergency, path) {
  if (!emergency || emergency.scopeMode !== 'folders') return true;
  const value = String(path || '');
  return (emergency.scopePaths || []).some((scoped) => value === scoped || value.startsWith(`${scoped}/`));
}

/** [{ path: 'Taxes/2024', alias: '2024' }, ...] in a fixed order, with duplicate last names told apart. */
function aliasesFor(scopePaths) {
  const used = new Set();
  return [...(scopePaths || [])].sort().map((path) => {
    const base = path.split('/').pop();
    let alias = base;
    for (let n = 2; used.has(alias.toLowerCase()); n += 1) alias = `${base} (${n})`;
    used.add(alias.toLowerCase());
    return { path, alias };
  });
}

/** A real path -> the path the contact sees (starting at its scope folder). null if it is not in scope. */
function toVirtual(emergency, realPath) {
  if (!emergency || emergency.scopeMode !== 'folders') return realPath;
  const value = String(realPath || '');
  const entry = aliasesFor(emergency.scopePaths)
    .filter(({ path }) => value === path || value.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return entry ? `${entry.alias}${value.slice(entry.path.length)}` : null;
}

/** A path as the contact wrote it -> the real path ('' stays ''), or null if it names nothing in the scope. */
function toReal(emergency, virtualPath) {
  if (!emergency || emergency.scopeMode !== 'folders') return virtualPath;
  const value = String(virtualPath || '');
  if (value === '') return '';
  const [first, ...rest] = value.split('/');
  const entry = aliasesFor(emergency.scopePaths).find(({ alias }) => alias.toLowerCase() === first.toLowerCase());
  return entry ? [entry.path, ...rest].join('/') : null;
}

/** What the contact is told about their scope: the mode and the top-level folder names (never their parents). */
function scopeSummary(emergency) {
  if (!emergency || emergency.scopeMode !== 'folders') return { mode: 'all', folders: [] };
  return { mode: 'folders', folders: aliasesFor(emergency.scopePaths).map(({ alias }) => alias) };
}

module.exports = { documentScope, pathInScope, aliasesFor, toVirtual, toReal, scopeSummary };
