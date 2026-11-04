// Minimal closed-loop HTTP load generator (no dependencies).
// `connections` workers each keep one keep-alive connection busy for `durationMs`, issuing requests built by
// `makeRequest(workerIndex, n)`. Reports throughput, latency percentiles and errors. Latencies are measured from
// request write to full response read, per request, in milliseconds.
import http from 'node:http';

export async function runLoad({origin, connections = 50, durationMs = 10000, warmupMs = 1000, makeRequest}) {
  const url = new URL(origin);
  const agent = new http.Agent({keepAlive: true, maxSockets: connections});
  const lat = [], codes = {};
  let errors = 0, done = 0, measuring = false;
  const end = Date.now() + warmupMs + durationMs;
  setTimeout(() => { measuring = true; }, warmupMs);
  const t0 = Date.now() + warmupMs;

  const one = r => new Promise(resolve => {
    const start = process.hrtime.bigint();
    const req = http.request({host: url.hostname, port: url.port, agent, method: r.method || 'GET', path: r.path, headers: {...(r.body ? {'Content-Type': 'application/json'} : {}), ...(r.headers || {})}}, res => {
      res.resume();
      res.on('end', () => {
        if (measuring) { lat.push(Number(process.hrtime.bigint() - start) / 1e6); codes[res.statusCode] = (codes[res.statusCode] || 0) + 1; done++; }
        resolve();
      });
    });
    req.on('error', () => { if (measuring) errors++; resolve(); });
    if (r.body) req.write(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    req.end();
  });

  await Promise.all(Array.from({length: connections}, async (_, w) => {
    let n = 0;
    while (Date.now() < end) await one(makeRequest(w, n++));
  }));
  agent.destroy();
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const p = q => lat.length ? +lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1) : null;
  const non2xx = Object.entries(codes).filter(([c]) => c < 200 || c >= 300).reduce((s, [, v]) => s + v, 0);
  return {connections, seconds: +secs.toFixed(1), requests: done, rps: +(done / secs).toFixed(0), p50: p(0.5), p90: p(0.9), p99: p(0.99), max: lat.length ? +lat[lat.length - 1].toFixed(1) : null, errors, non2xx, codes};
}
