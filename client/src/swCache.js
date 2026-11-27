// Called on every sign-out and on lost admin sessions: asks the service worker to delete the cached files, keeping only
// the install-time offline files (the worker owns that rule, see clearCaches in client/public/sw.js).
// Uses `ready` so it also works on the first load, when the worker does not control the page yet.
export function clearSwCaches() {
  try { navigator.serviceWorker?.ready.then(reg => reg.active?.postMessage({type: 'clear-caches'})).catch(() => {}); } catch {}
}
