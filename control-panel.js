// TemuTalk Speaker — web control panel.
// HTTPS + token-auth front end that shells out to install.sh for actual
// start/stop work. Bound to 0.0.0.0 so it's reachable at the device's LAN IP.
// Started/stopped by install.sh, not run directly.
//
// Security model (realistic, not "unbreachable" — nothing networked is):
//  - TLS encrypts everything on the wire (reuses the app's cert if present,
//    else mints its own via the already-vendored `selfsigned` package).
//  - A random per-install token (.run/panel-token, mode 0600) gates access.
//    Sessions are HMAC-signed cookies; the signing secret is regenerated
//    every process start, so a server restart invalidates old sessions.
//  - Login attempts are rate-limited per IP (5 tries / 5 min, then a 10 min
//    lockout) and compared with a timing-safe equality check.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PANEL_PORT || '9090', 10);
const INSTALL_SH = process.env.INSTALL_SH || path.join(__dirname, 'install.sh');
const RUN_DIR = path.join(__dirname, '.run');
const COMPONENTS = new Set(['icecast', 'ffmpeg', 'node', 'all']);

// ─── Key-file gate ───────────────────────────────────────────────────────────
// The browser reads temutalk.key from wherever it lives (USB on any device)
// via a file picker and sends the content to /api/login. The server stores
// only the SHA-256 hash — the raw key never persists server-side.
const KEY_HASH_FILE = path.join(RUN_DIR, 'panel-key-hash');

function verifyKeyContent(content) {
  if (!content || content.trim().length < 100) return false;
  const keyHash = crypto.createHash('sha256').update(content.trim()).digest('hex');
  let storedHash;
  try { storedHash = fs.readFileSync(KEY_HASH_FILE, 'utf8').trim(); } catch { return false; }
  return timingSafeEqualStr(keyHash, storedHash);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 10 * 60 * 1000;

fs.mkdirSync(RUN_DIR, { recursive: true });

// Session signing secret — fresh every start, so a restart logs everyone out.
const SESSION_SECRET = crypto.randomBytes(32);

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing consistent
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(payload) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${hmac}`;
}

function verifySession(cookieVal) {
  if (!cookieVal) return false;
  const idx = cookieVal.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = cookieVal.slice(0, idx);
  const sig = cookieVal.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return false;
  const expiry = parseInt(payload.split(':')[1], 10);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  return verifySession(parseCookies(req).panel_session);
}

// ─── Login rate limiting ────────────────────────────────────────────────────
const attempts = new Map(); // ip -> { count, windowStart, lockedUntil }

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  if (now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    rec = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

// ─── TLS — reuse the app's cert if present, else mint our own ──────────────
function loadOrCreateCert() {
  const sharedKey = path.join(__dirname, '.cert-key.pem');
  const sharedCert = path.join(__dirname, '.cert-cert.pem');
  if (fs.existsSync(sharedKey) && fs.existsSync(sharedCert)) {
    return { key: fs.readFileSync(sharedKey), cert: fs.readFileSync(sharedCert) };
  }
  const panelKey = path.join(__dirname, '.panel-cert-key.pem');
  const panelCert = path.join(__dirname, '.panel-cert-cert.pem');
  if (fs.existsSync(panelKey) && fs.existsSync(panelCert)) {
    return { key: fs.readFileSync(panelKey), cert: fs.readFileSync(panelCert) };
  }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'temutalk-panel' }], {
    days: 3650, algorithm: 'sha256', keySize: 2048,
  });
  fs.writeFileSync(panelKey, pems.private, { mode: 0o600 });
  fs.writeFileSync(panelCert, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function runInstall(action, component) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('bash', [INSTALL_SH, action, component], { timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: (stdout + stderr).trim() });
    });
  });
}

function getStatus() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('bash', [INSTALL_SH, 'status'], { timeout: 10000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

function sendJson(res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  }, extraHeaders || {}));
  res.end(data);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'self' 'unsafe-inline'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Control Panel — Login</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e8ec;
    display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { background: #181b22; border: 1px solid #262b36; border-radius: 14px; padding: 30px; width: 340px; }
  h1 { font-size: 1.1rem; margin: 0 0 6px; }
  .sub { color: #8b93a3; font-size: 0.82rem; margin-bottom: 22px; }
  .drop {
    border: 2px dashed #2c3242; border-radius: 10px; padding: 28px 16px;
    text-align: center; cursor: pointer; transition: border-color .15s, background .15s;
    margin-bottom: 14px;
  }
  .drop:hover, .drop.over { border-color: #3ddc84; background: #0f1e16; }
  .drop.ready { border-color: #3ddc84; border-style: solid; background: #0f1e16; }
  .drop-icon { font-size: 2rem; margin-bottom: 8px; }
  .drop-label { font-size: 0.88rem; color: #8b93a3; }
  .drop-name { font-size: 0.85rem; color: #3ddc84; margin-top: 6px; font-family: ui-monospace, monospace; }
  input[type=file] { display: none; }
  button { width: 100%; padding: 11px; border: none; border-radius: 9px; background: #2e7d4f;
    color: #eafff3; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  .err { color: #ff8080; font-size: 0.82rem; min-height: 1.2em; margin-bottom: 10px; text-align: center; }
  .hint { color: #3a3f4a; font-size: 0.75rem; margin-top: 14px; text-align: center; }
</style></head>
<body>
<div class="box">
  <h1>TemuTalk Control Panel</h1>
  <div class="sub">Select your key file to unlock</div>
  <div class="drop" id="drop" onclick="document.getElementById('fi').click()">
    <div class="drop-icon">&#128190;</div>
    <div class="drop-label">Click to select <strong>temutalk.key</strong></div>
    <div class="drop-label" style="margin-top:4px;font-size:0.76rem">or drag and drop</div>
    <div class="drop-name" id="fname"></div>
  </div>
  <input type="file" id="fi" accept=".key,*">
  <div class="err" id="err"></div>
  <button id="btn" disabled onclick="doLogin()">Unlock</button>
  <div class="hint">Key file lives on the TemuTalk USB drive as temutalk.key</div>
</div>
<script>
let keyContent = '';
const drop = document.getElementById('drop');
const btn  = document.getElementById('btn');
const err  = document.getElementById('err');

function readFile(file) {
  const r = new FileReader();
  r.onload = e => {
    keyContent = e.target.result;
    document.getElementById('fname').textContent = file.name;
    drop.classList.add('ready');
    btn.disabled = false;
    err.textContent = '';
  };
  r.readAsText(file);
}

document.getElementById('fi').addEventListener('change', e => {
  if (e.target.files[0]) readFile(e.target.files[0]);
});
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

async function doLogin() {
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyContent }),
    });
    if (r.ok) { location.reload(); return; }
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || 'Login failed (' + r.status + ')';
  } catch (e2) {
    err.textContent = 'Request failed: ' + e2.message;
  }
  btn.disabled = false;
}
</script>
</body></html>`;

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TemuTalk Control Panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, -apple-system, sans-serif;
    background: #0f1115; color: #e6e8ec; padding: 24px;
  }
  h1 { font-size: 1.3rem; margin: 0 0 4px; display: inline-block; }
  .sub { color: #8b93a3; font-size: 0.85rem; margin-bottom: 24px; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; }
  .logout { background: none; border: 1px solid #2c3242; color: #8b93a3; border-radius: 8px;
    padding: 6px 12px; font-size: 0.78rem; cursor: pointer; }
  .card {
    background: #181b22; border: 1px solid #262b36; border-radius: 12px;
    padding: 16px 18px; margin-bottom: 12px; display: flex; align-items: center;
    justify-content: space-between; gap: 12px;
  }
  .name { font-weight: 600; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; }
  .dot.on { background: #3ddc84; box-shadow: 0 0 6px #3ddc84; }
  .dot.off { background: #4a4f5c; }
  .row { display: flex; align-items: center; }
  .meta { color: #8b93a3; font-size: 0.8rem; margin-top: 2px; }
  button.act {
    border: none; border-radius: 8px; padding: 8px 14px; font-size: 0.85rem;
    font-weight: 600; cursor: pointer; margin-left: 6px;
  }
  .btn-start { background: #2e7d4f; color: #eafff3; }
  .btn-stop  { background: #7d2e3a; color: #ffeaea; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 18px; }
  .toolbar button { margin: 0; }
  a { color: #6ab0ff; }
  #log {
    background: #0a0c10; border: 1px solid #262b36; border-radius: 8px;
    padding: 10px 12px; font-family: ui-monospace, monospace; font-size: 0.78rem;
    color: #9aa4b5; white-space: pre-wrap; max-height: 160px; overflow-y: auto; margin-top: 18px;
  }
</style>
</head>
<body>
  <div class="topbar">
    <h1>TemuTalk Speaker</h1>
    <button class="logout" onclick="logout()">Log out</button>
  </div>
  <div class="sub">Control panel — <span id="url">...</span></div>

  <div class="toolbar">
    <button class="act btn-start" onclick="act('all','start')">Start everything</button>
    <button class="act btn-stop" onclick="act('all','stop')">Stop everything</button>
  </div>

  <div class="card" id="card-icecast">
    <div class="row"><span class="dot off" id="dot-icecast"></span>
      <div><div class="name">Icecast2</div><div class="meta">Audio stream server (:8000)</div></div>
    </div>
    <div>
      <button class="act btn-start" onclick="act('icecast','start')">Start</button>
      <button class="act btn-stop" onclick="act('icecast','stop')">Stop</button>
    </div>
  </div>

  <div class="card" id="card-ffmpeg">
    <div class="row"><span class="dot off" id="dot-ffmpeg"></span>
      <div><div class="name">ffmpeg</div><div class="meta" id="meta-ffmpeg">System audio capture</div></div>
    </div>
    <div>
      <button class="act btn-start" onclick="act('ffmpeg','start')">Start</button>
      <button class="act btn-stop" onclick="act('ffmpeg','stop')">Stop</button>
    </div>
  </div>

  <div class="card" id="card-node">
    <div class="row"><span class="dot off" id="dot-node"></span>
      <div><div class="name">Server + tunnel</div><div class="meta">Node app + Cloudflare tunnel — <a id="app-url" href="#" target="_blank">open</a></div></div>
    </div>
    <div>
      <button class="act btn-start" onclick="act('node','start')">Start</button>
      <button class="act btn-stop" onclick="act('node','stop')">Stop</button>
    </div>
  </div>

  <div id="log">Loading status...</div>

<script>
function setDot(id, on) {
  const el = document.getElementById('dot-' + id);
  if (el) el.className = 'dot ' + (on ? 'on' : 'off');
}
function log(msg) {
  const el = document.getElementById('log');
  el.textContent = msg + '\\n' + el.textContent;
}
async function refresh() {
  try {
    const r = await fetch('/api/status');
    if (r.status === 401) { location.reload(); return; }
    const s = await r.json();
    setDot('icecast', s.icecast);
    setDot('ffmpeg', s.ffmpeg);
    setDot('node', s.node);
    document.getElementById('url').textContent = s.url;
    document.getElementById('app-url').href = s.url;
    document.getElementById('meta-ffmpeg').textContent =
      'System audio capture' + (s.audioConfigured ? ' (' + s.audioSource + ')' : ' — no source configured');
  } catch (e) {
    log('status check failed: ' + e.message);
  }
}
async function act(component, action) {
  log((action === 'start' ? 'Starting ' : 'Stopping ') + component + '...');
  try {
    const r = await fetch('/api/' + action + '/' + component, { method: 'POST' });
    if (r.status === 401) { location.reload(); return; }
    const j = await r.json();
    if (j.output) log(j.output);
    await refresh();
  } catch (e) {
    log('request failed: ' + e.message);
  }
}
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;


const tls = loadOrCreateCert();

const server = https.createServer(tls, async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'https://localhost');
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      sendJson(res, 429, { error: `Too many attempts — try again in ${Math.ceil(limit.retryAfterMs / 1000)}s` });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let keyContent = '';
      try { keyContent = JSON.parse(body).keyContent || ''; } catch { /* ignore */ }
      if (verifyKeyContent(keyContent)) {
        recordSuccess(ip);
        const payload = `s:${Date.now() + SESSION_TTL_MS}`;
        const session = signSession(payload);
        res.setHeader('Set-Cookie', `panel_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        sendJson(res, 200, { ok: true });
      } else {
        recordFailure(ip);
        sendJson(res, 401, { error: 'Invalid key file' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    res.setHeader('Set-Cookie', 'panel_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/') {
    if (!isAuthed(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isAuthed(req)) {
      sendJson(res, 401, { error: 'Not authenticated' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const status = await getStatus();
      if (!status) { sendJson(res, 502, { error: 'status check failed' }); return; }
      sendJson(res, 200, status);
      return;
    }

    const match = url.pathname.match(/^\/api\/(start|stop)\/([a-z]+)$/);
    if (req.method === 'POST' && match) {
      const [, action, component] = match;
      if (!COMPONENTS.has(component)) { sendJson(res, 400, { error: 'unknown component' }); return; }
      const result = await runInstall(action, component);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use — panel may already be running. Kill the existing process or set PANEL_PORT to a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Control panel listening on https://0.0.0.0:${PORT}`);
});
