import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SHARE_TITLE = 'Warden — a document was shared with you';
export const SHARE_DESCRIPTION = 'Someone shared a document with you on Warden, an encrypted document vault. Open the link to view it.';

const replaceOnce = (html, pattern, replacement, label) => {
  if (!pattern.test(html)) throw new Error(`make-share-preview: ${label} not found in index.html`);
  return html.replace(pattern, replacement);
};

export function makeSharePreview(html) {
  let out = html;
  out = replaceOnce(out, /<title>[\s\S]*?<\/title>/, `<title>${SHARE_TITLE}</title>`, '<title>');
  out = replaceOnce(out, /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/, `<meta name="description" content="${SHARE_DESCRIPTION}" />`, 'description');
  out = replaceOnce(out, /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${SHARE_TITLE}" />`, 'og:title');
  out = replaceOnce(
    out,
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${SHARE_DESCRIPTION}" />`,
    'og:description'
  );
  out = replaceOnce(out, /<\/head>/, '    <meta name="robots" content="noindex, nofollow" />\n  </head>', '</head>');
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const dist = path.join(here, '..', 'dist');
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  writeFileSync(path.join(dist, 'shared-preview.html'), makeSharePreview(html));
  console.log('wrote dist/shared-preview.html');
}
