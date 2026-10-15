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
import UpdatePrompt from './components/UpdatePrompt.jsx';
import ImportHost from './components/ImportHost.jsx';
import { prefetchFirstScreen } from './services/prefetch.js';
import { installSessionReset } from './services/sessionReset.js';

// However a session ends (sign-out, Lock vault, expiry, a 401, another account), the previous visit is forgotten (services/sessionReset.js).
installSessionReset();

// A stored session on a signed-in page: the first screen's requests start now, beside the session check.
prefetchFirstScreen(window.location.pathname);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <UpdatePrompt />
      {/* The import job's card and sign-out question: above the routes, so no page change can remove them. */}
      <ImportHost />
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
