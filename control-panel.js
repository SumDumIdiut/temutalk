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
const http  = require('http');
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

const SERVER_PORT = parseInt(process.env.PORT || '3001', 10);
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

function fetchServerJson(urlPath) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method: 'GET', agent: tlsAgent },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
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

function loginPage(base) { return `<!DOCTYPE html>
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
const P = '${base}';
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
    const r = await fetch(P + '/api/login', {
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
</body></html>`; }

function page(base) { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TemuTalk Control Panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0a0c10; color: #e6e8ec; }
  .topbar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 24px; background: #0f1115; border-bottom: 1px solid #1e2330;
    position: sticky; top: 0; z-index: 10;
  }
  .topbar h1 { font-size: 1.05rem; margin: 0; }
  .topbar-right { display: flex; align-items: center; gap: 14px; }
  .server-url { color: #6ab0ff; font-size: 0.78rem; text-decoration: none; }
  .logout { background: none; border: 1px solid #2c3242; color: #8b93a3; border-radius: 8px;
    padding: 5px 12px; font-size: 0.78rem; cursor: pointer; }
  .content { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }
  .section { margin-bottom: 28px; }
  .section-title {
    font-size: 0.72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: #556; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #1a1e28;
  }
  .card {
    background: #111420; border: 1px solid #1e2330; border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px;
  }
  .card.flex { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .card-label { font-weight: 600; font-size: 0.9rem; }
  .card-sub { color: #8b93a3; font-size: 0.78rem; margin-top: 2px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; flex-shrink: 0; }
  .dot.on  { background: #3ddc84; box-shadow: 0 0 5px #3ddc84; }
  .dot.off { background: #343944; }
  .dot.warn { background: #f0a500; box-shadow: 0 0 5px #f0a500; }
  .row { display: flex; align-items: center; }
  .btns { display: flex; gap: 6px; flex-shrink: 0; }
  button.act {
    border: none; border-radius: 8px; padding: 7px 13px; font-size: 0.82rem;
    font-weight: 600; cursor: pointer;
  }
  .btn-start { background: #1e4d35; color: #6effa0; }
  .btn-stop  { background: #4d1e28; color: #ff8090; }
  .btn-all-start { background: #1e3a5f; color: #7ec8ff; }
  .btn-all-stop  { background: #4a1a2a; color: #ff9090; }
  .pill {
    display: inline-block; border-radius: 20px; padding: 2px 8px;
    font-size: 0.7rem; font-weight: 600; margin-right: 4px; margin-top: 3px;
  }
  .pill-green  { background: #1a3a28; color: #5ddd8a; }
  .pill-blue   { background: #1a2d4a; color: #6ab0ff; }
  .pill-yellow { background: #3a2d10; color: #f0c060; }
  .pill-gray   { background: #1e222c; color: #8b93a3; }
  .pill-red    { background: #3a1a20; color: #ff8090; }
  .track-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .album-art { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: #1e2330; }
  .track-info { min-width: 0; }
  .track-name { font-weight: 600; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track-meta { color: #8b93a3; font-size: 0.76rem; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .progress-bar { background: #1e2330; border-radius: 3px; height: 3px; margin-top: 8px; overflow: hidden; }
  .progress-fill { background: #3ddc84; height: 100%; transition: width .5s linear; }
  .device-info { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .device-vol { display: flex; align-items: center; gap: 4px; color: #8b93a3; font-size: 0.76rem; }
  .vol-bar { background: #1e2330; border-radius: 2px; height: 4px; width: 50px; overflow: hidden; display: inline-block; vertical-align: middle; }
  .vol-fill { background: #6ab0ff; height: 100%; }
  .ip-list { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #9aa4b5; }
  .dim { color: #4a5060; font-style: italic; font-size: 0.82rem; }
  .sys-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .sys-stat { background: #111420; border: 1px solid #1e2330; border-radius: 10px; padding: 12px 14px; }
  .sys-val { font-size: 1.4rem; font-weight: 700; }
  .sys-label { color: #8b93a3; font-size: 0.72rem; margin-top: 2px; }
  .bar { background: #1e2330; border-radius: 3px; height: 5px; margin-top: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-fill.green  { background: #3ddc84; }
  .bar-fill.orange { background: #f0a500; }
  .bar-fill.red    { background: #f04050; }
  #log {
    background: #080a0e; border: 1px solid #1a1e28; border-radius: 8px;
    padding: 10px 12px; font-family: ui-monospace, monospace; font-size: 0.75rem;
    color: #9aa4b5; white-space: pre-wrap; max-height: 140px; overflow-y: auto; margin-top: 10px;
  }
  a { color: #6ab0ff; }
</style>
</head>
<body>
<div class="topbar">
  <h1>&#9654; TemuTalk</h1>
  <div class="topbar-right">
    <a class="server-url" id="app-url" href="#" target="_blank">codecade.co.za</a>
    <button class="logout" onclick="logout()">Log out</button>
  </div>
</div>
<div class="content">

  <div class="section">
    <div class="section-title">Services</div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button class="act btn-all-start" onclick="act('all','start')">Start all</button>
      <button class="act btn-all-stop" onclick="act('all','stop')">Stop all</button>
    </div>
    <div class="card flex" id="card-icecast">
      <div class="row"><span class="dot off" id="dot-icecast"></span>
        <div><div class="card-label">Icecast2</div><div class="card-sub">Audio stream server :8000</div></div>
      </div>
      <div class="btns">
        <button class="act btn-start" onclick="act('icecast','start')">Start</button>
        <button class="act btn-stop"  onclick="act('icecast','stop')">Stop</button>
      </div>
    </div>
    <div class="card flex" id="card-ffmpeg">
      <div class="row"><span class="dot off" id="dot-ffmpeg"></span>
        <div><div class="card-label">ffmpeg</div><div class="card-sub" id="meta-ffmpeg">System audio capture</div></div>
      </div>
      <div class="btns">
        <button class="act btn-start" onclick="act('ffmpeg','start')">Start</button>
        <button class="act btn-stop"  onclick="act('ffmpeg','stop')">Stop</button>
      </div>
    </div>
    <div class="card flex" id="card-node">
      <div class="row"><span class="dot off" id="dot-node"></span>
        <div><div class="card-label">Server + tunnel</div><div class="card-sub">Node.js + Cloudflare</div></div>
      </div>
      <div class="btns">
        <button class="act btn-start" onclick="act('node','start')">Start</button>
        <button class="act btn-stop"  onclick="act('node','stop')">Stop</button>
      </div>
    </div>
    <div id="log"></div>
  </div>

  <div class="section">
    <div class="section-title">Connected Sessions — <span id="session-count">0</span> device(s), <span id="tab-count">0</span> tab(s)</div>
    <div id="sessions"><div class="dim">No browsers connected</div></div>
  </div>

  <div class="section">
    <div class="section-title">Cast Listeners — <span id="listener-count">0</span> listening to /stream</div>
    <div id="cast-listeners"><div class="dim">Nobody is listening</div></div>
  </div>

  <div class="section">
    <div class="section-title">Stored Devices (offline)</div>
    <div id="offline-devices"><div class="dim">None</div></div>
  </div>

  <div class="section">
    <div class="section-title">System</div>
    <div class="sys-grid" id="sys-grid"></div>
  </div>

</div>
<script>
const P = '${base}';

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmtDur(ms) {
  if (!ms) return '0:00';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
function fmtUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function fmtBytes(b) {
  if (b > 1e9) return (b/1e9).toFixed(1) + ' GB';
  return (b/1e6).toFixed(0) + ' MB';
}
function barColor(pct) { return pct > 85 ? 'red' : pct > 60 ? 'orange' : 'green'; }

function setDot(id, on) {
  const el = document.getElementById('dot-' + id);
  if (el) el.className = 'dot ' + (on ? 'on' : 'off');
}
function log(msg) {
  const el = document.getElementById('log');
  el.textContent = (msg + '\\n' + el.textContent).slice(0, 3000);
}

function renderSessions(devices) {
  const el = document.getElementById('sessions');
  if (!devices || !devices.length) { el.innerHTML = '<div class="dim">No browsers connected</div>'; return; }
  let totalTabs = 0;
  el.innerHTML = devices.map(d => {
    totalTabs += d.tabs || 0;
    const p = d.player;
    const u = d.user;
    const r = d.radio;
    const artHtml = p?.track?.albumArt
      ? '<img class="album-art" src="' + esc(p.track.albumArt) + '" onerror="this.style.display=\\'none\\'">'
      : '<div class="album-art"></div>';
    const trackHtml = p?.track ? \`
      <div class="track-row">
        \${artHtml}
        <div class="track-info">
          <div class="track-name">\${esc(p.track.name)}</div>
          <div class="track-meta">\${esc(p.track.artists)} · \${esc(p.track.album)}</div>
          \${p.track.durationMs ? \`<div class="progress-bar"><div class="progress-fill" style="width:\${Math.min(100,(p.track.progressMs||0)/p.track.durationMs*100).toFixed(1)}%"></div></div>\` : ''}
          <div style="color:#8b93a3;font-size:.72rem;margin-top:3px">\${fmtDur(p.track.progressMs)} / \${fmtDur(p.track.durationMs)}</div>
        </div>
      </div>\` : '';
    const devHtml = p?.device ? \`
      <div class="device-info">
        <span class="pill \${p.device.isActive ? 'pill-green' : 'pill-gray'}">\${esc(p.device.type || 'Device')}</span>
        <span style="font-size:.8rem">\${esc(p.device.name)}</span>
        <span class="device-vol">
          <div class="vol-bar"><div class="vol-fill" style="width:\${p.device.volume ?? 0}%"></div></div>
          \${p.device.volume ?? 0}%
        </span>
        \${p.shuffleState ? '<span class="pill pill-blue">Shuffle</span>' : ''}
        \${p.repeatState && p.repeatState !== 'off' ? \`<span class="pill pill-yellow">Repeat \${p.repeatState}</span>\` : ''}
      </div>\` : '';
    const radioHtml = r ? \`<div style="margin-top:8px"><span class="pill pill-yellow">&#127925; Radio</span> <span style="font-size:.82rem">\${esc(r.name)}</span></div>\` : '';
    return \`<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <div class="row">
            <span class="dot \${d.authenticated ? 'on' : 'off'}"></span>
            <span class="card-label" title="\${esc(d.deviceId)}">\${u?.displayName ? esc(u.displayName) : esc(d.deviceId.slice(0,8)) + '...'}</span>
            \${u?.product === 'premium' ? '<span class="pill pill-green" style="margin-left:6px">Premium</span>' : ''}
          </div>
          \${u?.email ? \`<div class="card-sub" style="margin-left:15px">\${esc(u.email)}</div>\` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <span class="pill pill-blue">\${d.tabs} tab\${d.tabs !== 1 ? 's' : ''}</span>
          \${p?.isPlaying ? '<span class="pill pill-green">&#9654; Playing</span>' : (p ? '<span class="pill pill-gray">Paused</span>' : '')}
        </div>
      </div>
      <div class="ip-list" style="margin-top:4px">\${(d.ips||[]).map(ip=>'&#8594; '+esc(ip)).join('  ')}</div>
      \${trackHtml}\${devHtml}\${radioHtml}
    </div>\`;
  }).join('');
  document.getElementById('tab-count').textContent = totalTabs;
  document.getElementById('session-count').textContent = devices.length;
}

function renderStreamListeners(listeners) {
  const el = document.getElementById('cast-listeners');
  document.getElementById('listener-count').textContent = listeners.length;
  if (!listeners.length) { el.innerHTML = '<div class="dim">Nobody is listening</div>'; return; }
  el.innerHTML = listeners.map(l => \`
    <div class="card flex">
      <div>
        <div class="card-label ip-list">\${esc(l.ip || 'unknown')}</div>
        <div class="card-sub">\${esc((l.ua||'').slice(0,80)) || 'unknown browser'}</div>
      </div>
      <span class="pill pill-green">\${fmtUptime(Math.floor((l.durationMs||0)/1000))}</span>
    </div>\`).join('');
}

function renderOffline(devices) {
  const el = document.getElementById('offline-devices');
  if (!devices.length) { el.innerHTML = '<div class="dim">None</div>'; return; }
  el.innerHTML = devices.map(d => \`
    <div class="card flex">
      <div class="row">
        <span class="dot \${d.authenticated ? 'warn' : 'off'}"></span>
        <span class="ip-list">\${esc(d.deviceId.slice(0,12))}...</span>
        \${d.authenticated ? '<span class="pill pill-yellow" style="margin-left:8px">Has token</span>' : '<span class="pill pill-gray" style="margin-left:8px">No token</span>'}
      </div>
      <span class="pill pill-gray">Offline</span>
    </div>\`).join('');
}

function renderSystem(sys) {
  if (!sys) return;
  const el = document.getElementById('sys-grid');
  const memPct = sys.memPct || 0;
  const load = (sys.loadAvg || [0])[0];
  const loadPct = Math.min(100, (load / (sys.cpuCount || 1)) * 100);
  el.innerHTML = \`
    <div class="sys-stat">
      <div class="sys-val">\${fmtUptime(sys.uptime || 0)}</div>
      <div class="sys-label">System uptime</div>
    </div>
    <div class="sys-stat">
      <div class="sys-val">\${memPct}%</div>
      <div class="sys-label">RAM · \${fmtBytes(sys.totalMem - sys.freeMem)} / \${fmtBytes(sys.totalMem)}</div>
      <div class="bar"><div class="bar-fill \${barColor(memPct)}" style="width:\${memPct}%"></div></div>
    </div>
    <div class="sys-stat">
      <div class="sys-val">\${load.toFixed(2)}</div>
      <div class="sys-label">Load avg (1m) · \${sys.cpuCount} CPU(s)</div>
      <div class="bar"><div class="bar-fill \${barColor(loadPct)}" style="width:\${Math.min(100,loadPct).toFixed(1)}%"></div></div>
    </div>
    <div class="sys-stat">
      <div class="sys-val" style="font-size:1rem">\${esc(sys.hostname || '')}</div>
      <div class="sys-label">\${esc((sys.cpuModel || '').split('@')[0].trim())}</div>
    </div>\`;
}

async function refresh() {
  try {
    const r = await fetch(P + '/api/status');
    if (r.status === 401) { location.reload(); return; }
    const s = await r.json();
    setDot('icecast', s.icecast);
    setDot('ffmpeg', s.ffmpeg);
    setDot('node', s.node);
    if (s.url) document.getElementById('app-url').href = s.url;
    document.getElementById('meta-ffmpeg').textContent =
      s.audioConfigured ? 'System audio (' + s.audioSource + ')' : 'System audio — no source configured';
  } catch (e) { log('status: ' + e.message); }
}

async function refreshAdmin() {
  try {
    const r = await fetch(P + '/api/admin');
    if (r.status === 401) { location.reload(); return; }
    const { overview } = await r.json();
    if (!overview) return;
    renderSessions(overview.connectedDevices || []);
    renderStreamListeners(overview.streamListeners || []);
    renderOffline(overview.offlineDevices || []);
    renderSystem(overview.system);
  } catch (e) { log('admin: ' + e.message); }
}

async function act(component, action) {
  log((action === 'start' ? 'Starting ' : 'Stopping ') + component + '...');
  try {
    const r = await fetch(P + '/api/' + action + '/' + component, { method: 'POST' });
    if (r.status === 401) { location.reload(); return; }
    const j = await r.json();
    if (j.output) log(j.output);
    await refresh();
  } catch (e) { log('act failed: ' + e.message); }
}
async function logout() {
  await fetch(P + '/api/logout', { method: 'POST' });
  location.reload();
}
refresh();
refreshAdmin();
setInterval(refresh, 3000);
setInterval(refreshAdmin, 4000);
</script>
</body>
</html>`; }

const tls = loadOrCreateCert();

async function handleRequest(req, res) {
  securityHeaders(res);
  // When proxied via server.js the X-Panel-Base header tells us the public prefix
  const base = req.socket.localAddress === '127.0.0.1'
    ? (req.headers['x-panel-base'] || '')
    : '';
  const cookiePath = base || '/';
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
        res.setHeader('Set-Cookie', `panel_session=${session}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        sendJson(res, 200, { ok: true });
      } else {
        recordFailure(ip);
        sendJson(res, 401, { error: 'Invalid key file' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    res.setHeader('Set-Cookie', `panel_session=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/') {
    if (!isAuthed(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(base));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(base));
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

    if (req.method === 'GET' && url.pathname === '/api/admin') {
      const [overview, installStatus] = await Promise.all([
        fetchServerJson('/api/admin/overview'),
        getStatus(),
      ]);
      sendJson(res, 200, { overview, installStatus });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

const server = https.createServer(tls, handleRequest);

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

// Internal HTTP listener on PORT+1 (127.0.0.1 only) — used by server.js proxy
http.createServer(handleRequest).listen(PORT + 1, '127.0.0.1', () => {
  console.log(`Control panel internal proxy listener on http://127.0.0.1:${PORT + 1}`);
});
