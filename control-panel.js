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
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--sur:#161b22;--sur2:#21262d;--bor:#30363d;--tx:#e6edf3;--sec:#8b949e;--acc:#58a6ff;--grn:#3fb950;--red:#f85149;--ylw:#d29922;color-scheme:dark}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--tx);height:100dvh;display:flex;flex-direction:column;overflow:hidden;font-size:14px}
.hdr{display:flex;align-items:center;gap:12px;padding:0 16px;height:52px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0}
.hdr-logo{font-weight:700;font-size:15px;letter-spacing:-.01em}
.hdr-sys{flex:1;font-size:11px;color:var(--sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 12px}
.hdr-acts{display:flex;gap:6px}
.hdr-btn{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:7px;padding:5px 12px;cursor:pointer;font-size:13px;transition:color .15s,border-color .15s}
.hdr-btn:hover{color:var(--tx);border-color:var(--sec)}
.tabbar{display:flex;gap:0;padding:0 10px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0}
.tab{background:none;border:none;border-bottom:2px solid transparent;padding:10px 16px;cursor:pointer;color:var(--sec);font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;transition:color .12s;white-space:nowrap;margin-bottom:-1px}
.tab:hover{color:var(--tx)}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.tbadge{background:var(--red);color:#fff;border-radius:10px;font-size:10px;padding:1px 5px;min-width:16px;text-align:center;font-weight:700}
.pane{display:none;flex:1;overflow:hidden;flex-direction:column}
.pane.on{display:flex}
.split{display:flex;flex:1;overflow:hidden}
.split-l{width:260px;flex-shrink:0;border-right:1px solid var(--bor);display:flex;flex-direction:column;background:var(--sur);overflow:hidden}
.split-r{flex:1;display:flex;flex-direction:column;overflow:hidden}
.split-hdr{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sec);padding:12px 14px 6px;flex-shrink:0}
.r-scroll{flex:1;overflow-y:auto}
.r-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;transition:background .1s;border-left:3px solid transparent}
.r-item:hover{background:var(--sur2)}
.r-item.on{background:rgba(88,166,255,.07);border-left-color:var(--acc)}
.r-av{width:36px;height:36px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--sec);flex-shrink:0;overflow:hidden}
.r-av img{width:100%;height:100%;object-fit:cover}
.r-av span{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
.r-inf{flex:1;min-width:0}
.r-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-prev{font-size:11px;color:var(--sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.r-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0}
.r-time{font-size:10px;color:var(--sec)}
.r-badge{background:var(--acc);color:#000;border-radius:10px;font-size:10px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center}
.m-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--bor);background:var(--sur);flex-shrink:0;min-height:46px}
.m-hdr-name{font-size:14px;font-weight:600}
.m-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.m-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--sec);gap:10px;padding:32px 0}
.m-empty-ico{font-size:36px}
.m-row{display:flex;gap:8px;align-items:flex-start}
.m-avbtn{background:none;border:none;cursor:pointer;padding:0;flex-shrink:0}
.m-avbtn .r-av{width:28px;height:28px;font-size:10px}
.m-bi{flex:1}
.m-sender{background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:var(--acc);padding:0;margin-bottom:3px;display:block;text-align:left}
.bubble{background:var(--sur2);border-radius:0 8px 8px 8px;padding:7px 12px;font-size:13px;line-height:1.5;word-break:break-word;display:inline-block;max-width:520px}
.m-time{font-size:10px;color:var(--sec);margin-left:8px;opacity:.7}
.date-row{text-align:center;margin:4px 0}
.date-chip{display:inline-block;background:var(--sur2);border:1px solid var(--bor);border-radius:12px;padding:2px 10px;font-size:10px;color:var(--sec)}
.dev-list-inner{padding:8px;overflow-y:auto;flex:1}
.dev-card{display:flex;align-items:center;gap:12px;background:var(--sur2);border:1px solid var(--bor);border-radius:9px;padding:11px 13px;margin-bottom:8px;cursor:pointer;transition:border-color .12s}
.dev-card:hover{border-color:var(--sec)}
.dev-card.on{border-color:var(--acc);background:rgba(88,166,255,.05)}
.dev-av{width:38px;height:38px;border-radius:50%;background:var(--bor);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--sec);position:relative;flex-shrink:0}
.dev-dot{width:8px;height:8px;border-radius:50%;background:var(--grn);border:2px solid var(--sur2);position:absolute;bottom:1px;right:1px}
.dev-inf{flex:1;min-width:0}
.dev-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dev-sub{font-size:11px;color:var(--sec);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pills{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
.pill{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600}
.pg{background:rgba(63,185,80,.12);color:#3fb950}
.pb{background:rgba(88,166,255,.12);color:#58a6ff}
.pn{background:rgba(248,81,73,.12);color:#f85149}
.det-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.det-empty{display:flex;align-items:center;justify-content:center;flex:1;color:var(--sec);font-size:13px}
.det-card{background:var(--sur);border:1px solid var(--bor);border-radius:9px;padding:13px 15px}
.det-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sec);margin-bottom:9px}
.det-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px;gap:10px;border-bottom:1px solid var(--bor)}
.det-row:last-child{border-bottom:none}
.det-k{color:var(--sec);flex-shrink:0}
.det-v{text-align:right;word-break:break-all}
.alb-row{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.alb-img{width:52px;height:52px;border-radius:6px;object-fit:cover;background:var(--sur2);flex-shrink:0}
.t-name{font-size:14px;font-weight:600}
.t-sub{font-size:12px;color:var(--sec);margin-top:2px}
.prog{height:3px;background:var(--sur2);border-radius:2px;margin:8px 0}
.prog-f{height:100%;background:var(--acc);border-radius:2px}
.term-wrap{flex:1;display:flex;flex-direction:column;background:#000;overflow:hidden}
.term-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0}
.tdot{width:8px;height:8px;border-radius:50%;background:var(--bor);transition:background .2s}
.tdot.on{background:var(--grn)}
.tstat{font-size:12px;color:var(--sec)}
#terminal-wrap{flex:1;overflow:hidden}
#terminal{height:100%}
.accs-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:20px}
.accs-sec{display:flex;flex-direction:column;gap:8px}
.accs-sec-hdr{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sec);padding-bottom:8px;border-bottom:1px solid var(--bor)}
.acc-item{display:flex;align-items:center;gap:12px;background:var(--sur);border:1px solid var(--bor);border-radius:8px;padding:10px 14px}
.acc-av{width:34px;height:34px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--sec);overflow:hidden;flex-shrink:0}
.acc-av img{width:100%;height:100%;object-fit:cover}
.acc-name{font-size:13px;font-weight:600}
.acc-key{font-size:11px;color:var(--sec);margin-top:1px}
.abtn{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap;transition:color .12s,border-color .12s}
.abtn:hover{color:var(--tx);border-color:var(--sec)}
.abtn.danger{border-color:rgba(248,81,73,.3);color:#f85149}
.abtn.danger:hover{background:rgba(248,81,73,.08);border-color:#f85149}
.sm-btn{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
.sm-btn:hover{color:var(--tx)}
.sm-btn.danger{border-color:rgba(248,81,73,.3);color:#f85149}
.pm-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100;align-items:center;justify-content:center}
.pm-ov.vis{display:flex}
.pm-box{background:var(--sur);border:1px solid var(--bor);border-radius:12px;padding:24px;width:360px;max-width:94vw}
.pm-box h3{font-size:15px;font-weight:700;margin-bottom:16px}
.pm-av-wrap{display:flex;justify-content:center;margin-bottom:16px}
.pm-av{width:60px;height:60px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--sec);overflow:hidden}
.pm-av img{width:100%;height:100%;object-fit:cover}
.pm-field{margin-bottom:11px}
.pm-field label{display:block;font-size:10px;color:var(--sec);margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.pm-inp{width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:6px;padding:8px 10px;color:var(--tx);font-size:13px}
.pm-inp:focus{outline:none;border-color:var(--acc)}
.pm-msg{min-height:16px;font-size:12px;margin-bottom:10px}
.pm-acts{display:flex;gap:8px}
.pm-save{flex:1;background:var(--acc);color:#000;border:none;border-radius:7px;padding:9px;cursor:pointer;font-weight:700;font-size:13px}
.pm-cancel{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:7px;padding:9px 16px;cursor:pointer;font-size:13px}
.m-compose{padding:10px 14px;border-top:1px solid var(--bor);background:var(--sur);flex-shrink:0;display:flex;gap:8px;align-items:flex-end}
.m-inp{flex:1;background:var(--sur2);border:1px solid var(--bor);border-radius:8px;padding:8px 10px;color:var(--tx);font-size:13px;font-family:inherit;resize:none;outline:none;line-height:1.4;min-height:36px}
.m-inp:focus{border-color:#a06800}
.m-send{background:#7a4800;border:none;border-radius:8px;padding:8px 14px;color:#f8c060;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0;white-space:nowrap;transition:background .12s}
.m-send:hover{background:#9a5a00}
.ann-bubble{background:rgba(210,153,34,.08);border-left:3px solid #d29922;border-radius:0 8px 8px 8px;padding:7px 12px;font-size:13px;line-height:1.5;word-break:break-word;display:inline-block;max-width:520px;color:#e8c060}
.ann-sender{color:#d29922}
</style>
</head>
<body>

<div class="pm-ov" id="pm-overlay">
  <div class="pm-box">
    <h3>&#9998; Edit Profile</h3>
    <div class="pm-av-wrap"><div class="pm-av" id="pm-av">?</div></div>
    <div class="pm-field"><label>Display Name</label><input class="pm-inp" id="pm-name" placeholder="Name..."></div>
    <div class="pm-field"><label>Avatar URL</label><input class="pm-inp" id="pm-avatar-url" placeholder="https://..." oninput="pmPreview()"></div>
    <div class="pm-msg" id="pm-msg"></div>
    <div class="pm-acts">
      <button class="pm-save" id="pm-save" onclick="pmSave()">Save Changes</button>
      <button class="pm-cancel" onclick="pmClose()">Cancel</button>
    </div>
  </div>
</div>

<header class="hdr">
  <div class="hdr-logo">&#9654; TemuTalk</div>
  <div class="hdr-sys" id="hdr-sys"></div>
  <div class="hdr-acts">
    <button class="hdr-btn" id="restart-btn" onclick="doRestart()">&#8635; Restart</button>
    <button class="hdr-btn" onclick="logout()">Sign out</button>
  </div>
</header>

<nav class="tabbar">
  <button class="tab on" data-tab="chat" onclick="switchTab(this.dataset.tab)">&#128172; Chat</button>
  <button class="tab" data-tab="devices" onclick="switchTab(this.dataset.tab)">&#128241; Devices <span class="tbadge" id="dev-badge" style="display:none">0</span></button>
  <button class="tab" data-tab="terminal" onclick="switchTab(this.dataset.tab)">&gt;_ Terminal</button>
  <button class="tab" data-tab="accounts" onclick="switchTab(this.dataset.tab)">&#9881; Accounts</button>
</nav>

<div class="pane on" id="pane-chat">
  <div class="split">
    <div class="split-l">
      <div class="split-hdr">Rooms</div>
      <div class="r-scroll" id="rooms-col"></div>
    </div>
    <div class="split-r">
      <div class="m-hdr">
        <div class="m-hdr-name" id="m-hdr-name">Select a conversation</div>
        <button class="sm-btn danger" id="clear-btn" onclick="clearRoom()" style="display:none">&#128465; Clear</button>
      </div>
      <div class="m-body" id="msgs-wrap">
        <div class="m-empty"><div class="m-empty-ico">&#128172;</div><div>Select a conversation</div></div>
      </div>
      <div class="m-compose" id="m-compose" style="display:none">
        <textarea class="m-inp" id="m-inp" placeholder="Type announcement… (Ctrl+Enter to send)" rows="2"
          onkeydown="if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();broadcastMsg();}"></textarea>
        <button class="m-send" onclick="broadcastMsg()">&#128226; Broadcast</button>
      </div>
    </div>
  </div>
</div>

<div class="pane" id="pane-devices">
  <div class="split">
    <div class="split-l" style="width:280px">
      <div class="split-hdr">Devices</div>
      <div class="dev-list-inner" id="dev-list"></div>
    </div>
    <div class="split-r">
      <div class="det-body" id="det-body">
        <div class="det-empty">Select a device</div>
      </div>
    </div>
  </div>
</div>

<div class="pane" id="pane-terminal">
  <div class="term-wrap">
    <div class="term-bar">
      <div class="tdot" id="term-dot"></div>
      <div class="tstat" id="term-status">Connecting...</div>
    </div>
    <div id="terminal-wrap"><div id="terminal"></div></div>
  </div>
</div>

<div class="pane" id="pane-accounts">
  <div class="accs-body">
    <div class="accs-sec">
      <div class="accs-sec-hdr">Connected Spotify Users</div>
      <div id="accs-list"></div>
    </div>
    <div class="accs-sec">
      <div class="accs-sec-hdr">Groups</div>
      <div id="groups-list"></div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
const P='${base}';
const MAIN_PORT=${SERVER_PORT};

window.onerror=function(msg,src,line){console.error('Panel JS error line '+line+': '+msg);};

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ini(s){return (String(s||'?')[0]||'?').toUpperCase();}
function avErr(el){var s=document.createElement('span');s.textContent=(el.alt||'?')[0].toUpperCase();el.parentNode.replaceChild(s,el);}
function imgHide(el){el.style.display='none';}
function avHtml(name,url){
  if(url) return '<img src="'+esc(url)+'" alt="'+esc(name)+'" onerror="avErr(this)">';
  return '<span>'+ini(name)+'</span>';
}
function fmtDur(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
function fmtUp(s){if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function fmtTime(ts){return new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function fmtDate(ts){
  var d=new Date(ts),n=new Date();
  if(d.toDateString()===n.toDateString()) return 'Today';
  if(d.toDateString()===new Date(n-86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

var curTab='chat',curRoom=null,curDevice=null;
var adminData={connectedDevices:[],offlineDevices:[],system:null};
var spyWs=null;
var spyRooms=new Map();spyRooms.set('global',{name:'Global Chat',type:'global'});
var spyMsgs=new Map();spyMsgs.set('global',[]);
var unread=new Map();
var chatAccounts=[];
var pmKey=null;

function switchTab(name){
  curTab=name;
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t.dataset.tab===name);});
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('on');});
  var p=document.getElementById('pane-'+name);
  if(p) p.classList.add('on');
  if(name==='chat') renderRooms();
  if(name==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
  if(name==='accounts') loadAccounts();
  if(name==='terminal'){initTerm();setTimeout(function(){if(fit)fit.fit();},40);}
}

function renderRooms(){
  var col=document.getElementById('rooms-col');
  if(!col) return;
  var h='';
  spyRooms.forEach(function(r,id){
    var msgs=spyMsgs.get(id)||[];
    var last=msgs[msgs.length-1];
    var badge=unread.get(id)||0;
    var sel=curRoom===id;
    h+='<div class="r-item'+(sel?' on':'')+'" data-room="'+esc(id)+'" onclick="selectRoom(this.dataset.room)">';
    h+='<div class="r-av">'+avHtml(r.name||id,null)+'</div>';
    h+='<div class="r-inf">';
    h+='<div class="r-name">'+esc(r.name||id)+'</div>';
    if(last) h+='<div class="r-prev">'+esc((last.fromName||''))+': '+esc((last.text||'').slice(0,36))+'</div>';
    else h+='<div class="r-prev" style="opacity:.5">No messages</div>';
    h+='</div>';
    h+='<div class="r-meta">';
    if(last) h+='<div class="r-time">'+fmtTime(last.ts)+'</div>';
    if(badge) h+='<div class="r-badge">'+badge+'</div>';
    h+='</div></div>';
  });
  col.innerHTML=h;
}

function selectRoom(id){
  curRoom=id;
  unread.set(id,0);
  renderRooms();
  var r=spyRooms.get(id)||{name:id};
  var hdrName=document.getElementById('m-hdr-name');
  var clearBtn=document.getElementById('clear-btn');
  var compose=document.getElementById('m-compose');
  if(hdrName) hdrName.textContent=r.name||id;
  if(clearBtn) clearBtn.style.display='';
  if(compose&&r.type!=='dm') compose.style.display='';
  renderMsgs();
}

function renderMsgs(){
  var wrap=document.getElementById('msgs-wrap');
  if(!wrap) return;
  if(!curRoom){
    wrap.innerHTML='<div class="m-empty"><div class="m-empty-ico">&#128172;</div><div>Select a conversation</div></div>';
    return;
  }
  var msgs=spyMsgs.get(curRoom)||[];
  if(!msgs.length){
    wrap.innerHTML='<div class="m-empty"><div class="m-empty-ico">&#128172;</div><div>No messages yet</div></div>';
    return;
  }
  var h='',lastDate='';
  msgs.forEach(function(m){
    var d=fmtDate(m.ts);
    if(d!==lastDate){h+='<div class="date-row"><span class="date-chip">'+esc(d)+'</span></div>';lastDate=d;}
    if(m.from==='panel-bot'||m.isPanelMsg){
      h+='<div class="m-row">'
        +'<div class="m-avbtn"><div class="r-av" style="background:rgba(210,153,34,.15);color:#d29922">&#128226;</div></div>'
        +'<div class="m-bi"><span class="m-sender ann-sender" style="cursor:default">Server <span style="font-size:10px;background:rgba(210,153,34,.15);color:#d29922;border-radius:3px;padding:1px 5px;font-weight:700">ADMIN</span></span>'
        +'<span class="ann-bubble">'+esc(m.text||'')+'<span class="m-time">'+fmtTime(m.ts)+'</span></span>'
        +'</div></div>';
      return;
    }
    var av=m.avatarUrl?'<img src="'+esc(m.avatarUrl)+'" alt="'+esc(m.fromName||'')+'" onerror="avErr(this)">':'<span>'+ini(m.fromName)+'</span>';
    var k=esc((m.fromName||'').toLowerCase());
    h+='<div class="m-row">'
      +'<button class="m-avbtn" data-key="'+k+'" onclick="pmOpen(this.dataset.key)"><div class="r-av">'+av+'</div></button>'
      +'<div class="m-bi"><button class="m-sender" data-key="'+k+'" onclick="pmOpen(this.dataset.key)">'+esc(m.fromName||'Unknown')+'</button>'
      +'<span class="bubble">'+esc(m.text||'')+'<span class="m-time">'+fmtTime(m.ts)+'</span></span>'
      +'</div></div>';
  });
  wrap.innerHTML=h;
  wrap.scrollTop=wrap.scrollHeight;
}

function appendMsg(m){
  var wrap=document.getElementById('msgs-wrap');
  if(!wrap) return;
  var empty=wrap.querySelector('.m-empty');
  if(empty) wrap.innerHTML='';
  var row=document.createElement('div');
  row.className='m-row';
  if(m.from==='panel-bot'||m.isPanelMsg){
    row.innerHTML='<div class="m-avbtn"><div class="r-av" style="background:rgba(210,153,34,.15);color:#d29922">&#128226;</div></div>'
      +'<div class="m-bi"><span class="m-sender ann-sender" style="cursor:default">Server <span style="font-size:10px;background:rgba(210,153,34,.15);color:#d29922;border-radius:3px;padding:1px 5px;font-weight:700">ADMIN</span></span>'
      +'<span class="ann-bubble">'+esc(m.text||'')+'<span class="m-time">'+fmtTime(m.ts)+'</span></span>'
      +'</div>';
  } else {
    var av=m.avatarUrl?'<img src="'+esc(m.avatarUrl)+'" alt="'+esc(m.fromName||'')+'" onerror="avErr(this)">':'<span>'+ini(m.fromName)+'</span>';
    var k=esc((m.fromName||'').toLowerCase());
    row.innerHTML='<button class="m-avbtn" data-key="'+k+'" onclick="pmOpen(this.dataset.key)"><div class="r-av">'+av+'</div></button>'
      +'<div class="m-bi"><button class="m-sender" data-key="'+k+'" onclick="pmOpen(this.dataset.key)">'+esc(m.fromName||'Unknown')+'</button>'
      +'<span class="bubble">'+esc(m.text||'')+'<span class="m-time">'+fmtTime(m.ts)+'</span></span>'
      +'</div>';
  }
  wrap.appendChild(row);
  wrap.scrollTop=wrap.scrollHeight;
}

function clearRoom(){
  if(!curRoom||!confirm('Clear all messages in this room?')) return;
  spyMsgs.set(curRoom,[]);
  renderMsgs();
}

async function broadcastMsg(){
  var room=curRoom;
  var inp=document.getElementById('m-inp');
  var text=(inp&&inp.value||'').trim();
  if(!room||!text) return;
  var btn=document.querySelector('.m-send');
  if(btn) btn.disabled=true;
  try{
    var r=await fetch(P+'/api/panel-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:room,text:text})});
    var d=await r.json();
    if(d.ok){if(inp)inp.value='';}
    else{alert(d.error||'Failed to broadcast');}
  }catch(e){alert('Broadcast error: '+e.message);}
  if(btn){btn.disabled=false;}
}

function renderDeviceList(){
  var col=document.getElementById('dev-list');
  if(!col) return;
  var devs=adminData.connectedDevices||[];
  var badge=document.getElementById('dev-badge');
  if(badge){badge.textContent=devs.length;badge.style.display=devs.length?'':'none';}
  if(!devs.length){col.innerHTML='<div style="color:var(--sec);font-size:12px;padding:4px 0">No devices connected</div>';return;}
  var h='';
  devs.forEach(function(d){
    var name=(d.user&&d.user.displayName)||d.deviceId.slice(0,10)+'...';
    var track=d.player&&d.player.track;
    var sub=track?'Playing: '+esc(track.name):'Connected';
    var sel=curDevice===d.deviceId;
    h+='<div class="dev-card'+(sel?' on':'')+'" data-device="'+esc(d.deviceId)+'" onclick="selectDevice(this.dataset.device)">';
    h+='<div class="dev-av"><span>'+ini(name)+'</span><div class="dev-dot"></div></div>';
    h+='<div class="dev-inf"><div class="dev-name">'+esc(name)+'</div>';
    h+='<div class="dev-sub">'+sub+'</div>';
    h+='<div class="pills">';
    if(d.authenticated) h+='<span class="pill pg">Spotify</span>';
    h+='<span class="pill pb">'+(d.tabs||0)+' tab'+(d.tabs!==1?'s':'')+'</span>';
    if(d.player&&d.player.isPlaying) h+='<span class="pill pg">&#9654; Playing</span>';
    h+='</div></div></div>';
  });
  col.innerHTML=h;
}

function selectDevice(id){
  curDevice=id;
  renderDeviceList();
  var all=(adminData.connectedDevices||[]).concat(adminData.offlineDevices||[]);
  var d=null;
  for(var i=0;i<all.length;i++){if(all[i].deviceId===id){d=all[i];break;}}
  var body=document.getElementById('det-body');
  if(!body) return;
  if(!d){body.innerHTML='<div class="det-empty">Device not found</div>';return;}
  var name=(d.user&&d.user.displayName)||d.deviceId.slice(0,10)+'...';
  var p=d.player,t=p&&p.track;
  var h='';
  h+='<div class="det-card"><div class="det-title">Connection</div>';
  h+='<div class="det-row"><span class="det-k">Device ID</span><span class="det-v">'+esc(d.deviceId.slice(0,22))+'...</span></div>';
  h+='<div class="det-row"><span class="det-k">IP</span><span class="det-v">'+esc((d.ips||[]).join(', ')||'Unknown')+'</span></div>';
  h+='<div class="det-row"><span class="det-k">Tabs</span><span class="det-v">'+(d.tabs||0)+'</span></div>';
  h+='<div class="det-row"><span class="det-k">Spotify</span><span class="det-v">'+(d.authenticated?'<span class="pill pg">Linked</span>':'<span class="pill pn">Not linked</span>')+'</span></div></div>';
  if(d.user){
    h+='<div class="det-card"><div class="det-title">Spotify Account</div>';
    h+='<div class="det-row"><span class="det-k">Name</span><span class="det-v">'+esc(d.user.displayName||'Unknown')+'</span></div>';
    h+='<div class="det-row"><span class="det-k">Email</span><span class="det-v">'+esc(d.user.email||'Unknown')+'</span></div>';
    h+='<div class="det-row"><span class="det-k">Plan</span><span class="det-v">'+esc(d.user.product||'Unknown')+'</span></div></div>';
  }
  if(t){
    var pct=t.durationMs?Math.min(100,(t.progressMs||0)/t.durationMs*100).toFixed(1):0;
    h+='<div class="det-card"><div class="det-title">Now Playing</div>';
    h+='<div class="alb-row">';
    h+=t.albumArt?'<img class="alb-img" src="'+esc(t.albumArt)+'" onerror="imgHide(this)">':'<div class="alb-img"></div>';
    h+='<div><div class="t-name">'+esc(t.name)+'</div><div class="t-sub">'+esc(t.artists||'')+'</div><div class="t-sub">'+esc(t.album||'')+'</div></div></div>';
    h+='<div class="prog"><div class="prog-f" style="width:'+pct+'%"></div></div>';
    h+='<div class="det-row"><span class="det-k">State</span><span>'+(p.isPlaying?'<span class="pill pg">&#9654; Playing</span>':'<span class="pill pn">Paused</span>')+'</span></div>';
    h+='<div class="det-row"><span class="det-k">Progress</span><span class="det-v">'+fmtDur(t.progressMs||0)+' / '+fmtDur(t.durationMs||0)+'</span></div>';
    if(p.device) h+='<div class="det-row"><span class="det-k">Output</span><span class="det-v">'+esc(p.device.name)+' ('+esc(p.device.type)+')</span></div>';
    h+='</div>';
  }
  if(d.radio){
    h+='<div class="det-card"><div class="det-title">Radio</div>';
    h+='<div class="det-row"><span class="det-k">Station</span><span class="det-v">'+esc(d.radio.name||'Unknown')+'</span></div></div>';
  }
  body.innerHTML=h;
}

async function refreshAdmin(){
  try{
    var r=await fetch(P+'/api/admin');
    if(r.status===401){location.reload();return;}
    var j=await r.json();
    if(!j.overview) return;
    adminData=j.overview;
    var sys=adminData.system;
    var hdrSys=document.getElementById('hdr-sys');
    if(hdrSys&&sys){
      hdrSys.textContent=sys.hostname+' · up '+fmtUp(sys.uptime)+' · load '+(sys.loadAvg&&sys.loadAvg[0]?sys.loadAvg[0].toFixed(2):'?')+' · RAM '+sys.memPct+'%';
    }
    var badge=document.getElementById('dev-badge');
    var n=(adminData.connectedDevices||[]).length;
    if(badge){badge.textContent=n;badge.style.display=n?'':'none';}
    if(curTab==='chat') renderRooms();
    if(curTab==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
  }catch(e){}
}

async function loadAccounts(){
  try{
    var r=await fetch(P+'/api/chat-accounts');
    if(!r.ok){document.getElementById('accs-list').innerHTML='<div style="color:var(--sec);font-size:13px">Could not load</div>';return;}
    var d=await r.json();
    chatAccounts=d.accounts||[];
    renderAccounts();
    renderGroups(d.groups||[]);
  }catch(e){}
}

function renderAccounts(){
  var el=document.getElementById('accs-list');
  if(!el) return;
  if(!chatAccounts.length){el.innerHTML='<div style="color:var(--sec);font-size:13px">No Spotify users have chatted yet</div>';return;}
  var h='';
  chatAccounts.forEach(function(a){
    h+='<div class="acc-item">';
    h+='<div class="acc-av">'+avHtml(a.name,a.avatarUrl)+'</div>';
    h+='<div style="flex:1;min-width:0"><div class="acc-name">'+esc(a.name)+'</div><div class="acc-key">'+esc(a.key)+'</div></div>';
    h+='<button class="abtn" data-key="'+esc(a.key)+'" onclick="pmOpen(this.dataset.key)">&#9998; Edit</button>';
    h+='</div>';
  });
  el.innerHTML=h;
}

function renderGroups(groups){
  var el=document.getElementById('groups-list');
  if(!el) return;
  if(!groups.length){el.innerHTML='<div style="color:var(--sec);font-size:13px">No groups yet</div>';return;}
  var h='';
  groups.forEach(function(g){
    h+='<div class="acc-item">';
    h+='<div class="acc-av" style="font-size:.8rem">&#128101;</div>';
    h+='<div style="flex:1;min-width:0"><div class="acc-name">'+esc(g.name)+'</div><div class="acc-key">'+g.memberCount+' member'+(g.memberCount!==1?'s':'')+'</div></div>';
    h+='<button class="abtn danger" data-gid="'+esc(g.id)+'" onclick="deleteGroup(this.dataset.gid)">&#128465; Delete</button>';
    h+='</div>';
  });
  el.innerHTML=h;
}

async function deleteGroup(id){
  if(!confirm('Delete this group and all its messages?')) return;
  try{
    var r=await fetch(P+'/api/admin/chat-group/'+encodeURIComponent(id),{method:'DELETE'});
    var d=await r.json();
    if(d.ok) loadAccounts();
    else alert(d.error||'Delete failed');
  }catch(e){alert('Error: '+e.message);}
}

function pmOpen(key){
  pmKey=key;
  var acc=null;
  for(var i=0;i<chatAccounts.length;i++){if(chatAccounts[i].key===key){acc=chatAccounts[i];break;}}
  acc=acc||{name:key,avatarUrl:null};
  document.getElementById('pm-name').value=acc.name||'';
  document.getElementById('pm-avatar-url').value=acc.avatarUrl||'';
  document.getElementById('pm-msg').textContent='';
  pmPreview();
  document.getElementById('pm-overlay').classList.add('vis');
}
function pmClose(){document.getElementById('pm-overlay').classList.remove('vis');pmKey=null;}
function pmPreview(){
  var u=document.getElementById('pm-avatar-url').value;
  var n=document.getElementById('pm-name').value||pmKey||'?';
  document.getElementById('pm-av').innerHTML=avHtml(n,u||null);
}
async function pmSave(){
  if(!pmKey) return pmClose();
  var btn=document.getElementById('pm-save'),msg=document.getElementById('pm-msg');
  btn.disabled=true;msg.style.color='';msg.textContent='Saving...';
  var body={key:pmKey,name:document.getElementById('pm-name').value.trim(),avatarUrl:document.getElementById('pm-avatar-url').value.trim()||null};
  try{
    var r=await fetch(P+'/api/chat-account',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var d=await r.json();
    if(d.ok){
      msg.style.color='#3fb950';msg.textContent='Saved';
      for(var i=0;i<chatAccounts.length;i++){if(chatAccounts[i].key===pmKey){chatAccounts[i].name=d.name;chatAccounts[i].avatarUrl=d.avatarUrl;break;}}
      renderAccounts();
      setTimeout(pmClose,800);
    }else{msg.style.color='#f85149';msg.textContent=d.error||'Failed';}
  }catch(e){msg.style.color='#f85149';msg.textContent='Error: '+e.message;}
  btn.disabled=false;
}

async function doRestart(){
  var btn=document.getElementById('restart-btn');
  btn.textContent='Restarting...';btn.disabled=true;
  try{var r=await fetch(P+'/api/restart-server',{method:'POST'});var d=await r.json();btn.textContent=d.ok?'Done':'Failed';}
  catch(e){btn.textContent='Error';}
  setTimeout(function(){btn.innerHTML='&#8635; Restart';btn.disabled=false;},3000);
}
async function logout(){await fetch(P+'/api/logout',{method:'POST'});location.reload();}

async function spyConnect(){
  if(spyWs&&spyWs.readyState<2) return;
  try{
    var r=await fetch(P+'/api/ghost-token');
    if(!r.ok) return;
    var j=await r.json();
    if(!j.token) return;
    var proto=location.protocol==='https:'?'wss:':'ws:';
    var ghostId='ghost-'+Math.random().toString(36).slice(2);
    var wsHost=P?location.host:location.hostname+':'+MAIN_PORT;
    spyWs=new WebSocket(proto+'//'+wsHost);
    spyWs.onopen=function(){
      spyWs.send(JSON.stringify({type:'join',deviceId:ghostId}));
      spyWs.send(JSON.stringify({type:'chat:ghost-join',token:j.token}));
    };
    spyWs.onmessage=function(e){try{spyMsg(JSON.parse(e.data));}catch(err){}};
    spyWs.onclose=function(){setTimeout(spyConnect,5000);};
    spyWs.onerror=function(){spyWs.close();};
  }catch(e){}
}
function spyMsg(m){
  if(m.type==='chat:ghost-state'){
    spyMsgs.set('global',m.global||[]);
    (m.groups||[]).forEach(function(g){
      spyRooms.set(g.id,{name:g.name,type:'group'});
      spyMsgs.set(g.id,g.messages||[]);
    });
    (m.dms||[]).forEach(function(d){
      spyRooms.set(d.room,{name:'DM',type:'dm'});
      spyMsgs.set(d.room,d.messages||[]);
    });
    if(curTab==='chat') renderRooms();
    if(curRoom) renderMsgs();
    return;
  }
  if(m.type==='chat:msg'){
    if(!spyMsgs.has(m.room)) spyMsgs.set(m.room,[]);
    spyMsgs.get(m.room).push(m);
    if(curRoom===m.room) appendMsg(m);
    else{unread.set(m.room,(unread.get(m.room)||0)+1);if(curTab==='chat') renderRooms();}
    return;
  }
  if(m.type==='chat:group-created'){
    spyRooms.set(m.group.id,{name:m.group.name,type:'group'});
    spyMsgs.set(m.group.id,[]);
    if(curTab==='chat') renderRooms();
    return;
  }
  if(m.type==='chat:group-deleted'){
    spyRooms.delete(m.groupId);spyMsgs.delete(m.groupId);
    if(curRoom===m.groupId){curRoom=null;if(curTab==='chat'){renderRooms();renderMsgs();}}
    return;
  }
  if(m.type==='chat:clear'){
    spyMsgs.set(m.room,[]);
    if(curRoom===m.room) renderMsgs();
    return;
  }
}

var term=null,fit=null,ws=null,termInited=false;
function connect(){
  if(!term){document.getElementById('term-status').textContent='xterm not loaded';return;}
  if(ws&&ws.readyState<2) ws.close();
  var proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(proto+'//'+location.host+P+'/terminal');
  ws.onopen=function(){
    document.getElementById('term-dot').classList.add('on');
    document.getElementById('term-status').textContent='Connected';
    if(fit)fit.fit();
    ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
  };
  ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='data')term.write(msg.data);}catch(err){term.write(e.data);}};
  ws.onclose=function(){document.getElementById('term-dot').classList.remove('on');document.getElementById('term-status').textContent='Disconnected (reconnecting...)';setTimeout(connect,3000);};
  ws.onerror=function(){ws.close();};
  term.onData(function(d){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'data',data:d}));});
  term.onResize(function(s){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'resize',cols:s.cols,rows:s.rows}));});
}
function initTerm(){
  if(termInited) return; termInited=true;
  try{
    term=new Terminal({cursorBlink:true,scrollback:10000,theme:{background:'#0d1117',foreground:'#e6edf3',cursor:'#58a6ff',selectionBackground:'#264f78'},fontFamily:'ui-monospace,Menlo,monospace',fontSize:13,lineHeight:1.2});
    fit=new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    fit.fit();
    var twrap=document.getElementById('terminal-wrap');
    if(twrap) new ResizeObserver(function(){if(fit)fit.fit();}).observe(twrap);
    connect();
  }catch(e){console.error('xterm init:',e);document.getElementById('term-status').textContent='xterm load failed';}
}

renderRooms();
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

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/chat-group/')) {
    const groupId = decodeURIComponent(url.pathname.slice('/api/admin/chat-group/'.length));
    const data = await callServerJson(`/api/admin/chat-group/${encodeURIComponent(groupId)}`, 'DELETE');
    sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/panel-broadcast') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const data = await callServerJson('/api/admin/panel-broadcast', 'POST', parsed);
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
