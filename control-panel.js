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
const os = require('os');

const PORT = parseInt(process.env.PANEL_PORT || '9090', 10);
const INSTALL_SH = process.env.INSTALL_SH || path.join(__dirname, 'install.sh');
const RUN_DIR = path.join(__dirname, '.run');
const COMPONENTS = new Set(['icecast', 'ffmpeg', 'node', 'all']);

// ─── USB drive gate ─────────────────────────────────────────────────────────
// The panel is only accessible when the labelled USB drive is mounted.
// Checked every 5 s (cached) using fast synchronous stat — no subprocess.
const USB_LABEL = process.env.USB_LABEL || 'C98E-49E1';
const USB_PATHS = [
  `/media/${os.userInfo().username}/${USB_LABEL}`,
  `/run/media/${os.userInfo().username}/${USB_LABEL}`,
  `/mnt/${USB_LABEL}`,
  `/media/${USB_LABEL}`,
  process.env.USB_MOUNT || '',
].filter(Boolean);

let _usbCache = { ok: false, ts: 0 };
function isUsbMounted() {
  const now = Date.now();
  if (now - _usbCache.ts < 5000) return _usbCache.ok;
  const ok = USB_PATHS.some(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  _usbCache = { ok, ts: now };
  return ok;
}

function usbMountPath() {
  return USB_PATHS.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) || null;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 10 * 60 * 1000;

fs.mkdirSync(RUN_DIR, { recursive: true });

// ─── Token (gates the panel) ────────────────────────────────────────────────
const TOKEN_FILE = path.join(RUN_DIR, 'panel-token');
let TOKEN;
if (fs.existsSync(TOKEN_FILE)) {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} else {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}
console.log(`Panel token (also saved to ${TOKEN_FILE}): ${TOKEN}`);

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
  const cookies = parseCookies(req);
  if (verifySession(cookies.panel_session)) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') && timingSafeEqualStr(auth.slice(7), TOKEN)) return true;
  return false;
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TemuTalk Control Panel — Login</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e8ec; display: flex;
    align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { background: #181b22; border: 1px solid #262b36; border-radius: 12px; padding: 28px; width: 320px; }
  h1 { font-size: 1.1rem; margin: 0 0 16px; }
  input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #2c3242; background: #0a0c10;
    color: #e6e8ec; font-family: ui-monospace, monospace; margin-bottom: 10px; }
  button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #2e7d4f; color: #eafff3;
    font-weight: 600; cursor: pointer; }
  .err { color: #ff8080; font-size: 0.82rem; min-height: 1.2em; margin-bottom: 8px; }
  .hint { color: #8b93a3; font-size: 0.78rem; margin-top: 14px; }
</style></head>
<body>
  <form class="box" id="f">
    <h1>TemuTalk Control Panel</h1>
    <div class="err" id="err"></div>
    <input type="password" id="token" placeholder="Access token" autofocus autocomplete="off">
    <button type="submit">Unlock</button>
    <div class="hint">Token is on the host at .run/panel-token</div>
  </form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('token').value;
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (r.ok) { location.reload(); return; }
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || ('Login failed (' + r.status + ')');
  } catch (e2) {
    err.textContent = 'Request failed: ' + e2.message;
  }
});
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

const USB_REQUIRED_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Control Panel — USB Required</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e8ec;
    display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; }
  .icon { font-size: 3rem; margin-bottom: 16px; }
  h1 { font-size: 1.2rem; margin: 0 0 8px; }
  p { color: #8b93a3; font-size: 0.9rem; margin: 0; }
</style>
<meta http-equiv="refresh" content="4">
</head><body>
  <div class="box">
    <div class="icon">&#128190;</div>
    <h1>USB drive required</h1>
    <p>Plug in the TemuTalk USB drive to access the control panel.</p>
    <p style="margin-top:8px;font-size:0.78rem;color:#4a4f5c">Checking again in 4 s...</p>
  </div>
</body></html>`;

const tls = loadOrCreateCert();

const server = https.createServer(tls, async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'https://localhost');
  const ip = req.socket.remoteAddress || 'unknown';

  // USB gate — every request requires the drive to be mounted
  if (!isUsbMounted()) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(USB_REQUIRED_PAGE);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      sendJson(res, 429, { error: `Too many attempts — try again in ${Math.ceil(limit.retryAfterMs / 1000)}s` });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let token = '';
      try { token = JSON.parse(body).token || ''; } catch { /* ignore */ }
      if (typeof token === 'string' && timingSafeEqualStr(token, TOKEN)) {
        recordSuccess(ip);
        const payload = `s:${Date.now() + SESSION_TTL_MS}`;
        const session = signSession(payload);
        res.setHeader('Set-Cookie', `panel_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        sendJson(res, 200, { ok: true });
      } else {
        recordFailure(ip);
        sendJson(res, 401, { error: 'Invalid token' });
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
