import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './styles/global.css';
import App from './App.jsx';
import './utils/tooltipBootstrap.js';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import TransferHost from './components/TransferHost.jsx';
import { prefetchFirstScreen } from './services/prefetch.js';
import { installSessionReset } from './services/sessionReset.js';
import { watchRequiredControls } from './utils/requiredMark.js';

installSessionReset();
watchRequiredControls();

prefetchFirstScreen(window.location.pathname);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <UpdatePrompt />
      <TransferHost />
    </BrowserRouter>
  </StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
