import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

// Space Grotesk is self-hosted via @font-face in styles/global.css (so
// index.html can preload it) - only the body and mono fonts come from
// @fontsource here.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './styles/global.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

// Production only: Vite's dev server serves unbundled ES modules over
// its own HMR/websocket machinery, which a cache-first service worker
// would fight with (serving a stale cached module instead of the one
// Vite just recompiled). The service worker is purely an installed-app/
// production concern, so it never registers under `npm run dev`.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
