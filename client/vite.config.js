import crypto from 'crypto';
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

// Stamps the service worker with this build's id (a hash of the built page,
// which names every hashed asset), so each deployment changes the worker file.
function stampServiceWorker() {
  let outDir = 'dist';
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swPath = path.join(outDir, 'service-worker.js');
      const indexPath = path.join(outDir, 'index.html');
      if (!fs.existsSync(swPath) || !fs.existsSync(indexPath)) return;
      const id = crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex').slice(0, 12);
      fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace('__BUILD_ID__', id));
    },
  };
}

// The local mkcert certificate, or undefined when it is not there. The certs/
// folder is git-ignored, so it does not exist on Vercel (or any fresh clone):
// it is only read for `vite` (serve), and only if both files exist. Paths are
// relative to this file, not the working directory.
function localHttps(command) {
  if (command !== 'serve') return undefined;
  const keyPath = path.resolve(__dirname, '..', 'certs', 'localhost+3-key.pem');
  const certPath = path.resolve(__dirname, '..', 'certs', 'localhost+3.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return undefined;
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), shareViewerHeaders(), stampServiceWorker()],
  server: {
    port: 5173,
    // Required, not optional: crypto.subtle's "secure context" check
    // applies to the page's own origin, so /phone's crypto needs the
    // frontend itself served over HTTPS, not just the API. Same
    // mkcert cert as the backend (see server/server.js) - tied to
    // localhost, 127.0.0.1, 192.168.100.115, 10.58.146.172.
    https: localHttps(command),
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
}));
