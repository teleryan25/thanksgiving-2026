import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App';

/** Service worker: registered in production builds. Updates wait until the cook taps "Update now". */
const listeners = new Set<() => void>();
const swUpdate = {
  ready: false,
  waiting: null as ServiceWorker | null,
  apply() {
    if (!this.waiting) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    this.waiting.postMessage('SKIP_WAITING');
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
};
const markWaiting = (w: ServiceWorker | null) => {
  if (!w || !navigator.serviceWorker.controller) return;
  swUpdate.waiting = w;
  swUpdate.ready = true;
  listeners.forEach((l) => l());
};

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((reg) => {
        markWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw?.addEventListener('statechange', () => nw.state === 'installed' && markWaiting(nw));
        });
      })
      .catch(() => {
        /* offline support unavailable; app still works online */
      });
  });
}

window.addEventListener('error', (e) => console.error('Uncaught error', e.error));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App swUpdate={swUpdate} />
  </StrictMode>,
);
