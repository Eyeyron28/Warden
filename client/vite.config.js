import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
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
