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

// One open write stream per UTC day instead of fs.appendFile() per event --
// appendFile opens+writes+closes the file every single call, which adds up
// given logEvent() fires on every /api/ request, every outbound axios call,
// and every incoming WS message. Swapped for a fresh stream the moment the
// date rolls over; a write failure is logged nowhere and never thrown --
// same "never worth blocking or crashing over" stance as before.
let _stream = null;
let _streamDate = null;
function _streamFor(d) {
  const dateStr = d.toISOString().slice(0, 10);
  if (_stream && _streamDate === dateStr) return _stream;
  if (_stream) _stream.end();
  _streamDate = dateStr;
  _stream = fs.createWriteStream(_fileFor(d), { flags: 'a' });
  _stream.on('error', () => {});
  return _stream;
}

// Fire-and-forget -- a lost telemetry line is never worth blocking a
// request or crashing the process over.
function logEvent(type, fields) {
  const line = JSON.stringify({ ts: Date.now(), type, ...fields }) + '\n';
  _streamFor(new Date()).write(line);
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

// Single URL parse per call (was parsing cfg.url twice -- once each for
// host and path -- on every outbound request/response).
function _outboundInfo(cfg) {
  try { const u = new URL(cfg.url, cfg.baseURL); return { host: u.hostname, path: u.pathname }; }
  catch {
    try { const u = new URL(cfg.url); return { host: u.hostname, path: u.pathname }; }
    catch { return { host: 'unknown', path: String(cfg.url || '').split('?')[0] }; }
  }
}

axios.interceptors.request.use(cfg => { cfg._telemetryStart = Date.now(); return cfg; });
axios.interceptors.response.use(
  res => {
    const { host, path: p } = _outboundInfo(res.config);
    logEvent('outbound', {
      host, path: p, method: (res.config.method || 'get').toUpperCase(), status: res.status,
      ms: Date.now() - (res.config._telemetryStart || Date.now()),
    });
    return res;
  },
  err => {
    if (err.config) {
      const { host, path: p } = _outboundInfo(err.config);
      logEvent('outbound', {
        host, path: p, method: (err.config.method || 'get').toUpperCase(), status: err.response?.status || 0,
        ms: Date.now() - (err.config._telemetryStart || Date.now()), error: err.message,
      });
    }
    return Promise.reject(err);
  }
);

module.exports = { logEvent, httpMiddleware };
