const { NOT_HELD } = require('../quarantineFilter');

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function documentScope(emergency) {
  if (!emergency) return {};
  if (emergency.scopeMode !== 'folders') return { ...NOT_HELD };
  const paths = emergency.scopePaths || [];
  if (paths.length === 0) return { _id: null };
  return {
    ...NOT_HELD,
    $or: paths.flatMap((path) => [{ folder: path }, { folder: { $regex: `^${escapeRegex(path)}/` } }]),
  };
}

function pathInScope(emergency, path) {
  if (!emergency || emergency.scopeMode !== 'folders') return true;
  const value = String(path || '');
  return (emergency.scopePaths || []).some((scoped) => value === scoped || value.startsWith(`${scoped}/`));
}

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

function toVirtual(emergency, realPath) {
  if (!emergency || emergency.scopeMode !== 'folders') return realPath;
  const value = String(realPath || '');
  const entry = aliasesFor(emergency.scopePaths)
    .filter(({ path }) => value === path || value.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return entry ? `${entry.alias}${value.slice(entry.path.length)}` : null;
}

function toReal(emergency, virtualPath) {
  if (!emergency || emergency.scopeMode !== 'folders') return virtualPath;
  const value = String(virtualPath || '');
  if (value === '') return '';
  const [first, ...rest] = value.split('/');
  const entry = aliasesFor(emergency.scopePaths).find(({ alias }) => alias.toLowerCase() === first.toLowerCase());
  return entry ? [entry.path, ...rest].join('/') : null;
}

function scopeSummary(emergency) {
  if (!emergency || emergency.scopeMode !== 'folders') return { mode: 'all', folders: [] };
  return { mode: 'folders', folders: aliasesFor(emergency.scopePaths).map(({ alias }) => alias) };
}

module.exports = { documentScope, pathInScope, aliasesFor, toVirtual, toReal, scopeSummary };
