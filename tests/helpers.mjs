// Shared test helpers.
import {createServer} from 'node:net';

// Tests must never reach real, billed providers by accident. A developer machine may carry real keys in its
// environment (e.g. OPENAI_API_KEY in the user profile); servers spawned by tests inherit process.env, so remove
// provider secrets on import. Live-provider checks belong in a separate, explicitly approved integration test.
export const PROVIDER_SECRETS = ['OPENAI_API_KEY', 'PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_IDS', 'PAYMOB_HMAC_SECRET', 'RESEND_API_KEY'];
for (const k of PROVIDER_SECRETS) delete process.env[k];

// OS-assigned free TCP port. Avoids collisions with orphaned servers from interrupted runs.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Graceful stop for servers spawned with an 'ipc' stdio channel: lets the server close its database cleanly
// (required before reopening the same embedded PGlite data directory). Falls back to a hard kill after 8 s.
export function stopServer(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.connected ? child.send('shutdown') : child.kill(); } catch { child.kill(); }
  });
}
