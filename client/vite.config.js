import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The public share viewer (/shared/...) opens untrusted content, so it gets its
// own response headers (vercel.json is the source of truth in production).
// `vite preview` serves the production build with those exact headers, so the
// CSP can be checked against the real bundle; the dev server only gets
// Referrer-Policy, because its HMR needs inline scripts and a websocket that
// the production CSP rightly forbids.
function shareViewerHeaders() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const rule = (config.headers || []).find((entry) => entry.source === '/shared/(.*)');
  const headers = rule ? rule.headers : [];
  const apply = (only) => (req, res, next) => {
    if (req.url && req.url.startsWith('/shared/')) {
      for (const { key, value } of headers) {
        if (!only || only.includes(key)) res.setHeader(key, value);
      }
    }
    next();
  };
  return {
    name: 'share-viewer-headers',
    configureServer(server) {
      server.middlewares.use(apply(['Referrer-Policy']));
    },
    configurePreviewServer(server) {
      server.middlewares.use(apply(null));
    },
  };
}

export default defineConfig({
  plugins: [react(), shareViewerHeaders()],
  server: {
    port: 5173,
    // Required, not optional: crypto.subtle's "secure context" check
    // applies to the page's own origin, so /phone's crypto needs the
    // frontend itself served over HTTPS, not just the API. Same
    // mkcert cert as the backend (see server/server.js) - tied to
    // localhost, 127.0.0.1, 192.168.100.115, 10.58.146.172.
    https: {
      key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3.pem')),
    },
    // Lets the frontend call a relative "/api" path (see services/api.js)
    // instead of an absolute URL baked in at build time - Vite forwards
    // it to the backend server-side, so it works identically whether the
    // page itself was reached via localhost, a home Wi-Fi IP, or a phone
    // hotspot IP, with nothing to edit when the network changes.
    // `secure: false` because the backend's cert is the same self-signed
    // mkcert one above, which Node's proxying http client wouldn't trust
    // by default.
    proxy: {
      '/api': {
        target: 'https://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
