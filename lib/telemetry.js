// ── Telemetry ────────────────────────────────────────────────────────────────
// Structured JSON-lines event log, one file per UTC day, under telemetry/
// (gitignored -- this is runtime data, not source, same treatment as
// devices.json/.chat-state.json). Every line is a single flat JSON object:
// {ts, type, ...fields}. Deliberately schemaless beyond that so a new field
// anywhere never needs a migration -- query tooling (scripts/telemetry-
// query.js) just reads whatever keys happen to be there.
//
// Requiring this module installs a global axios interceptor as a side
// effect (every lib/*.js file requires the same cached axios singleton, so
// one interceptor here covers every outbound call app-wide without having
// to instrument each call site individually). Callers still need to wire
// httpMiddleware() into Express themselves, and log server-start/error
// events explicitly -- those aren't automatic.
//
// Never logs: auth headers, request/response bodies, or full URLs with
// query strings (Spotify tokens/refresh tokens can appear there) -- only
// host+pathname+method+status+timing.
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DIR = path.join(__dirname, '..', 'telemetry');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const RETENTION_DAYS = 14;

function _fileFor(d) {
  return path.join(DIR, `events-${d.toISOString().slice(0, 10)}.jsonl`);
}

// Fire-and-forget append -- a lost telemetry line is never worth blocking a
// request or crashing the process over.
function logEvent(type, fields) {
  const line = JSON.stringify({ ts: Date.now(), type, ...fields }) + '\n';
  fs.appendFile(_fileFor(new Date()), line, () => {});
}

function _cleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  fs.readdir(DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const m = f.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) fs.unlink(path.join(DIR, f), () => {});
    }
  });
}
_cleanup();
setInterval(_cleanup, 86400000);

// Times every /api/ request (skips static assets -- js/css/image fetches
// aren't meaningful "latency" in the sense this was asked for, and would
// swamp the log with hundreds of near-instant entries per page load).
function httpMiddleware(resolveDevice) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const start = Date.now();
    res.on('finish', () => {
      logEvent('http', {
        method: req.method, path: req.path, status: res.statusCode,
        ms: Date.now() - start, deviceId: resolveDevice(req) || undefined,
      });
    });
    next();
  };
}

function _outboundHost(cfg) {
  try { return new URL(cfg.url, cfg.baseURL).hostname; }
  catch { try { return new URL(cfg.url).hostname; } catch { return 'unknown'; } }
}
function _outboundPath(cfg) {
  try { return new URL(cfg.url, cfg.baseURL).pathname; }
  catch { return String(cfg.url || '').split('?')[0]; }
}

axios.interceptors.request.use(cfg => { cfg._telemetryStart = Date.now(); return cfg; });
axios.interceptors.response.use(
  res => {
    logEvent('outbound', {
      host: _outboundHost(res.config), path: _outboundPath(res.config),
      method: (res.config.method || 'get').toUpperCase(), status: res.status,
      ms: Date.now() - (res.config._telemetryStart || Date.now()),
    });
    return res;
  },
  err => {
    if (err.config) {
      logEvent('outbound', {
        host: _outboundHost(err.config), path: _outboundPath(err.config),
        method: (err.config.method || 'get').toUpperCase(), status: err.response?.status || 0,
        ms: Date.now() - (err.config._telemetryStart || Date.now()), error: err.message,
      });
    }
    return Promise.reject(err);
  }
);

module.exports = { logEvent, httpMiddleware };
