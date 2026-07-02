'use strict';
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { WebSocketServer } = require('ws');

const PORT        = parseInt(process.env.PANEL_PORT || '9090', 10);
const INSTALL_SH  = process.env.INSTALL_SH || path.join(__dirname, 'install.sh');
const RUN_DIR     = path.join(__dirname, '.run');
const SERVER_PORT = parseInt(process.env.PORT || '3001', 10);

let pty = null;
try { pty = require('node-pty'); } catch {}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const KEY_HASH_FILE    = path.join(RUN_DIR, 'panel-key-hash');
const SESSION_TTL_MS   = 4 * 60 * 60 * 1000; // 4h — refreshed on every authenticated request
const MAX_ATTEMPTS     = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS       = 10 * 60 * 1000;
const SESSION_SECRET   = crypto.randomBytes(32);

fs.mkdirSync(RUN_DIR, { recursive: true });

function timingSafeEqualStr(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) { crypto.timingSafeEqual(A, A); return false; }
  return crypto.timingSafeEqual(A, B);
}
function verifyKeyContent(content) {
  if (!content || content.trim().length < 100) return false;
  const hash = crypto.createHash('sha256').update(content.trim()).digest('hex');
  try { return timingSafeEqualStr(hash, fs.readFileSync(KEY_HASH_FILE, 'utf8').trim()); } catch { return false; }
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

function refreshSession(req, res, cookiePath) {
  if (!isAuthed(req)) return;
  const payload = `s:${Date.now() + SESSION_TTL_MS}`;
  res.setHeader('Set-Cookie', `panel_session=${signSession(payload)}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

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

// ─── Fetch helper ─────────────────────────────────────────────────────────────
const tlsAgent = new https.Agent({ rejectUnauthorized: false });
function callServerJson(urlPath, method = 'GET', body = null) {
  return new Promise(resolve => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method, agent: tlsAgent,
      headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
function fetchServerJson(urlPath) { return callServerJson(urlPath); }

// ─── HTML ──────────────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "connect-src 'self' wss: ws:; font-src https://cdn.jsdelivr.net; " +
    "img-src 'self' data: blob: https://i.scdn.co https://cdn.discordapp.com https://lh3.googleusercontent.com https://avatars.githubusercontent.com"
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function loginPage(base) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Panel — Login</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#181b22;border:1px solid #262b36;border-radius:14px;padding:30px;width:340px}
h1{font-size:1.1rem;margin:0 0 6px}.sub{color:#8b93a3;font-size:.82rem;margin-bottom:22px}
.drop{border:2px dashed #2c3242;border-radius:10px;padding:28px 16px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;margin-bottom:14px}
.drop:hover,.drop.over,.drop.ready{border-color:#3ddc84;background:#0f1e16;border-style:solid}
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
</script></body></html>`;
}

function page(base) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Panel</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<!-- WhatsApp-style panel -->
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#111b21;--sid:#111b21;--panel:#0b141a;
  --hdr:#202c33;--hover:#2a3942;--border:#1d2b30;
  --text:#e9edef;--sec:#8696a0;--accent:#00a884;
  --bin:#202c33;--bout:#005c4b;--search:#2a3942;
  color-scheme:dark;
}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.layout{display:flex;flex:1;overflow:hidden}
.sidebar{width:360px;flex-shrink:0;background:var(--sid);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sid-hdr{background:var(--hdr);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.sid-logo{font-size:.95rem;font-weight:700;color:var(--text)}
.sid-acts{display:flex;gap:4px}
.sid-act{background:none;border:none;color:var(--sec);width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;transition:background .15s;flex-shrink:0}
.sid-act:hover{background:rgba(255,255,255,.09)}
.search-wrap{padding:8px 12px;background:var(--sid);flex-shrink:0;border-bottom:1px solid var(--border)}
.search-inp{width:100%;background:var(--search);border:none;border-radius:8px;padding:7px 12px;color:var(--text);font-size:.85rem;outline:none}
.search-inp::placeholder{color:var(--sec)}
.sid-body{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2a3942 transparent}
.sec-hdr{padding:8px 16px 4px;font-size:.63rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#3a4a54}
.sid-item{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.025);transition:background .1s;position:relative}
.sid-item:hover{background:var(--hover)}
.sid-item.sel{background:var(--hover)}
.sid-item.sel::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);border-radius:0 2px 2px 0}
.sid-av{width:48px;height:48px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.05rem;background:#2a3942;color:#e9edef;overflow:hidden;position:relative}
.sid-av img{width:100%;height:100%;object-fit:cover}
.sid-av .dot{position:absolute;bottom:2px;right:2px;width:11px;height:11px;border-radius:50%;border:2px solid var(--sid);background:#3d4a50}
.sid-av .dot.on{background:var(--accent)}
.sid-info{flex:1;min-width:0}
.sid-name{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sid-prev{font-size:.77rem;color:var(--sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.sid-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.sid-time{font-size:.67rem;color:var(--sec)}
.sid-badge{background:var(--accent);color:#fff;border-radius:10px;min-width:18px;height:18px;font-size:.67rem;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px}
.main{flex:1;display:flex;flex-direction:column;background:var(--panel);overflow:hidden}
.view{display:none;flex:1;flex-direction:column;overflow:hidden}
.view.active{display:flex}
.v-hdr{background:var(--hdr);padding:10px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;border-bottom:1px solid var(--border);min-height:56px}
.v-av{width:40px;height:40px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.95rem;overflow:hidden;flex-shrink:0}
.v-av img{width:100%;height:100%;object-fit:cover}
.v-title{font-weight:600;font-size:.93rem}
.v-sub{font-size:.73rem;color:var(--sec);margin-top:1px}
.v-acts{margin-left:auto;display:flex;gap:7px;align-items:center}
.v-btn{background:none;border:1px solid rgba(255,255,255,.12);color:var(--sec);border-radius:7px;padding:4px 10px;font-size:.73rem;cursor:pointer;transition:background .12s;white-space:nowrap}
.v-btn:hover{background:rgba(255,255,255,.07)}
.v-btn.danger{color:#ff6b6b;border-color:rgba(255,107,107,.3)}
.v-btn.danger:hover{background:rgba(255,107,107,.09)}
.v-btn:disabled{opacity:.4;cursor:default}
.msgs-wrap{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:#2a3942 transparent}
.msgs-inner{margin-top:auto;width:100%;display:flex;flex-direction:column;gap:2px}
.date-div{text-align:center;margin:10px 0 6px}
.date-chip{background:#182229;border-radius:6px;padding:3px 10px;font-size:.7rem;color:var(--sec)}
.msg-row{display:flex;gap:7px;max-width:74%;padding:0 4px}
.msg-row.other{align-self:flex-start}
.msg-row.me{align-self:flex-end;flex-direction:row-reverse}
.msg-av{width:30px;height:30px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0;margin-top:2px;overflow:hidden;cursor:pointer;border:none;padding:0}
.msg-av img{width:100%;height:100%;object-fit:cover}
.msg-body{display:flex;flex-direction:column;gap:1px}
.msg-sender{font-size:.71rem;color:var(--accent);font-weight:600;margin-bottom:1px;cursor:pointer;background:none;border:none;padding:0;text-align:left}
.msg-sender:hover{text-decoration:underline}
.bubble{padding:6px 10px 4px;border-radius:8px;font-size:.84rem;line-height:1.4;word-break:break-word}
.msg-row.other .bubble{background:var(--bin);border-top-left-radius:2px}
.msg-row.me .bubble{background:var(--bout);border-top-right-radius:2px}
.msg-time{font-size:.64rem;color:rgba(233,237,239,.55);float:right;margin-left:8px;margin-top:2px}
.msgs-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--sec);font-size:.83rem;font-style:italic}
.dev-body{flex:1;overflow-y:auto;padding:16px;scrollbar-width:thin;scrollbar-color:#2a3942 transparent}
.dc{background:#182229;border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px}
.dc-title{font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#3a4a54;margin-bottom:10px}
.dc-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-size:.82rem}
.dc-k{color:var(--sec)}.dc-v{font-family:ui-monospace,monospace;font-size:.77rem}
.pill{display:inline-block;border-radius:10px;padding:2px 8px;font-size:.69rem;font-weight:700;margin:1px}
.p-g{background:#0d3329;color:#00a884}.p-b{background:#1a2d4a;color:#6ab0ff}
.p-y{background:#3a2d10;color:#f0c060}.p-n{background:#2a3942;color:var(--sec)}
.album-row{display:flex;gap:10px;align-items:center;margin-top:8px}
.album-art{width:46px;height:46px;border-radius:6px;object-fit:cover;background:#2a3942;flex-shrink:0}
.track-name{font-size:.84rem;font-weight:600}.track-sub{font-size:.72rem;color:var(--sec)}
.prog-bar{background:#2a3942;border-radius:2px;height:2px;margin-top:6px}
.prog-fill{background:var(--accent);height:100%}
.welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;opacity:.4}
.welcome-icon{font-size:3.5rem}.welcome-title{font-size:1rem;font-weight:600}
.welcome-sub{font-size:.8rem;color:var(--sec)}
.cfg-body{flex:1;overflow-y:auto;padding:22px;scrollbar-width:thin;scrollbar-color:#2a3942 transparent}
.cfg-inner{max-width:500px}
.cfg-sec{font-size:.63rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#3a4a54;margin:20px 0 10px}
.cfg-field{margin-bottom:11px}
.cfg-lbl{font-size:.75rem;color:var(--sec);margin-bottom:4px}
.cfg-inp{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 11px;color:var(--text);font-size:.83rem;font-family:ui-monospace,monospace;outline:none}
.cfg-inp:focus{border-color:var(--accent)}
.cfg-inp.is-set{border-color:#0d3329;color:#3ddc84}
.cfg-save{background:var(--accent);border:none;border-radius:9px;padding:10px;color:#fff;font-weight:700;font-size:.88rem;cursor:pointer;width:100%;margin-top:4px;transition:opacity .12s}
.cfg-save:hover:not(:disabled){opacity:.85}.cfg-save:disabled{opacity:.4;cursor:default}
.cfg-msg{font-size:.78rem;text-align:center;min-height:1.3em;margin-top:6px}
.accs-list{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.acc-item{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.04);border-radius:9px;padding:8px 12px}
.acc-av{width:36px;height:36px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.9rem;overflow:hidden;flex-shrink:0}
.acc-av img{width:100%;height:100%;object-fit:cover}
.acc-name{flex:1;font-size:.84rem;font-weight:600}
.acc-key{font-size:.72rem;color:var(--sec);font-family:ui-monospace,monospace}
.acc-edit{background:none;border:1px solid rgba(255,255,255,.12);color:var(--sec);border-radius:6px;padding:3px 9px;font-size:.72rem;cursor:pointer;flex-shrink:0}
.acc-edit:hover{background:rgba(255,255,255,.07)}
#terminal-wrap{flex:1;overflow:hidden;background:#080a0e;padding:4px}
.term-dot{width:7px;height:7px;border-radius:50%;background:#3d4a50;flex-shrink:0}
.term-dot.on{background:var(--accent);box-shadow:0 0 4px var(--accent)}
.pm-overlay{display:none;position:fixed;inset:0;background:rgba(9,9,15,.9);z-index:200;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.pm-overlay.vis{display:flex}
.pm-box{background:#182229;border:1px solid var(--border);border-radius:14px;padding:24px;width:340px;max-width:92vw;display:flex;flex-direction:column;gap:11px}
.pm-box h3{font-size:.93rem;font-weight:700}
.pm-av-wrap{display:flex;justify-content:center}
.pm-av{width:72px;height:72px;border-radius:50%;background:#2a3942;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:700}
.pm-av img{width:100%;height:100%;object-fit:cover}
.pm-field{display:flex;flex-direction:column;gap:4px}
.pm-field label{font-size:.74rem;color:var(--sec)}
.pm-inp{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 11px;color:var(--text);font-size:.84rem;outline:none;width:100%}
.pm-inp:focus{border-color:var(--accent)}
.pm-save{background:var(--accent);border:none;border-radius:9px;padding:9px;color:#fff;font-weight:700;font-size:.85rem;cursor:pointer;width:100%}
.pm-save:disabled{opacity:.4;cursor:default}
.pm-cancel{background:none;border:1px solid rgba(255,255,255,.12);color:var(--sec);border-radius:7px;padding:6px;font-size:.78rem;cursor:pointer;width:100%;text-align:center}
.pm-msg{font-size:.77rem;text-align:center;min-height:1.2em}
</style>
</head>
<body>
<div class="pm-overlay" id="pm-overlay">
  <div class="pm-box">
    <h3>&#9998; Edit Profile</h3>
    <div class="pm-av-wrap"><div class="pm-av" id="pm-av">?</div></div>
    <div class="pm-field"><label>Display Name</label><input class="pm-inp" id="pm-name" placeholder="Name…"></div>
    <div class="pm-field"><label>Avatar URL</label><input class="pm-inp" id="pm-avatar-url" placeholder="https://…" oninput="pmPreview()"></div>
    <div class="pm-msg" id="pm-msg"></div>
    <button class="pm-save" id="pm-save" onclick="pmSave()">Save Changes</button>
    <button class="pm-cancel" onclick="pmClose()">Cancel</button>
  </div>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sid-hdr">
      <div class="sid-logo">&#9654; TemuTalk</div>
      <div class="sid-acts">
        <button class="sid-act" id="restart-btn" title="Restart Server" onclick="doRestart()">&#8635;</button>
        <button class="sid-act" title="Log out" onclick="logout()">&#x2192;</button>
      </div>
    </div>
    <div class="search-wrap">
      <input class="search-inp" id="search-inp" placeholder="Search…" oninput="renderSidebar(this.value)">
    </div>
    <div class="sid-body" id="sid-body"></div>
  </div>
  <div class="main">
    <div class="view active" id="view-welcome">
      <div class="welcome">
        <div class="welcome-icon">&#128172;</div>
        <div class="welcome-title">TemuTalk Panel</div>
        <div class="welcome-sub">Select a conversation or device from the sidebar</div>
      </div>
    </div>
    <div class="view" id="view-room">
      <div class="v-hdr">
        <div class="v-av" id="rh-av">G</div>
        <div><div class="v-title" id="rh-name">Room</div><div class="v-sub" id="rh-sub"></div></div>
        <div class="v-acts">
          <button class="v-btn danger" onclick="clearRoom()">&#128465; Clear</button>
        </div>
      </div>
      <div class="msgs-wrap" id="msgs-wrap">
        <div class="msgs-inner" id="msgs-inner"></div>
      </div>
    </div>
    <div class="view" id="view-device">
      <div class="v-hdr">
        <div class="v-av" id="dh-av">D</div>
        <div><div class="v-title" id="dh-name">Device</div><div class="v-sub" id="dh-sub"></div></div>
      </div>
      <div class="dev-body" id="dev-body"></div>
    </div>
    <div class="view" id="view-terminal">
      <div class="v-hdr">
        <div class="term-dot" id="term-dot"></div>
        <div><div class="v-title">Terminal</div><div class="v-sub" id="term-status">Connecting…</div></div>
      </div>
      <div id="terminal-wrap"><div id="terminal"></div></div>
    </div>
    <div class="view" id="view-config">
      <div class="v-hdr">
        <div><div class="v-title">&#9881; Config &amp; Accounts</div><div class="v-sub">OAuth credentials and chat profiles</div></div>
        <div class="v-acts"><button class="v-btn" onclick="loadConfig();loadAccounts()">&#8635; Reload</button></div>
      </div>
      <div class="cfg-body">
        <div class="cfg-inner">
          <div class="cfg-sec">Discord OAuth</div>
          <div class="cfg-field"><div class="cfg-lbl">Client ID</div><input class="cfg-inp" id="cfg-discord-id" placeholder="paste here…" autocomplete="off"></div>
          <div class="cfg-field"><div class="cfg-lbl">Client Secret</div><input class="cfg-inp" id="cfg-discord-secret" type="password" placeholder="paste here…" autocomplete="off"></div>
          <div class="cfg-sec">Google OAuth</div>
          <div class="cfg-field"><div class="cfg-lbl">Client ID</div><input class="cfg-inp" id="cfg-google-id" placeholder="paste here…" autocomplete="off"></div>
          <div class="cfg-field"><div class="cfg-lbl">Client Secret</div><input class="cfg-inp" id="cfg-google-secret" type="password" placeholder="paste here…" autocomplete="off"></div>
          <div class="cfg-msg" id="cfg-msg"></div>
          <button class="cfg-save" id="cfg-save" onclick="cfgSave()">&#128190; Save &amp; Restart Server</button>
          <div class="cfg-sec">Chat Accounts</div>
          <div class="accs-list" id="accs-list"><div style="color:var(--sec);font-size:.8rem">Loading…</div></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
const P = '${base}';
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtDur(ms){const s=Math.floor(ms/1000),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
function fmtUp(s){if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function initials(s){return (String(s||'?')[0]||'?').toUpperCase();}
function avHtml(name,url){
  if(url) return \`<img src="\${esc(url)}" alt="\${esc(name)}" onerror="this.outerHTML='<span>\${initials(name)}</span>'">\`;
  return \`<span>\${initials(name)}</span>\`;
}
function fmtTime(ts){return new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function fmtDate(ts){
  const d=new Date(ts),n=new Date();
  if(d.toDateString()===n.toDateString()) return 'Today';
  if(d.toDateString()===new Date(n-86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

let curView='welcome', curRoom=null, curDevice=null;
let adminData={connectedDevices:[],offlineDevices:[],system:null};
let spyWs=null;
const spyRooms=new Map([['global',{name:'Global Chat',type:'global',memberCount:0}]]);
const spyMsgs=new Map([['global',[]]]);
const unread=new Map();
let chatAccounts=[];
let pmKey=null;

function selectView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+id).classList.add('active');
  curView=id;
  renderSidebar(document.getElementById('search-inp').value);
  if(id==='terminal') setTimeout(()=>fit.fit(),40);
  if(id==='config'){loadConfig();loadAccounts();}
}
function selectRoom(roomId){
  curRoom=roomId; unread.set(roomId,0);
  selectView('room');
  const r=spyRooms.get(roomId)||{name:roomId};
  document.getElementById('rh-av').innerHTML=avHtml(r.name,null);
  document.getElementById('rh-name').textContent=r.name;
  document.getElementById('rh-sub').textContent=r.memberCount?r.memberCount+' members':'';
  renderMsgs();
}
function selectDevice(deviceId){
  curDevice=deviceId; selectView('device'); renderDevice();
}

function renderSidebar(filter){
  filter=(filter||'').toLowerCase();
  let html='';
  html+='<div class="sec-hdr">Chat</div>';
  for(const [id,r] of spyRooms){
    const label=r.name||id;
    if(filter&&!label.toLowerCase().includes(filter)) continue;
    const msgs=spyMsgs.get(id)||[];
    const last=msgs[msgs.length-1];
    const badge=unread.get(id)||0;
    const sel=curView==='room'&&curRoom===id;
    html+=\`<div class="sid-item\${sel?' sel':''}" onclick="selectRoom('\${esc(id)}')">
      <div class="sid-av">\${avHtml(label,null)}</div>
      <div class="sid-info">
        <div class="sid-name">\${esc(label)}</div>
        <div class="sid-prev">\${last?esc(last.fromName)+': '+esc(last.text.slice(0,40)):'<span style="opacity:.4">No messages</span>'}</div>
      </div>
      <div class="sid-meta">
        \${last?'<div class="sid-time">'+fmtTime(last.ts)+'</div>':''}
        \${badge?'<div class="sid-badge">'+badge+'</div>':''}
      </div>
    </div>\`;
  }
  const devs=adminData.connectedDevices||[];
  if(devs.length){
    html+='<div class="sec-hdr">Devices ('+devs.length+')</div>';
    for(const d of devs){
      const name=d.user?.displayName||d.deviceId.slice(0,10)+'…';
      if(filter&&!name.toLowerCase().includes(filter)) continue;
      const track=d.player?.track;
      const prev=track?'&#9835; '+track.name+' – '+track.artists:'Connected';
      const sel=curView==='device'&&curDevice===d.deviceId;
      html+=\`<div class="sid-item\${sel?' sel':''}" onclick="selectDevice('\${esc(d.deviceId)}')">
        <div class="sid-av">\${avHtml(name,null)}<div class="dot on"></div></div>
        <div class="sid-info">
          <div class="sid-name">\${esc(name)}</div>
          <div class="sid-prev">\${esc(prev)}</div>
        </div>
        <div class="sid-meta">
          \${d.player?.isPlaying?'<span class="pill p-g">&#9654;</span>':''}
          <span class="pill p-b">\${d.tabs}t</span>
        </div>
      </div>\`;
    }
  }
  html+='<div class="sec-hdr">System</div>';
  html+=\`<div class="sid-item\${curView==='terminal'?' sel':''}" onclick="selectView('terminal')">
    <div class="sid-av" style="font-size:.7rem;font-family:monospace">&gt;_</div>
    <div class="sid-info"><div class="sid-name">Terminal</div><div class="sid-prev">Server shell</div></div>
  </div>
  <div class="sid-item\${curView==='config'?' sel':''}" onclick="selectView('config')">
    <div class="sid-av">&#9881;</div>
    <div class="sid-info"><div class="sid-name">Config &amp; Accounts</div><div class="sid-prev">OAuth keys · chat profiles</div></div>
  </div>\`;
  const sys=adminData.system;
  if(sys) html+=\`<div style="padding:8px 16px 12px;font-size:.7rem;color:#3a4a54">\${esc(sys.hostname)} &middot; up \${fmtUp(sys.uptime)} &middot; load \${sys.loadAvg?.[0]?.toFixed(2)||'?'} &middot; RAM \${sys.memPct}%</div>\`;
  document.getElementById('sid-body').innerHTML=html;
}

function renderMsgs(){
  const inner=document.getElementById('msgs-inner');
  const wrap=document.getElementById('msgs-wrap');
  const msgs=spyMsgs.get(curRoom)||[];
  if(!msgs.length){inner.innerHTML='<div class="msgs-empty">No messages yet</div>';return;}
  let html='',lastDate='';
  for(const m of msgs){
    const d=fmtDate(m.ts);
    if(d!==lastDate){html+=\`<div class="date-div"><span class="date-chip">\${esc(d)}</span></div>\`;lastDate=d;}
    const k=(m.fromName||'').toLowerCase();
    const av=m.avatarUrl?'<img src="'+esc(m.avatarUrl)+'" onerror="this.outerHTML=\'<span>'+initials(m.fromName)+'</span>\'">':'<span>'+initials(m.fromName)+'</span>';
    html+=\`<div class="msg-row other">
      <button class="msg-av" onclick="pmOpen('\${esc(k)}')">\${av}</button>
      <div class="msg-body">
        <button class="msg-sender" onclick="pmOpen('\${esc(k)}')">\${esc(m.fromName||'Unknown')}</button>
        <div class="bubble">\${esc(m.text)}<span class="msg-time">\${fmtTime(m.ts)}</span></div>
      </div>
    </div>\`;
  }
  inner.innerHTML=html;
  wrap.scrollTop=wrap.scrollHeight;
}

function appendMsg(m){
  const inner=document.getElementById('msgs-inner');
  const wrap=document.getElementById('msgs-wrap');
  if(!inner) return;
  const empty=inner.querySelector('.msgs-empty');
  if(empty) empty.remove();
  const k=(m.fromName||'').toLowerCase();
  const av=m.avatarUrl?'<img src="'+esc(m.avatarUrl)+'" onerror="this.outerHTML=\'<span>'+initials(m.fromName)+'</span>\'">':'<span>'+initials(m.fromName)+'</span>';
  const row=document.createElement('div');
  row.className='msg-row other';
  row.innerHTML=\`<button class="msg-av" onclick="pmOpen('\${esc(k)}')">\${av}</button>
    <div class="msg-body">
      <button class="msg-sender" onclick="pmOpen('\${esc(k)}')">\${esc(m.fromName||'Unknown')}</button>
      <div class="bubble">\${esc(m.text)}<span class="msg-time">\${fmtTime(m.ts)}</span></div>
    </div>\`;
  inner.appendChild(row);
  wrap.scrollTop=wrap.scrollHeight;
}

function clearRoom(){
  if(!curRoom||!confirm('Clear all messages in this room?')) return;
  spyMsgs.set(curRoom,[]);
  renderMsgs();
}

function renderDevice(){
  const all=[...(adminData.connectedDevices||[]),...(adminData.offlineDevices||[])];
  const d=all.find(x=>x.deviceId===curDevice);
  if(!d){document.getElementById('dev-body').innerHTML='<div style="padding:20px;color:var(--sec)">Device not found</div>';return;}
  const name=d.user?.displayName||d.deviceId.slice(0,10)+'…';
  document.getElementById('dh-av').innerHTML=avHtml(name,null);
  document.getElementById('dh-name').textContent=name;
  document.getElementById('dh-sub').textContent=d.user?.email||(d.tabs?d.tabs+' tab(s)':'Offline');
  const p=d.player,t=p?.track;
  let html=\`<div class="dc"><div class="dc-title">Connection</div>
    <div class="dc-row"><span class="dc-k">Device ID</span><span class="dc-v">\${esc(d.deviceId.slice(0,16))}…</span></div>
    <div class="dc-row"><span class="dc-k">Tabs</span><span class="dc-v">\${d.tabs||0}</span></div>
    <div class="dc-row"><span class="dc-k">IPs</span><span class="dc-v">\${esc((d.ips||[]).join(', ')||'—')}</span></div>
    <div class="dc-row"><span class="dc-k">Spotify</span><span>\${d.authenticated?'<span class="pill p-g">Linked</span>':'<span class="pill p-n">Not linked</span>'}</span></div>
  </div>\`;
  if(d.user) html+=\`<div class="dc"><div class="dc-title">Spotify Account</div>
    <div class="dc-row"><span class="dc-k">Name</span><span class="dc-v">\${esc(d.user.displayName||'—')}</span></div>
    <div class="dc-row"><span class="dc-k">Email</span><span class="dc-v">\${esc(d.user.email||'—')}</span></div>
    <div class="dc-row"><span class="dc-k">Plan</span><span class="dc-v">\${esc(d.user.product||'—')}</span></div>
  </div>\`;
  if(t){
    const pct=t.durationMs?Math.min(100,(t.progressMs||0)/t.durationMs*100).toFixed(1):0;
    html+=\`<div class="dc"><div class="dc-title">Now Playing</div>
      <div class="album-row">
        \${t.albumArt?'<img class="album-art" src="'+esc(t.albumArt)+'" onerror="this.style.display=\'none\'">':'<div class="album-art"></div>'}
        <div><div class="track-name">\${esc(t.name)}</div><div class="track-sub">\${esc(t.artists)}</div><div class="track-sub">\${esc(t.album||'')}</div></div>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:\${pct}%"></div></div>
      <div class="dc-row" style="margin-top:6px">
        <span>\${p.isPlaying?'<span class="pill p-g">&#9654; Playing</span>':'<span class="pill p-n">&#9646;&#9646; Paused</span>'}\${p.repeatState&&p.repeatState!=='off'?'<span class="pill p-b">&#8635;</span>':''}\${p.shuffleState?'<span class="pill p-b">&#8652;</span>':''}</span>
        <span class="dc-v">\${fmtDur(t.progressMs||0)} / \${fmtDur(t.durationMs||0)}</span>
      </div>
      \${p.device?'<div class="dc-row"><span class="dc-k">Output</span><span class="dc-v">'+esc(p.device.name)+' ('+esc(p.device.type)+')</span></div>':''}
    </div>\`;
  }
  if(d.radio) html+=\`<div class="dc"><div class="dc-title">Radio</div><div class="dc-row"><span class="dc-k">Station</span><span class="dc-v">\${esc(d.radio.name||'—')}</span></div></div>\`;
  document.getElementById('dev-body').innerHTML=html;
}

async function refreshAdmin(){
  try{
    const r=await fetch(P+'/api/admin');
    if(r.status===401){location.reload();return;}
    const {overview}=await r.json();
    if(!overview) return;
    adminData=overview;
    renderSidebar(document.getElementById('search-inp').value);
    if(curView==='device') renderDevice();
  }catch{}
}

async function loadConfig(){
  try{
    const r=await fetch(P+'/api/env',{credentials:'include'});
    const d=await r.json();
    const set=(id,val)=>{const el=document.getElementById(id);if(el){el.value=val||'';el.classList.toggle('is-set',!!val);}};
    set('cfg-discord-id',d.DISCORD_CLIENT_ID);
    set('cfg-discord-secret',d.DISCORD_CLIENT_SECRET);
    set('cfg-google-id',d.GOOGLE_CLIENT_ID);
    set('cfg-google-secret',d.GOOGLE_CLIENT_SECRET);
  }catch{}
}
async function cfgSave(){
  const btn=document.getElementById('cfg-save'),msg=document.getElementById('cfg-msg');
  btn.disabled=true;msg.style.color='#8696a0';msg.textContent='Saving…';
  const body={
    DISCORD_CLIENT_ID:document.getElementById('cfg-discord-id').value.trim(),
    DISCORD_CLIENT_SECRET:document.getElementById('cfg-discord-secret').value.trim(),
    GOOGLE_CLIENT_ID:document.getElementById('cfg-google-id').value.trim(),
    GOOGLE_CLIENT_SECRET:document.getElementById('cfg-google-secret').value.trim(),
  };
  try{
    const r=await fetch(P+'/api/env',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.ok){msg.style.color='#00a884';msg.textContent='✓ Saved — server restarting…';}
    else{msg.style.color='#ff6b6b';msg.textContent=d.error||'Save failed';}
  }catch(e){msg.style.color='#ff6b6b';msg.textContent='Error: '+e.message;}
  btn.disabled=false;
}

async function loadAccounts(){
  try{
    const r=await fetch(P+'/api/chat-accounts');
    if(!r.ok) return;
    const d=await r.json();
    chatAccounts=d.accounts||[];
    renderAccounts();
  }catch{}
}
function renderAccounts(){
  const el=document.getElementById('accs-list');
  if(!chatAccounts.length){el.innerHTML='<div style="color:var(--sec);font-size:.8rem">No accounts yet</div>';return;}
  el.innerHTML=chatAccounts.map(a=>\`<div class="acc-item">
    <div class="acc-av">\${avHtml(a.name,a.avatarUrl)}</div>
    <div style="flex:1;min-width:0"><div class="acc-name">\${esc(a.name)}</div><div class="acc-key">\${esc(a.key)}</div></div>
    <button class="acc-edit" onclick="pmOpen('\${esc(a.key)}')">&#9998; Edit</button>
  </div>\`).join('');
}

function pmOpen(key){
  pmKey=key;
  const acc=chatAccounts.find(a=>a.key===key)||{name:key,avatarUrl:null};
  document.getElementById('pm-name').value=acc.name||'';
  document.getElementById('pm-avatar-url').value=acc.avatarUrl||'';
  document.getElementById('pm-msg').textContent='';
  pmPreview(acc.avatarUrl,acc.name);
  document.getElementById('pm-overlay').classList.add('vis');
}
function pmClose(){document.getElementById('pm-overlay').classList.remove('vis');pmKey=null;}
function pmPreview(url,name){
  const u=url!==undefined?url:document.getElementById('pm-avatar-url').value;
  const n=name||document.getElementById('pm-name').value||pmKey||'?';
  document.getElementById('pm-av').innerHTML=avHtml(n,u||null);
}
async function pmSave(){
  if(!pmKey) return pmClose();
  const btn=document.getElementById('pm-save'),msg=document.getElementById('pm-msg');
  btn.disabled=true;msg.style.color='#8696a0';msg.textContent='Saving…';
  const body={key:pmKey,name:document.getElementById('pm-name').value.trim(),avatarUrl:document.getElementById('pm-avatar-url').value.trim()||null};
  try{
    const r=await fetch(P+'/api/chat-account',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.ok){
      msg.style.color='#00a884';msg.textContent='✓ Saved';
      const a=chatAccounts.find(a=>a.key===pmKey);
      if(a){a.name=d.name;a.avatarUrl=d.avatarUrl;}
      renderAccounts();
      setTimeout(pmClose,900);
    }else{msg.style.color='#ff6b6b';msg.textContent=d.error||'Failed';}
  }catch(e){msg.style.color='#ff6b6b';msg.textContent='Error: '+e.message;}
  btn.disabled=false;
}

async function doRestart(){
  const btn=document.getElementById('restart-btn');
  btn.textContent='⌛';btn.disabled=true;
  try{const r=await fetch(P+'/api/restart-server',{method:'POST'});const d=await r.json();btn.textContent=d.ok?'✓':'✗';}
  catch{btn.textContent='✗';}
  setTimeout(()=>{btn.textContent='↻';btn.disabled=false;},3000);
}
async function logout(){await fetch(P+'/api/logout',{method:'POST'});location.reload();}

async function spyConnect(){
  if(spyWs&&spyWs.readyState<2) return;
  try{
    const r=await fetch(P+'/api/ghost-token');
    if(!r.ok) return;
    const {token}=await r.json();
    if(!token) return;
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const ghostId='ghost-'+Math.random().toString(36).slice(2);
    spyWs=new WebSocket(proto+'//'+location.host);
    spyWs.onopen=()=>{
      spyWs.send(JSON.stringify({type:'join',deviceId:ghostId}));
      spyWs.send(JSON.stringify({type:'chat:ghost-join',token}));
    };
    spyWs.onmessage=e=>{try{spyMsg(JSON.parse(e.data));}catch{}};
    spyWs.onclose=()=>setTimeout(spyConnect,5000);
    spyWs.onerror=()=>spyWs.close();
  }catch{}
}
function spyMsg(m){
  if(m.type==='chat:ghost-state'){
    spyMsgs.set('global',m.global||[]);
    for(const g of m.groups||[]){
      spyRooms.set(g.id,{name:g.name,type:'group',memberCount:g.memberCount||g.members?.length||0});
      spyMsgs.set(g.id,g.messages||[]);
    }
    for(const d of m.dms||[]){
      spyRooms.set(d.room,{name:'DM: '+d.room.slice(3,22)+'…',type:'dm',memberCount:2});
      spyMsgs.set(d.room,d.messages||[]);
    }
    renderSidebar(document.getElementById('search-inp').value);
    if(curView==='room'&&curRoom) renderMsgs();
    return;
  }
  if(m.type==='chat:msg'){
    if(!spyMsgs.has(m.room)) spyMsgs.set(m.room,[]);
    spyMsgs.get(m.room).push(m);
    if(curView==='room'&&curRoom===m.room) appendMsg(m);
    else{unread.set(m.room,(unread.get(m.room)||0)+1);renderSidebar(document.getElementById('search-inp').value);}
    return;
  }
  if(m.type==='chat:group-created'){
    spyRooms.set(m.group.id,{name:m.group.name,type:'group',memberCount:1});
    spyMsgs.set(m.group.id,[]);
    renderSidebar(document.getElementById('search-inp').value);
    return;
  }
  if(m.type==='chat:clear'){
    spyMsgs.set(m.room,[]);
    if(curView==='room'&&curRoom===m.room) renderMsgs();
    return;
  }
}

const term=new Terminal({
  cursorBlink:true,scrollback:10000,
  theme:{background:'#080a0e',foreground:'#e9edef',cursor:'#00a884',selectionBackground:'#2a3942'},
  fontFamily:'ui-monospace, Menlo, monospace',fontSize:13,lineHeight:1.2,
});
const fit=new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();
let ws=null;
function connect(){
  if(ws&&ws.readyState<2) ws.close();
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(proto+'//'+location.host+P+'/terminal');
  ws.onopen=()=>{
    document.getElementById('term-dot').classList.add('on');
    document.getElementById('term-status').textContent='Connected';
    fit.fit();ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
  };
  ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='data')term.write(m.data);}catch{term.write(e.data);}};
  ws.onclose=()=>{document.getElementById('term-dot').classList.remove('on');document.getElementById('term-status').textContent='Disconnected (reconnecting…)';setTimeout(connect,3000);};
  ws.onerror=()=>ws.close();
  term.onData(d=>ws&&ws.readyState===1&&ws.send(JSON.stringify({type:'data',data:d})));
  term.onResize(({cols,rows})=>ws&&ws.readyState===1&&ws.send(JSON.stringify({type:'resize',cols,rows})));
}
new ResizeObserver(()=>fit.fit()).observe(document.getElementById('terminal-wrap'));
connect();

refreshAdmin();
setInterval(refreshAdmin,4000);
spyConnect();
</script>
</body>
</html>`;
}

// ─── Terminal WebSocket ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

function handleTerminalWs(ws) {
  if (!pty) {
    ws.send(JSON.stringify({ type: 'data', data: '\r\n\x1b[31mnode-pty not installed — run: npm install node-pty\x1b[0m\r\n' }));
    ws.close();
    return;
  }
  let proc;
  try {
    proc = pty.spawn('bash', [INSTALL_SH], {
      name: 'xterm-256color', cols: 80, rows: 24,
      cwd: path.dirname(INSTALL_SH),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[31mFailed to start install.sh: ${e.message}\x1b[0m\r\n` }));
    ws.close();
    return;
  }
  proc.onData(data => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data })));
  proc.onExit(() => ws.readyState < 2 && ws.close());
  ws.on('message', raw => {
    try { const m = JSON.parse(raw); if (m.type === 'data') proc.write(m.data); else if (m.type === 'resize') proc.resize(Math.max(1, m.cols), Math.max(1, m.rows)); } catch {}
  });
  ws.on('close', () => { try { proc.kill(); } catch {} });
}

function handleUpgrade(req, socket, head) {
  if (new URL(req.url, 'http://x').pathname === '/terminal' && isAuthed(req)) {
    wss.handleUpgrade(req, socket, head, ws => handleTerminalWs(ws));
  } else {
    socket.destroy();
  }
}

// ─── Request handler ──────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  securityHeaders(res);
  const base = req.socket.localAddress === '127.0.0.1' ? (req.headers['x-panel-base'] || '') : '';
  const cookiePath = base || '/';
  const url = new URL(req.url, 'https://localhost');
  const ip  = req.socket.remoteAddress || 'unknown';

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
        res.setHeader('Set-Cookie', `panel_session=${signSession(payload)}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
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
    if (isAuthed(req)) {
      refreshSession(req, res, cookiePath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(base));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(base));
    }
    return;
  }

  if (!isAuthed(req)) { sendJson(res, 401, { error: 'Not authenticated' }); return; }

  // Slide the session window on every authenticated request
  refreshSession(req, res, cookiePath);

  if (req.method === 'GET' && url.pathname === '/api/admin') {
    const overview = await fetchServerJson('/api/admin/overview');
    sendJson(res, 200, { overview });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ghost-token') {
    const data = await fetchServerJson('/api/admin/ghost-token');
    sendJson(res, data ? 200 : 502, data || { error: 'Main server unavailable' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/restart-server') {
    try {
      const pidFile = path.join(RUN_DIR, 'launcher.pid');
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!pid) { sendJson(res, 503, { error: 'Launcher PID not found' }); return; }
      process.kill(pid, 'SIGUSR1');
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  // ── Chat accounts proxy ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/chat-accounts') {
    const data = await callServerJson('/api/admin/chat-accounts');
    sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
    return;
  }
  if (req.method === 'PATCH' && url.pathname === '/api/chat-account') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const data = await callServerJson('/api/admin/chat-account', 'PATCH', parsed);
        sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  // ── .env read ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/env') {
    const envFile = path.join(__dirname, '.env');
    const KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
    const result = {};
    try {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && KEYS.includes(m[1])) result[m[1]] = m[2].trim();
      }
    } catch {}
    sendJson(res, 200, result);
    return;
  }

  // ── .env write ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/env') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
        const envFile = path.join(__dirname, '.env');
        let lines = [];
        try { lines = fs.readFileSync(envFile, 'utf8').split('\n'); } catch {}
        for (const key of KEYS) {
          if (!(key in updates)) continue;
          const val = String(updates[key]);
          const idx = lines.findIndex(l => l.match(new RegExp(`^${key}=`)));
          if (idx >= 0) lines[idx] = `${key}=${val}`;
          else lines.push(`${key}=${val}`);
        }
        fs.writeFileSync(envFile, lines.join('\n'));
        // Restart server to reload .env
        try {
          const pidFile = path.join(RUN_DIR, 'launcher.pid');
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
          if (pid) process.kill(pid, 'SIGUSR1');
        } catch {}
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
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
server.listen(PORT, '0.0.0.0', () => console.log(`Control panel on https://0.0.0.0:${PORT}`));

const internalServer = http.createServer(handleRequest);
internalServer.on('upgrade', handleUpgrade);
internalServer.listen(PORT + 1, '127.0.0.1', () => console.log(`Control panel internal on http://127.0.0.1:${PORT + 1}`));
