// TemuTalk Speaker — web control panel.
// HTTPS on 0.0.0.0:PORT for LAN access; plain HTTP on 127.0.0.1:PORT+1 for server.js proxy.
// Auth: SHA-256 of the temutalk.key file content verified against stored hash.

'use strict';
const https  = require('https');
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { exec, execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT       = parseInt(process.env.PANEL_PORT || '9090', 10);
const INSTALL_SH = process.env.INSTALL_SH || path.join(__dirname, 'install.sh');
const RUN_DIR    = path.join(__dirname, '.run');
const LOGS_DIR   = process.env.LOGS_DIR || path.join(__dirname, 'logs');
const COMPONENTS = new Set(['icecast', 'ffmpeg', 'node', 'all']);
const SERVER_PORT = parseInt(process.env.PORT || '3001', 10);

// ── node-pty (optional — terminal degrades gracefully without it) ──────────────
let pty = null;
try { pty = require('node-pty'); } catch {}

// ─── Key-file gate ────────────────────────────────────────────────────────────
const KEY_HASH_FILE = path.join(RUN_DIR, 'panel-key-hash');

function verifyKeyContent(content) {
  if (!content || content.trim().length < 100) return false;
  const hash = crypto.createHash('sha256').update(content.trim()).digest('hex');
  try {
    return timingSafeEqualStr(hash, fs.readFileSync(KEY_HASH_FILE, 'utf8').trim());
  } catch { return false; }
}

const SESSION_TTL_MS   = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS     = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS       = 10 * 60 * 1000;

fs.mkdirSync(RUN_DIR, { recursive: true });

const SESSION_SECRET = crypto.randomBytes(32);

function timingSafeEqualStr(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) { crypto.timingSafeEqual(A, A); return false; }
  return crypto.timingSafeEqual(A, B);
}
function signSession(payload) {
  return `${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
}
function verifySession(val) {
  if (!val) return false;
  const idx = val.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = val.slice(0, idx), sig = val.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return false;
  const exp = parseInt(payload.split(':')[1], 10);
  return Number.isFinite(exp) && Date.now() < exp;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
function isAuthed(req) { return verifySession(parseCookies(req).panel_session); }

// ─── Rate limiting ────────────────────────────────────────────────────────────
const attempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now(), rec = attempts.get(ip);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && now < rec.lockedUntil) return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  if (now - rec.windowStart > ATTEMPT_WINDOW_MS) { attempts.delete(ip); return { allowed: true }; }
  return { allowed: true };
}
function recordFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) rec = { count: 0, windowStart: now, lockedUntil: 0 };
  if (++rec.count >= MAX_ATTEMPTS) rec.lockedUntil = now + LOCKOUT_MS;
  attempts.set(ip, rec);
}
function recordSuccess(ip) { attempts.delete(ip); }

// ─── TLS ──────────────────────────────────────────────────────────────────────
function loadOrCreateCert() {
  const sk = path.join(__dirname, '.cert-key.pem'), sc = path.join(__dirname, '.cert-cert.pem');
  if (fs.existsSync(sk) && fs.existsSync(sc)) return { key: fs.readFileSync(sk), cert: fs.readFileSync(sc) };
  const pk = path.join(__dirname, '.panel-cert-key.pem'), pc = path.join(__dirname, '.panel-cert-cert.pem');
  if (fs.existsSync(pk) && fs.existsSync(pc)) return { key: fs.readFileSync(pk), cert: fs.readFileSync(pc) };
  const { generate } = require('selfsigned');
  const pems = generate([{ name: 'commonName', value: 'temutalk-panel' }], { days: 3650, algorithm: 'sha256', keySize: 2048 });
  fs.writeFileSync(pk, pems.private, { mode: 0o600 });
  fs.writeFileSync(pc, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const tlsAgent = new https.Agent({ rejectUnauthorized: false });
function fetchServerJson(urlPath) {
  return new Promise(resolve => {
    const req = https.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method: 'GET', agent: tlsAgent }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function runInstall(action, component) {
  return new Promise(resolve => {
    execFile('bash', [INSTALL_SH, action, component], { timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: (stdout + stderr).trim() });
    });
  });
}
function getStatus() {
  return new Promise(resolve => {
    execFile('bash', [INSTALL_SH, 'status'], { timeout: 10000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

function sendJson(res, status, body, extra) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, extra || {}));
  res.end(data);
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'unsafe-inline' 'self' https://cdn.jsdelivr.net; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "connect-src 'self' wss: ws:; " +
    "font-src https://cdn.jsdelivr.net; " +
    "img-src 'self' data: https://i.scdn.co blob:"
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ─── Volume helpers ────────────────────────────────────────────────────────────
function getVolume() {
  return new Promise(resolve => {
    exec('pactl get-sink-volume @DEFAULT_SINK@', (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = stdout.match(/(\d+)%/);
      resolve(m ? parseInt(m[1], 10) : null);
    });
  });
}
function getMute() {
  return new Promise(resolve => {
    exec('pactl get-sink-mute @DEFAULT_SINK@', (err, stdout) => {
      resolve(!err && stdout.includes('yes'));
    });
  });
}

// ─── Login page ────────────────────────────────────────────────────────────────
function loginPage(base) { return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Panel — Login</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#181b22;border:1px solid #262b36;border-radius:14px;padding:30px;width:340px}
h1{font-size:1.1rem;margin:0 0 6px}.sub{color:#8b93a3;font-size:.82rem;margin-bottom:22px}
.drop{border:2px dashed #2c3242;border-radius:10px;padding:28px 16px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;margin-bottom:14px}
.drop:hover,.drop.over{border-color:#3ddc84;background:#0f1e16}.drop.ready{border-color:#3ddc84;border-style:solid;background:#0f1e16}
.drop-icon{font-size:2rem;margin-bottom:8px}.drop-label{font-size:.88rem;color:#8b93a3}
.drop-name{font-size:.85rem;color:#3ddc84;margin-top:6px;font-family:ui-monospace,monospace}
input[type=file]{display:none}
button{width:100%;padding:11px;border:none;border-radius:9px;background:#2e7d4f;color:#eafff3;font-weight:600;font-size:.95rem;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
.err{color:#ff8080;font-size:.82rem;min-height:1.2em;margin-bottom:10px;text-align:center}
.hint{color:#3a3f4a;font-size:.75rem;margin-top:14px;text-align:center}
</style></head>
<body><div class="box">
  <h1>TemuTalk Control Panel</h1>
  <div class="sub">Select your key file to unlock</div>
  <div class="drop" id="drop" onclick="document.getElementById('fi').click()">
    <div class="drop-icon">&#128190;</div>
    <div class="drop-label">Click to select <strong>temutalk.key</strong></div>
    <div class="drop-label" style="margin-top:4px;font-size:.76rem">or drag and drop</div>
    <div class="drop-name" id="fname"></div>
  </div>
  <input type="file" id="fi" accept=".key,*">
  <div class="err" id="err"></div>
  <button id="btn" disabled onclick="doLogin()">Unlock</button>
  <div class="hint">Key file lives on the TemuTalk USB drive as temutalk.key</div>
</div>
<script>
const P='${base}';let keyContent='';
const drop=document.getElementById('drop'),btn=document.getElementById('btn'),err=document.getElementById('err');
function readFile(f){const r=new FileReader();r.onload=e=>{keyContent=e.target.result;document.getElementById('fname').textContent=f.name;drop.classList.add('ready');btn.disabled=false;err.textContent='';};r.readAsText(f);}
document.getElementById('fi').addEventListener('change',e=>{if(e.target.files[0])readFile(e.target.files[0]);});
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])readFile(e.dataTransfer.files[0]);});
async function doLogin(){err.textContent='';btn.disabled=true;
  try{const r=await fetch(P+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyContent})});
  if(r.ok){location.reload();return;}const j=await r.json().catch(()=>({}));err.textContent=j.error||'Login failed ('+r.status+')';}
  catch(e2){err.textContent='Request failed: '+e2.message;}btn.disabled=false;}
</script></body></html>`; }

// ─── Main page ─────────────────────────────────────────────────────────────────
function page(base) { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Control Panel</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0c10;color:#e6e8ec}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#0f1115;border-bottom:1px solid #1e2330;position:sticky;top:0;z-index:100}
.topbar h1{font-size:1rem;margin:0}
.topbar-right{display:flex;align-items:center;gap:12px}
.server-url{color:#6ab0ff;font-size:.78rem;text-decoration:none}
.logout{background:none;border:1px solid #2c3242;color:#8b93a3;border-radius:8px;padding:5px 12px;font-size:.78rem;cursor:pointer}
.tabnav{display:flex;gap:0;background:#0d1017;border-bottom:1px solid #1e2330;padding:0 16px;overflow-x:auto}
.tabnav button{background:none;border:none;color:#8b93a3;padding:10px 16px;font-size:.82rem;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s}
.tabnav button:hover{color:#e6e8ec}
.tabnav button.active{color:#3ddc84;border-bottom-color:#3ddc84}
.content{padding:20px;max-width:1100px;margin:0 auto}
.tab{display:none}.tab.active{display:block}
.section{margin-bottom:24px}
.section-title{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#556;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #1a1e28}
.card{background:#111420;border:1px solid #1e2330;border-radius:12px;padding:14px 16px;margin-bottom:10px}
.card.flex{display:flex;align-items:center;justify-content:space-between;gap:12px}
.card-label{font-weight:600;font-size:.9rem}
.card-sub{color:#8b93a3;font-size:.78rem;margin-top:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;flex-shrink:0}
.dot.on{background:#3ddc84;box-shadow:0 0 5px #3ddc84}.dot.off{background:#343944}.dot.warn{background:#f0a500;box-shadow:0 0 5px #f0a500}
.row{display:flex;align-items:center}
.btns{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
button.act{border:none;border-radius:8px;padding:7px 13px;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap}
.btn-start{background:#1e4d35;color:#6effa0}.btn-stop{background:#4d1e28;color:#ff8090}
.btn-all-start{background:#1e3a5f;color:#7ec8ff}.btn-all-stop{background:#4a1a2a;color:#ff9090}
.btn-action{background:#1e2940;color:#90c0ff}.btn-warn{background:#3a2010;color:#ffb060}
.btn-danger{background:#3a1010;color:#ff6060}.btn-green{background:#1a3a28;color:#6effa0}
.pill{display:inline-block;border-radius:20px;padding:2px 8px;font-size:.7rem;font-weight:600;margin-right:4px;margin-top:3px}
.pill-green{background:#1a3a28;color:#5ddd8a}.pill-blue{background:#1a2d4a;color:#6ab0ff}
.pill-yellow{background:#3a2d10;color:#f0c060}.pill-gray{background:#1e222c;color:#8b93a3}.pill-red{background:#3a1a20;color:#ff8090}
.track-row{display:flex;align-items:center;gap:12px;margin-top:10px}
.album-art{width:44px;height:44px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#1e2330}
.track-info{min-width:0}
.track-name{font-weight:600;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track-meta{color:#8b93a3;font-size:.76rem;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress-bar{background:#1e2330;border-radius:3px;height:3px;margin-top:8px;overflow:hidden}
.progress-fill{background:#3ddc84;height:100%;transition:width .5s linear}
.device-info{display:flex;align-items:center;gap:6px;margin-top:6px}
.device-vol{display:flex;align-items:center;gap:4px;color:#8b93a3;font-size:.76rem}
.vol-bar{background:#1e2330;border-radius:2px;height:4px;width:50px;overflow:hidden;display:inline-block;vertical-align:middle}
.vol-fill{background:#6ab0ff;height:100%}
.ip-list{font-family:ui-monospace,monospace;font-size:.75rem;color:#9aa4b5}
.dim{color:#4a5060;font-style:italic;font-size:.82rem}
.sys-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.sys-stat{background:#111420;border:1px solid #1e2330;border-radius:10px;padding:12px 14px}
.sys-val{font-size:1.4rem;font-weight:700}
.sys-label{color:#8b93a3;font-size:.72rem;margin-top:2px}
.bar{background:#1e2330;border-radius:3px;height:5px;margin-top:8px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px}
.bar-fill.green{background:#3ddc84}.bar-fill.orange{background:#f0a500}.bar-fill.red{background:#f04050}
#logbox{background:#080a0e;border:1px solid #1a1e28;border-radius:8px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:.75rem;color:#9aa4b5;white-space:pre-wrap;max-height:180px;overflow-y:auto;margin-top:10px}
.vol-row{display:flex;align-items:center;gap:12px;margin:10px 0}
.vol-slider{-webkit-appearance:none;appearance:none;width:200px;height:5px;border-radius:3px;background:#1e2330;outline:none;cursor:pointer}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#6ab0ff;cursor:pointer}
.apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin:10px 0}
.app-btn{background:#111420;border:1px solid #1e2330;border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s;font-size:.85rem;font-weight:600;color:#e6e8ec;display:flex;flex-direction:column;align-items:center;gap:8px}
.app-btn:hover{background:#161b28;border-color:#2a3348}
.app-btn .app-icon{font-size:1.8rem}
.power-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0}
@media(max-width:500px){.power-grid{grid-template-columns:repeat(2,1fr)}}
.power-btn{background:#111420;border:1px solid #1e2330;border-radius:12px;padding:14px 8px;text-align:center;cursor:pointer;font-size:.8rem;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:6px;transition:background .15s}
.power-btn .icon{font-size:1.5rem}
.power-btn:hover{background:#161b28}
.power-btn.danger:hover{background:#2a0f0f;border-color:#4a1a1a}
#terminal-wrap{background:#080a0e;border:1px solid #1e2330;border-radius:10px;padding:8px;min-height:420px}
.log-controls{display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap}
.log-controls select,.log-controls input{background:#111420;border:1px solid #1e2330;color:#e6e8ec;border-radius:6px;padding:5px 8px;font-size:.8rem}
a{color:#6ab0ff}
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

<div class="tabnav">
  <button class="active" onclick="showTab('services',this)">Services</button>
  <button onclick="showTab('control',this)">Control</button>
  <button onclick="showTab('terminal',this)">Terminal</button>
  <button onclick="showTab('sessions',this)">Sessions</button>
  <button onclick="showTab('system',this)">System</button>
</div>

<div class="content">

<!-- ── SERVICES ────────────────────────────────────────────────────────────── -->
<div id="tab-services" class="tab active">
  <div class="section">
    <div class="section-title">Services</div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button class="act btn-all-start" onclick="act('all','start')">Start all</button>
      <button class="act btn-all-stop" onclick="act('all','stop')">Stop all</button>
      <button class="act btn-action" onclick="restartServer()">&#8635; Restart server</button>
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
    <div id="logbox"></div>
  </div>

  <div class="section">
    <div class="section-title">Log viewer</div>
    <div class="log-controls">
      <select id="log-source" onchange="loadLogs()">
        <option value="server">server.log</option>
        <option value="panel">panel.log</option>
        <option value="ffmpeg">ffmpeg.log</option>
      </select>
      <input type="number" id="log-lines" value="80" min="10" max="500" style="width:70px" onchange="loadLogs()">
      <button class="act btn-action" onclick="loadLogs()">&#8635; Refresh</button>
    </div>
    <div id="logview" style="background:#080a0e;border:1px solid #1a1e28;border-radius:8px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:.74rem;color:#9aa4b5;white-space:pre-wrap;max-height:340px;overflow-y:auto"></div>
  </div>
</div>

<!-- ── CONTROL ─────────────────────────────────────────────────────────────── -->
<div id="tab-control" class="tab">

  <div class="section">
    <div class="section-title">Volume</div>
    <div class="card">
      <div class="vol-row">
        <span id="vol-icon" style="font-size:1.3rem">&#128266;</span>
        <input type="range" class="vol-slider" id="vol-slider" min="0" max="100" value="50" oninput="onVolSlider(this.value)" onchange="setVol(this.value)">
        <span id="vol-label" style="font-size:1rem;font-weight:700;min-width:45px">50%</span>
        <button class="act btn-action" onclick="toggleMute()">Mute</button>
      </div>
      <div class="btns" style="margin-top:8px">
        <button class="act btn-action" onclick="setVol(25)">25%</button>
        <button class="act btn-action" onclick="setVol(50)">50%</button>
        <button class="act btn-action" onclick="setVol(75)">75%</button>
        <button class="act btn-action" onclick="setVol(100)">100%</button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Apps</div>
    <div class="apps-grid">
      <div class="app-btn" onclick="launch('spotify')">
        <div class="app-icon">&#127925;</div>
        <div>Spotify</div>
      </div>
      <div class="app-btn" onclick="launch('browser')">
        <div class="app-icon">&#127760;</div>
        <div>Browser</div>
      </div>
      <div class="app-btn" onclick="launch('files')">
        <div class="app-icon">&#128193;</div>
        <div>Files</div>
      </div>
      <div class="app-btn" onclick="launch('music-player')">
        <div class="app-icon">&#127932;</div>
        <div>Music Player</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Power</div>
    <div class="power-grid">
      <div class="power-btn" onclick="confirmPower('lock')">
        <div class="icon">&#128274;</div>
        <div>Lock</div>
      </div>
      <div class="power-btn" onclick="confirmPower('sleep')">
        <div class="icon">&#128164;</div>
        <div>Sleep</div>
      </div>
      <div class="power-btn danger" onclick="confirmPower('reboot')">
        <div class="icon">&#8635;</div>
        <div>Reboot</div>
      </div>
      <div class="power-btn danger" onclick="confirmPower('shutdown')">
        <div class="icon">&#9211;</div>
        <div>Shutdown</div>
      </div>
    </div>
  </div>

</div>

<!-- ── TERMINAL ────────────────────────────────────────────────────────────── -->
<div id="tab-terminal" class="tab">
  <div class="section">
    <div class="section-title">Shell <span id="term-status" style="font-weight:400;color:#8b93a3">— disconnected</span></div>
    <div style="margin-bottom:8px;display:flex;gap:8px">
      <button class="act btn-start" onclick="connectTerminal()">Connect</button>
      <button class="act btn-stop"  onclick="disconnectTerminal()">Disconnect</button>
      <button class="act btn-action" onclick="if(term)term.clear()">Clear</button>
    </div>
    <div id="terminal-wrap"><div id="terminal"></div></div>
  </div>
</div>

<!-- ── SESSIONS ───────────────────────────────────────────────────────────── -->
<div id="tab-sessions" class="tab">
  <div class="section">
    <div class="section-title">Connected — <span id="session-count">0</span> device(s), <span id="tab-count">0</span> tab(s)</div>
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
</div>

<!-- ── SYSTEM ─────────────────────────────────────────────────────────────── -->
<div id="tab-system" class="tab">
  <div class="section">
    <div class="section-title">System</div>
    <div class="sys-grid" id="sys-grid"></div>
  </div>
</div>

</div><!-- .content -->

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
const P = '${base}';

// ── Tab navigation ────────────────────────────────────────────────────────────
function showTab(id, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tabnav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  if (btn) btn.classList.add('active');
  if (id === 'terminal' && !term) initTerminal();
  if (id === 'services') loadLogs();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDur(ms) { if (!ms) return '0:00'; const s=Math.floor(ms/1000),m=Math.floor(s/60); return m+':'+String(s%60).padStart(2,'0'); }
function fmtUptime(s) { if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; }
function fmtBytes(b) { if(b>1e9)return (b/1e9).toFixed(1)+' GB'; return (b/1e6).toFixed(0)+' MB'; }
function barColor(p) { return p>85?'red':p>60?'orange':'green'; }
function setDot(id,on) { const el=document.getElementById('dot-'+id); if(el) el.className='dot '+(on?'on':'off'); }
function log(msg) { const el=document.getElementById('logbox'); el.textContent=(msg+'\\n'+el.textContent).slice(0,4000); }

// ── Services ──────────────────────────────────────────────────────────────────
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

async function restartServer() {
  log('Restarting server...');
  try {
    const r = await fetch(P + '/api/restart-server', { method: 'POST' });
    const j = await r.json();
    log(j.message || j.error || 'Done');
  } catch (e) { log('restart failed: ' + e.message); }
}

// ── Log viewer ────────────────────────────────────────────────────────────────
async function loadLogs() {
  const source = document.getElementById('log-source').value;
  const lines  = document.getElementById('log-lines').value;
  try {
    const r = await fetch(P + '/api/logs?source=' + source + '&lines=' + lines);
    if (!r.ok) { document.getElementById('logview').textContent = 'Error ' + r.status; return; }
    const j = await r.json();
    const el = document.getElementById('logview');
    el.textContent = j.content || '(empty)';
    el.scrollTop = el.scrollHeight;
  } catch (e) { document.getElementById('logview').textContent = 'Error: ' + e.message; }
}

// ── Volume ────────────────────────────────────────────────────────────────────
function onVolSlider(v) {
  document.getElementById('vol-label').textContent = v + '%';
  document.getElementById('vol-icon').textContent = v == 0 ? '&#128263;' : v < 40 ? '&#128264;' : v < 80 ? '&#128265;' : '&#128266;';
}
async function setVol(v) {
  v = parseInt(v, 10);
  document.getElementById('vol-slider').value = v;
  onVolSlider(v);
  try {
    await fetch(P + '/api/volume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ level: v }) });
  } catch (e) { log('vol: ' + e.message); }
}
async function toggleMute() {
  try {
    const r = await fetch(P + '/api/volume/mute', { method: 'POST' });
    const j = await r.json();
    log('Mute: ' + (j.muted ? 'on' : 'off'));
  } catch (e) { log('mute: ' + e.message); }
}
async function refreshVolume() {
  try {
    const r = await fetch(P + '/api/volume');
    if (!r.ok) return;
    const j = await r.json();
    if (j.volume != null) {
      document.getElementById('vol-slider').value = j.volume;
      onVolSlider(j.volume);
    }
  } catch {}
}

// ── Apps ──────────────────────────────────────────────────────────────────────
async function launch(app) {
  try {
    const r = await fetch(P + '/api/launch/' + app, { method: 'POST' });
    const j = await r.json();
    log('launch ' + app + ': ' + (j.ok ? 'ok' : j.error));
  } catch (e) { log('launch: ' + e.message); }
}

// ── Power ─────────────────────────────────────────────────────────────────────
function confirmPower(action) {
  const dangerous = action === 'reboot' || action === 'shutdown';
  if (dangerous && !confirm('Are you sure you want to ' + action + ' the system?')) return;
  doPower(action);
}
async function doPower(action) {
  try {
    const r = await fetch(P + '/api/power/' + action, { method: 'POST' });
    const j = await r.json();
    log('power ' + action + ': ' + (j.ok ? 'sent' : j.error));
  } catch (e) { log('power: ' + e.message); }
}

// ── Terminal ──────────────────────────────────────────────────────────────────
let term = null, fitAddon = null, termWs = null;

function initTerminal() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#080a0e', foreground: '#e6e8ec', cursor: '#3ddc84', selectionBackground: '#2a3a55' },
    fontFamily: 'ui-monospace, monospace',
    fontSize: 13,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  new ResizeObserver(() => { if (fitAddon) fitAddon.fit(); }).observe(document.getElementById('terminal-wrap'));
  term.writeln('\\x1b[32mTemuTalk terminal — click Connect to start a shell\\x1b[0m');
}

function connectTerminal() {
  if (!term) initTerminal();
  if (termWs && termWs.readyState < 2) { termWs.close(); termWs = null; }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + P + '/terminal';
  document.getElementById('term-status').textContent = '— connecting…';
  termWs = new WebSocket(url);
  termWs.onopen = () => {
    document.getElementById('term-status').textContent = '— connected';
    term.writeln('\\x1b[32m[connected]\\x1b[0m');
    fitAddon.fit();
    termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    term.onData(data => termWs && termWs.readyState === 1 && termWs.send(JSON.stringify({ type: 'data', data })));
  };
  termWs.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'data') term.write(msg.data);
      else if (msg.type === 'error') term.writeln('\\x1b[31m' + msg.message + '\\x1b[0m');
    } catch { term.write(e.data); }
  };
  termWs.onclose = () => {
    document.getElementById('term-status').textContent = '— disconnected';
    if (term) term.writeln('\\r\\n\\x1b[33m[disconnected]\\x1b[0m');
    termWs = null;
  };
  termWs.onerror = () => {
    document.getElementById('term-status').textContent = '— error';
    if (term) term.writeln('\\x1b[31m[websocket error]\\x1b[0m');
  };
  // Re-send resize when terminal resizes
  term.onResize(({ cols, rows }) => {
    if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
}

function disconnectTerminal() {
  if (termWs) { termWs.close(); termWs = null; }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function renderSessions(devices) {
  const el = document.getElementById('sessions');
  if (!devices || !devices.length) { el.innerHTML = '<div class="dim">No browsers connected</div>'; return; }
  let totalTabs = 0;
  el.innerHTML = devices.map(d => {
    totalTabs += d.tabs || 0;
    const p = d.player, u = d.user, r = d.radio;
    const artHtml = p?.track?.albumArt ? '<img class="album-art" src="'+esc(p.track.albumArt)+'" onerror="this.style.display=\\'none\\'">' : '<div class="album-art"></div>';
    const trackHtml = p?.track ? \`<div class="track-row">\${artHtml}<div class="track-info"><div class="track-name">\${esc(p.track.name)}</div><div class="track-meta">\${esc(p.track.artists)} · \${esc(p.track.album)}</div>\${p.track.durationMs?'<div class="progress-bar"><div class="progress-fill" style="width:'+Math.min(100,(p.track.progressMs||0)/p.track.durationMs*100).toFixed(1)+'%"></div></div>':''}<div style="color:#8b93a3;font-size:.72rem;margin-top:3px">\${fmtDur(p.track.progressMs)} / \${fmtDur(p.track.durationMs)}</div></div></div>\` : '';
    const devHtml = p?.device ? \`<div class="device-info"><span class="pill \${p.device.isActive?'pill-green':'pill-gray'}">\${esc(p.device.type||'Device')}</span><span style="font-size:.8rem">\${esc(p.device.name)}</span><span class="device-vol"><div class="vol-bar"><div class="vol-fill" style="width:\${p.device.volume??0}%"></div></div>\${p.device.volume??0}%</span>\${p.shuffleState?'<span class="pill pill-blue">Shuffle</span>':''}\${p.repeatState&&p.repeatState!=='off'?'<span class="pill pill-yellow">Repeat '+p.repeatState+'</span>':''}</div>\` : '';
    const radioHtml = r ? \`<div style="margin-top:8px"><span class="pill pill-yellow">&#127925; Radio</span> <span style="font-size:.82rem">\${esc(r.name)}</span></div>\` : '';
    return \`<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><div class="row"><span class="dot \${d.authenticated?'on':'off'}"></span><span class="card-label" title="\${esc(d.deviceId)}">\${u?.displayName?esc(u.displayName):esc(d.deviceId.slice(0,8))+'...'}</span>\${u?.product==='premium'?'<span class="pill pill-green" style="margin-left:6px">Premium</span>':''}</div>\${u?.email?'<div class="card-sub" style="margin-left:15px">'+esc(u.email)+'</div>':''}</div><div style="text-align:right;flex-shrink:0"><span class="pill pill-blue">\${d.tabs} tab\${d.tabs!==1?'s':''}</span>\${p?.isPlaying?'<span class="pill pill-green">&#9654; Playing</span>':(p?'<span class="pill pill-gray">Paused</span>':'')}</div></div><div class="ip-list" style="margin-top:4px">\${(d.ips||[]).map(ip=>'&#8594; '+esc(ip)).join('  ')}</div>\${trackHtml}\${devHtml}\${radioHtml}</div>\`;
  }).join('');
  document.getElementById('tab-count').textContent = totalTabs;
  document.getElementById('session-count').textContent = devices.length;
}

function renderStreamListeners(listeners) {
  const el = document.getElementById('cast-listeners');
  document.getElementById('listener-count').textContent = listeners.length;
  if (!listeners.length) { el.innerHTML = '<div class="dim">Nobody is listening</div>'; return; }
  el.innerHTML = listeners.map(l => \`<div class="card flex"><div><div class="card-label ip-list">\${esc(l.ip||'unknown')}</div><div class="card-sub">\${esc((l.ua||'').slice(0,80))||'unknown browser'}</div></div><span class="pill pill-green">\${fmtUptime(Math.floor((l.durationMs||0)/1000))}</span></div>\`).join('');
}

function renderOffline(devices) {
  const el = document.getElementById('offline-devices');
  if (!devices.length) { el.innerHTML = '<div class="dim">None</div>'; return; }
  el.innerHTML = devices.map(d => \`<div class="card flex"><div class="row"><span class="dot \${d.authenticated?'warn':'off'}"></span><span class="ip-list">\${esc(d.deviceId.slice(0,12))}...</span>\${d.authenticated?'<span class="pill pill-yellow" style="margin-left:8px">Has token</span>':'<span class="pill pill-gray" style="margin-left:8px">No token</span>'}</div><span class="pill pill-gray">Offline</span></div>\`).join('');
}

function renderSystem(sys) {
  if (!sys) return;
  const el = document.getElementById('sys-grid');
  const memPct = sys.memPct || 0, load = (sys.loadAvg || [0])[0];
  const loadPct = Math.min(100, (load / (sys.cpuCount || 1)) * 100);
  el.innerHTML = \`
    <div class="sys-stat"><div class="sys-val">\${fmtUptime(sys.uptime||0)}</div><div class="sys-label">System uptime</div></div>
    <div class="sys-stat"><div class="sys-val">\${memPct}%</div><div class="sys-label">RAM · \${fmtBytes(sys.totalMem-sys.freeMem)} / \${fmtBytes(sys.totalMem)}</div><div class="bar"><div class="bar-fill \${barColor(memPct)}" style="width:\${memPct}%"></div></div></div>
    <div class="sys-stat"><div class="sys-val">\${load.toFixed(2)}</div><div class="sys-label">Load avg (1m) · \${sys.cpuCount} CPU(s)</div><div class="bar"><div class="bar-fill \${barColor(loadPct)}" style="width:\${Math.min(100,loadPct).toFixed(1)}%"></div></div></div>
    <div class="sys-stat"><div class="sys-val" style="font-size:1rem">\${esc(sys.hostname||'')}</div><div class="sys-label">\${esc((sys.cpuModel||'').split('@')[0].trim())}</div></div>\`;
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

async function logout() {
  await fetch(P + '/api/logout', { method: 'POST' });
  location.reload();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refresh();
refreshAdmin();
refreshVolume();
loadLogs();
setInterval(refresh, 3000);
setInterval(refreshAdmin, 4000);
setInterval(refreshVolume, 10000);
</script>
</body>
</html>`; }

// ─── Terminal WebSocket handler ────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

function handleTerminalWs(ws) {
  if (!pty) {
    ws.send(JSON.stringify({ type: 'error', message: 'node-pty not installed. Run: npm install node-pty in the project directory, then restart.' }));
    ws.close();
    return;
  }
  const shell = process.env.SHELL || '/bin/bash';
  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color', cols: 80, rows: 24,
      cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: 'PTY spawn failed: ' + e.message }));
    ws.close();
    return;
  }
  proc.onData(data => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data }));
  });
  proc.onExit(() => {
    if (ws.readyState < 2) ws.close();
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'data') proc.write(msg.data);
      else if (msg.type === 'resize') proc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
    } catch {}
  });
  ws.on('close', () => { try { proc.kill(); } catch {} });
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/terminal' && isAuthed(req)) {
    wss.handleUpgrade(req, socket, head, ws => handleTerminalWs(ws));
  } else {
    socket.destroy();
  }
}

// ─── HTTP request handler ──────────────────────────────────────────────────────
async function handleRequest(req, res) {
  securityHeaders(res);
  const base = req.socket.localAddress === '127.0.0.1'
    ? (req.headers['x-panel-base'] || '')
    : '';
  const cookiePath = base || '/';
  const url = new URL(req.url, 'https://localhost');
  const ip = req.socket.remoteAddress || 'unknown';

  // ── Auth ──
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      sendJson(res, 429, { error: `Too many attempts — try again in ${Math.ceil(limit.retryAfterMs / 1000)}s` });
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let keyContent = '';
      try { keyContent = JSON.parse(body).keyContent || ''; } catch {}
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

  if (!url.pathname.startsWith('/api/') || !isAuthed(req)) {
    if (url.pathname.startsWith('/api/') && !isAuthed(req)) {
      sendJson(res, 401, { error: 'Not authenticated' });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
    return;
  }

  // ── Authenticated API ──

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const status = await getStatus();
    if (!status) { sendJson(res, 502, { error: 'status check failed' }); return; }
    sendJson(res, 200, status);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin') {
    const [overview, installStatus] = await Promise.all([fetchServerJson('/api/admin/overview'), getStatus()]);
    sendJson(res, 200, { overview, installStatus });
    return;
  }

  const startStopMatch = url.pathname.match(/^\/api\/(start|stop)\/([a-z]+)$/);
  if (req.method === 'POST' && startStopMatch) {
    const [, action, component] = startStopMatch;
    if (!COMPONENTS.has(component)) { sendJson(res, 400, { error: 'unknown component' }); return; }
    const result = await runInstall(action, component);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/restart-server') {
    try {
      const pidFile = path.join(__dirname, '.run', 'launcher.pid');
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      process.kill(pid, 'SIGUSR1');
      sendJson(res, 200, { ok: true, message: 'Restart signal sent to launcher PID ' + pid });
    } catch (e) {
      sendJson(res, 500, { error: 'Failed: ' + e.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/volume') {
    const [volume, muted] = await Promise.all([getVolume(), getMute()]);
    sendJson(res, 200, { volume, muted });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/volume') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let level = 50;
      try { level = Math.min(150, Math.max(0, parseInt(JSON.parse(body).level, 10))); } catch {}
      exec(`pactl set-sink-volume @DEFAULT_SINK@ ${level}%`, err => {
        sendJson(res, err ? 500 : 200, { ok: !err, volume: level });
      });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/volume/mute') {
    exec('pactl set-sink-mute @DEFAULT_SINK@ toggle', err => {
      if (err) { sendJson(res, 500, { error: err.message }); return; }
      getMute().then(muted => sendJson(res, 200, { ok: true, muted }));
    });
    return;
  }

  const launchMatch = url.pathname.match(/^\/api\/launch\/([a-z-]+)$/);
  if (req.method === 'POST' && launchMatch) {
    const app = launchMatch[1];
    const displayEnv = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
    const cmds = {
      spotify:      ['spotify'],
      browser:      ['xdg-open', ['https://codecade.co.za']],
      files:        ['xdg-open', [os.homedir()]],
      'music-player': ['xdg-open', ['music:']],
    };
    const cmd = cmds[app];
    if (!cmd) { sendJson(res, 400, { error: 'unknown app: ' + app }); return; }
    try {
      const [bin, args = []] = cmd;
      const proc = spawn(bin, args, { detached: true, stdio: 'ignore', env: displayEnv });
      proc.unref();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  const powerMatch = url.pathname.match(/^\/api\/power\/(lock|sleep|reboot|shutdown)$/);
  if (req.method === 'POST' && powerMatch) {
    const action = powerMatch[1];
    const powerCmds = {
      lock:     'loginctl lock-session',
      sleep:    'systemctl suspend',
      reboot:   'systemctl reboot',
      shutdown: 'systemctl poweroff',
    };
    exec(powerCmds[action], err => {
      sendJson(res, err ? 500 : 200, { ok: !err, error: err?.message });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const source = (url.searchParams.get('source') || 'server').replace(/[^a-z]/g, '');
    const lines  = Math.min(500, Math.max(10, parseInt(url.searchParams.get('lines') || '80', 10)));
    const logFiles = {
      server: path.join(LOGS_DIR, 'server.log'),
      panel:  path.join(LOGS_DIR, 'panel.log'),
      ffmpeg: '/tmp/speaker-ffmpeg.log',
    };
    const file = logFiles[source] || logFiles.server;
    exec(`tail -n ${lines} "${file}" 2>&1`, (err, stdout) => {
      sendJson(res, 200, { content: stdout || '(empty or not found)', source });
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// ─── Servers ───────────────────────────────────────────────────────────────────
const tls = loadOrCreateCert();

const server = https.createServer(tls, handleRequest);
server.on('upgrade', handleUpgrade);
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} already in use`);
  else console.error('Server error:', err);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Control panel listening on https://0.0.0.0:${PORT}`);
});

const internalServer = http.createServer(handleRequest);
internalServer.on('upgrade', handleUpgrade);
internalServer.listen(PORT + 1, '127.0.0.1', () => {
  console.log(`Control panel internal proxy listener on http://127.0.0.1:${PORT + 1}`);
});
