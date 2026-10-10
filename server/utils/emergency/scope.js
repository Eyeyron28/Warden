/**
 * Folder scope for an emergency session. Enforced by the SERVER as a policy on every read (not by cryptography:
 * the session holds the whole DEK). An emergency session has `req.emergency = { scopeMode, scopePaths }`; a normal
 * session has req.emergency === null and none of this applies.
 *
 * Out-of-scope files and folders are a 404, never a 403, and never appear in lists, counts or search.
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

/** Whether a folder path is inside the scope (the scoped folder itself or anything below it). */
function pathInScope(emergency, path) {
  if (!emergency || emergency.scopeMode !== 'folders') return true;
  const value = String(path || '');
  return (emergency.scopePaths || []).some((scoped) => value === scoped || value.startsWith(`${scoped}/`));
}

module.exports = { documentScope, pathInScope };
