// Observability: structured JSON logs, request ids, Prometheus metrics. No dependencies.
//
// Logs: one JSON line per event on stdout (journald/CloudWatch friendly). Request lines carry method, route template,
//   status, duration and request id. They NEVER include query strings, cookies, headers or bodies (tokens and
//   personal data stay out of logs). LOG_LEVEL=debug|info|warn|error (default info).
// Request ids: an incoming X-Request-Id (8-64 safe chars, e.g. from the load balancer) is kept, otherwise generated;
//   echoed in the response header so a user-reported error can be matched to log lines.
// Metrics: GET /api/metrics in Prometheus text format. Requires METRICS_TOKEN (Bearer); disabled (404) when unset.
//   Labels use the Express route template (e.g. /api/admin/users/:id), never raw paths, to keep cardinality bounded.
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {timingSafeEqual, createHash} from 'node:crypto';

const LEVELS = {debug: 10, info: 20, warn: 30, error: 40};
const minLevel = () => LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
export function log(level, msg, fields = {}) {
  if ((LEVELS[level] ?? 20) < minLevel()) return;
  const line = JSON.stringify({ts: new Date().toISOString(), level, msg, ...fields});
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const counters = new Map();   // key -> number
const histos = new Map();     // key -> {buckets: number[], sum, count}
const labelKey = labels => Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
export function inc(name, labels = {}, by = 1) { const k = name + '{' + labelKey(labels) + '}'; counters.set(k, (counters.get(k) || 0) + by); }
function observe(name, labels, seconds) {
  const k = name + '{' + labelKey(labels) + '}';
  let h = histos.get(k);
  if (!h) { h = {name, labels, buckets: BUCKETS.map(() => 0), sum: 0, count: 0}; histos.set(k, h); }
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds; h.count++;
}

const loopDelay = monitorEventLoopDelay({resolution: 20});
loopDelay.enable();

const REQ_ID = /^[A-Za-z0-9._-]{8,64}$/;
export function requestMiddleware() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && REQ_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Route template only (bounded cardinality); unmatched requests are grouped.
      // originalUrl keeps the mount prefix (req.path loses '/api' inside app.use('/api', ...)).
      const fullPath = String(req.originalUrl || req.url).split('?')[0];
      const route = req.route?.path ? (req.baseUrl || '') + req.route.path : (fullPath.startsWith('/api') ? 'unmatched_api' : 'static');
      const labels = {method: req.method, route, status: String(res.statusCode)};
      inc('http_requests_total', labels);
      observe('http_request_duration_seconds', {method: req.method, route}, seconds);
      if (route === '/api/health' || route === '/api/ready' || route === '/api/metrics') return;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'info' : 'debug';
      log(level, 'request', {requestId: req.id, method: req.method, route, status: res.statusCode, ms: +(seconds * 1000).toFixed(1)});
    });
    next();
  };
}

// Last-resort error handler: logs the stack server-side, returns a generic JSON error (no internals to the client).
export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({error: 'Invalid JSON body.'});
    if (err?.type === 'entity.too.large') return res.status(413).json({error: 'Request body too large.'});
    log('error', 'unhandled request error', {requestId: req.id, method: req.method, route: req.route?.path || req.path.split('?')[0], error: err?.message, stack: err?.stack?.split('\n').slice(0, 6).join(' | ')});
    inc('http_unhandled_errors_total');
    if (res.headersSent) return;
    res.status(500).json({error: 'Unexpected server error.', requestId: req.id});
  };
}

export function installProcessHandlers() {
  process.on('unhandledRejection', e => { inc('process_unhandled_rejections_total'); log('error', 'unhandled promise rejection', {error: e?.message || String(e), stack: e?.stack?.split('\n').slice(0, 6).join(' | ')}); });
}

const sameToken = (a, b) => { const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y); };
// gauges: () => ({name: {value, help}}) collected at scrape time (db pool, rooms, limiter state...)
export function metricsHandler(gauges = () => ({})) {
  return async (req, res) => {
    const token = process.env.METRICS_TOKEN || '';
    if (token.length < 16) return res.status(404).json({error: 'Not found'});
    const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!supplied || !sameToken(supplied, token)) return res.status(401).json({error: 'Unauthorized'});
    const out = [];
    out.push('# HELP http_requests_total HTTP requests by method, route template and status.', '# TYPE http_requests_total counter');
    for (const [k, v] of counters) if (k.startsWith('http_requests_total{')) out.push(`${k} ${v}`);
    for (const name of ['http_unhandled_errors_total', 'process_unhandled_rejections_total']) {
      out.push(`# TYPE ${name} counter`, `${name} ${counters.get(name + '{}') || 0}`);
    }
    // Every other counter (e.g. ai_requests_total, ai_tokens_total for cost monitoring), grouped by metric name.
    const other = new Map();
    for (const [k, v] of counters) { const name = k.slice(0, k.indexOf('{')); if (name === 'http_requests_total' || name === 'http_unhandled_errors_total' || name === 'process_unhandled_rejections_total') continue; if (!other.has(name)) other.set(name, []); other.get(name).push(`${k.endsWith('{}') ? name : k} ${v}`); }
    for (const [name, lines] of other) out.push(`# TYPE ${name} counter`, ...lines);
    out.push('# HELP http_request_duration_seconds Request latency.', '# TYPE http_request_duration_seconds histogram');
    for (const h of histos.values()) {
      const l = labelKey(h.labels);
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      out.push(`http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    const mem = process.memoryUsage();
    const g = {
      process_resident_memory_bytes: {value: mem.rss, help: 'Resident memory.'},
      process_heap_used_bytes: {value: mem.heapUsed, help: 'V8 heap in use.'},
      process_uptime_seconds: {value: Math.round(process.uptime()), help: 'Process uptime.'},
      nodejs_eventloop_lag_p99_seconds: {value: +(loopDelay.percentile(99) / 1e9).toFixed(6), help: 'Event-loop delay p99 since last scrape.'},
      ...(await gauges()),
    };
    loopDelay.reset();
    for (const [name, {value, help}] of Object.entries(g)) if (Number.isFinite(Number(value))) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number(value)}`);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.join('\n') + '\n');
  };
}
