// Shared test helpers.
import {createServer} from 'node:net';

// OS-assigned free TCP port. Avoids collisions with orphaned servers from interrupted runs.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
