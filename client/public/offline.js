// CSP allows scripts from this origin only (no inline), so the retry buttons live in this file.
// Retry: ask the server (no cache) whether we are back online. If yes, reload the page; if not, show the
// "still offline" line in Arabic and English inside the role="status" container (read out by screen readers).
const lines = ['still-ar', 'still-en'].map(id => document.getElementById(id));
async function retry() {
  lines.forEach(l => { l.hidden = true; });
  try {
    const r = await fetch('/api/health', {cache: 'no-store'});
    if (r.ok) { location.reload(); return; }
  } catch { /* offline */ }
  lines.forEach(l => { l.hidden = false; });
}
for (const id of ['retry-ar', 'retry-en']) document.getElementById(id).addEventListener('click', retry);
