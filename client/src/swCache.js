// Called on every sign-out: asks the service worker to delete all caches, and clears them from the page too
// (covers the first load after install, when the worker does not control the page yet).
export function clearSwCaches() {
  try { navigator.serviceWorker?.controller?.postMessage({type: 'clear-caches'}); } catch {}
  try { globalThis.caches?.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {}); } catch {}
}
