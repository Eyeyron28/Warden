export const MAX_DOCX_BYTES = 4 * 1024 * 1024;
const MAX_HTML_CHARS = 8 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 20000;

export const DOCX_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

const REMOVE_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'form',
  'input', 'button', 'select', 'textarea', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas',
  'template', 'noscript', 'portal', 'dialog',
]);
const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'poster', 'background', 'action', 'formaction', 'ping', 'data', 'xlink:href', 'cite', 'longdesc', 'usemap'];
const SAFE_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const CSS_URL = /url\(\s*(?!['"]?data:(?:image\/(?:png|jpeg|jpg|gif|webp|bmp)|font\/|application\/(?:x-font|font))[^)]*\))[^)]*\)/gi;

export function sanitizeCss(css) {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@charset[^;]*;?/gi, '')
    .replace(CSS_URL, 'none')
    .replace(/expression\s*\(/gi, '(')
    .replace(/javascript\s*:/gi, '')
    .replace(/behavior\s*:[^;}]*/gi, '');
}

export function sanitizeRendered(root) {
  const all = [...root.querySelectorAll('*')];
  for (const element of all) {
    if (!root.contains(element)) continue;
    const tag = element.tagName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (tag === 'style') {
      element.textContent = sanitizeCss(element.textContent || '');
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if (URL_ATTRIBUTES.includes(name)) {
        if (!(tag === 'img' && name === 'src' && SAFE_IMAGE.test(attribute.value.trim()))) {
          element.removeAttribute(attribute.name);
        }
      } else if (name === 'style') {
        element.setAttribute(attribute.name, sanitizeCss(attribute.value));
      } else if (name === 'target' || name === 'rel' || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
      }
    }
    if (tag === 'img' && !element.getAttribute('src')) element.remove();
  }
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('render timed out')), ms))]);

export async function renderDocxToSrcdoc(bytes) {
  if (bytes.length > MAX_DOCX_BYTES) throw new Error('too large');
  const { renderAsync } = await import('docx-preview');

  const detached = new DOMParser().parseFromString(
    '<!doctype html><html><head></head><body></body></html>',
    'text/html'
  );
  await withTimeout(
    renderAsync(bytes, detached.body, detached.head, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      ignoreLastRenderedPageBreak: true,
      useBase64URL: true,
      experimental: false,
      trimXmlDeclaration: true,
      debug: false,
    }),
    RENDER_TIMEOUT_MS
  );

  sanitizeRendered(detached.documentElement);

  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${DOCX_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<style>html,body{margin:0;background:#e9e6e8}body{padding:12px}</style>' +
    detached.head.innerHTML +
    '</head><body>' +
    detached.body.innerHTML +
    '</body></html>';
  if (html.length > MAX_HTML_CHARS) throw new Error('rendered output too large');
  return html;
}
