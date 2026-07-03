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
const SESSION_TTL_MS   = 4 * 60 * 60 * 1000;
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

// ─── Shared helpers ───────────────────────────────────────────────────────────
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

// ─── Login page ───────────────────────────────────────────────────────────────
function loginPage(base) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TemuTalk Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100dvh}
.box{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px;width:360px}
h1{font-size:17px;font-weight:700;margin-bottom:4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:24px}
.drop{border:2px dashed #30363d;border-radius:12px;padding:32px 16px;text-align:center;cursor:pointer;transition:.15s}
.drop:hover,.drop.over{border-color:#58a6ff;background:rgba(88,166,255,.05)}
.drop.ready{border-color:#3fb950;border-style:solid;background:rgba(63,185,80,.05)}
.drop-icon{font-size:2.2rem;margin-bottom:10px}
.drop-label{font-size:13px;color:#8b949e}
.drop-name{font-size:12px;color:#3fb950;margin-top:8px;font-family:ui-monospace,monospace}
input[type=file]{display:none}
.err{color:#f85149;font-size:13px;min-height:20px;margin:12px 0 4px;text-align:center}
button{width:100%;padding:11px;border:none;border-radius:10px;background:#238636;color:#fff;font:inherit;font-weight:600;font-size:14px;cursor:pointer;margin-top:4px;transition:background .15s}
button:hover:not(:disabled){background:#2ea043}
button:disabled{opacity:.4;cursor:default}
.hint{color:#484f58;font-size:12px;margin-top:14px;text-align:center}
</style></head>
<body><div class="box">
<h1>&#9654; TemuTalk Panel</h1>
<div class="sub">Drop your key file to unlock</div>
<div class="drop" id="drop" onclick="document.getElementById('fi').click()">
  <div class="drop-icon">&#128190;</div>
  <div class="drop-label">Click to browse or drag &amp; drop</div>
  <div class="drop-label" style="font-size:11px;margin-top:4px;opacity:.6">temutalk.key</div>
  <div class="drop-name" id="fname"></div>
</div>
<input type="file" id="fi" accept=".key,*">
<div class="err" id="err"></div>
<button id="btn" disabled onclick="doLogin()">Unlock</button>
<div class="hint">Key file lives on the TemuTalk USB drive</div>
</div>
<script>
const P='${base}';let kc='';
const drop=document.getElementById('drop'),btn=document.getElementById('btn'),err=document.getElementById('err');
function readFile(f){const r=new FileReader();r.onload=e=>{kc=e.target.result;document.getElementById('fname').textContent=f.name;drop.classList.add('ready');btn.disabled=false;err.textContent='';};r.readAsText(f);}
document.getElementById('fi').onchange=e=>{if(e.target.files[0])readFile(e.target.files[0]);};
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])readFile(e.dataTransfer.files[0]);};
async function doLogin(){err.textContent='';btn.disabled=true;
  try{const r=await fetch(P+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyContent:kc})});
  if(r.ok){location.reload();return;}const j=await r.json().catch(()=>({}));err.textContent=j.error||'Login failed';}
  catch(e2){err.textContent='Request failed: '+e2.message;}btn.disabled=false;}
</script></body></html>`;
}

// ─── Main panel page ──────────────────────────────────────────────────────────
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
:root{
  --bg:#0d1117;--sur:#161b22;--sur2:#21262d;--sur3:#2d333b;
  --bor:#30363d;--tx:#e6edf3;--sec:#8b949e;
  --acc:#58a6ff;--grn:#3fb950;--red:#f85149;--ylw:#d29922;--orn:#fb8f44;
  color-scheme:dark
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--tx);height:100dvh;display:flex;flex-direction:column;overflow:hidden;font-size:13px}

/* Header */
.hdr{display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0;gap:8px}
.hdr-logo{font-weight:700;font-size:14px;white-space:nowrap}
.hdr-stats{display:flex;gap:6px;flex:1;overflow:hidden;align-items:center}
.stat-chip{font-size:11px;color:var(--sec);background:var(--sur2);border:1px solid var(--bor);border-radius:6px;padding:3px 8px;white-space:nowrap;display:flex;align-items:center;gap:4px}
.stat-chip .dot{width:6px;height:6px;border-radius:50%}
.dot-grn{background:var(--grn)}
.dot-ylw{background:var(--ylw)}
.dot-red{background:var(--red)}
.hdr-acts{display:flex;gap:6px;flex-shrink:0}
.hdr-btn{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:7px;padding:5px 12px;cursor:pointer;font:inherit;font-size:12px;transition:.12s;white-space:nowrap}
.hdr-btn:hover{color:var(--tx);border-color:var(--sec)}
.hdr-btn.danger:hover{color:var(--red);border-color:var(--red)}

/* Tabs */
.tabbar{display:flex;padding:0 8px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0;gap:2px}
.tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;cursor:pointer;color:var(--sec);font:inherit;font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;transition:.12s;white-space:nowrap;margin-bottom:-1px}
.tab:hover{color:var(--tx)}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.tbadge{background:var(--red);color:#fff;border-radius:10px;font-size:10px;padding:1px 5px;min-width:16px;text-align:center;font-weight:700;line-height:1.4}

/* Panes */
.pane{display:none;flex:1;overflow:hidden;flex-direction:column}
.pane.on{display:flex}

/* Split layout */
.split{display:flex;flex:1;overflow:hidden}
.sidebar{width:240px;flex-shrink:0;border-right:1px solid var(--bor);display:flex;flex-direction:column;background:var(--sur);overflow:hidden}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* Room list */
.search-wrap{padding:8px;border-bottom:1px solid var(--bor);flex-shrink:0}
.search-inp{width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:7px;padding:6px 10px;color:var(--tx);font:inherit;font-size:12px;outline:none}
.search-inp:focus{border-color:var(--acc)}
.rooms-scroll{flex:1;overflow-y:auto}
.rs-hdr{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sec);padding:10px 12px 4px;opacity:.7}
.r-item{display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer;border-left:2px solid transparent;transition:.1s}
.r-item:hover{background:var(--sur2)}
.r-item.on{background:rgba(88,166,255,.07);border-left-color:var(--acc)}
.r-av{width:34px;height:34px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--sec);flex-shrink:0;overflow:hidden;position:relative}
.r-av img{width:100%;height:100%;object-fit:cover}
.r-type-badge{position:absolute;bottom:-1px;right:-1px;font-size:9px;background:var(--sur);border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;line-height:1}
.r-inf{flex:1;min-width:0}
.r-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-prev{font-size:11px;color:var(--sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.r-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0}
.r-time{font-size:10px;color:var(--sec)}
.r-badge{background:var(--acc);color:#000;border-radius:10px;font-size:10px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center}

/* Message area */
.msg-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--bor);background:var(--sur);flex-shrink:0;min-height:44px;gap:8px}
.msg-hdr-left{display:flex;align-items:center;gap:8px}
.msg-hdr-name{font-size:14px;font-weight:600}
.msg-hdr-type{font-size:11px;color:var(--sec);background:var(--sur2);border:1px solid var(--bor);border-radius:5px;padding:2px 7px}
.msg-hdr-acts{display:flex;gap:6px;align-items:center}
.msg-body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.msg-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--sec);gap:10px;padding:32px 0;text-align:center}
.msg-empty-ico{font-size:40px;opacity:.4}
.date-row{text-align:center;margin:4px 0}
.date-chip{display:inline-block;background:var(--sur2);border:1px solid var(--bor);border-radius:12px;padding:2px 10px;font-size:10px;color:var(--sec)}

/* Message bubbles */
.m-row{display:flex;gap:8px;align-items:flex-start}
.m-av-btn{background:none;border:none;cursor:pointer;padding:0;flex-shrink:0}
.m-bubble-col{flex:1}
.m-sender-name{font-size:11px;font-weight:600;color:var(--acc);margin-bottom:3px;background:none;border:none;cursor:pointer;padding:0;text-align:left;display:block}
.m-sender-name.admin-label{color:var(--ylw);cursor:default}
.bubble{background:var(--sur2);border-radius:0 8px 8px 8px;padding:7px 12px;font-size:13px;line-height:1.5;word-break:break-word;display:inline-block;max-width:540px}
.bubble.admin{background:rgba(210,153,34,.1);border-left:3px solid var(--ylw)}
.m-time{font-size:10px;color:var(--sec);margin-left:8px;opacity:.7}

/* Compose */
.compose{padding:8px 12px 10px;border-top:1px solid var(--bor);background:var(--sur);flex-shrink:0}
.compose-sender{display:flex;align-items:center;gap:6px;margin-bottom:7px}
.compose-sender-label{font-size:11px;color:var(--sec)}
.sender-pill{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:20px;padding:3px 11px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;transition:.12s}
.sender-pill:hover{border-color:var(--sec);color:var(--tx)}
.sender-pill.on{background:var(--sur2);border-color:var(--acc);color:var(--acc)}
.compose-row{display:flex;gap:6px;align-items:flex-end}
.compose-inp{flex:1;background:var(--sur2);border:1px solid var(--bor);border-radius:8px;padding:8px 10px;color:var(--tx);font:inherit;font-size:13px;resize:none;outline:none;line-height:1.4;min-height:36px;max-height:100px}
.compose-inp:focus{border-color:var(--acc)}
.compose-send{background:var(--acc);color:#000;border:none;border-radius:8px;padding:8px 16px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;white-space:nowrap;transition:opacity .12s}
.compose-send:hover{opacity:.85}
.compose-send:disabled{opacity:.4;cursor:default}

/* Clear button */
.btn-clear{background:none;border:1px solid rgba(248,81,73,.3);color:var(--red);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;transition:.12s;white-space:nowrap}
.btn-clear:hover{background:rgba(248,81,73,.08);border-color:var(--red)}

/* Devices */
.dev-scroll{flex:1;overflow-y:auto;padding:8px}
.dev-card{display:flex;align-items:center;gap:10px;background:var(--sur2);border:1px solid var(--bor);border-radius:9px;padding:10px 12px;margin-bottom:7px;cursor:pointer;transition:.12s}
.dev-card:hover{border-color:var(--sec)}
.dev-card.on{border-color:var(--acc);background:rgba(88,166,255,.05)}
.dev-av{width:36px;height:36px;border-radius:50%;background:var(--bor);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--sec);position:relative;flex-shrink:0}
.dev-dot{width:8px;height:8px;border-radius:50%;background:var(--grn);border:2px solid var(--sur2);position:absolute;bottom:1px;right:1px}
.dev-inf{flex:1;min-width:0}
.dev-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dev-sub{font-size:11px;color:var(--sec);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pills{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
.pill{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600}
.pg{background:rgba(63,185,80,.12);color:#3fb950}
.pb{background:rgba(88,166,255,.12);color:#58a6ff}
.pn{background:rgba(248,81,73,.12);color:#f85149}
.det-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.det-empty{display:flex;align-items:center;justify-content:center;flex:1;color:var(--sec)}
.det-card{background:var(--sur);border:1px solid var(--bor);border-radius:9px;padding:12px 14px}
.det-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sec);margin-bottom:8px}
.det-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;gap:10px;border-bottom:1px solid var(--bor)}
.det-row:last-child{border-bottom:none}
.det-k{color:var(--sec);flex-shrink:0}
.det-v{text-align:right;word-break:break-all}
.alb-row{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.alb-img{width:48px;height:48px;border-radius:6px;object-fit:cover;background:var(--sur2);flex-shrink:0}
.t-name{font-size:14px;font-weight:600}
.t-sub{font-size:11px;color:var(--sec);margin-top:2px}
.prog{height:3px;background:var(--sur2);border-radius:2px;margin:8px 0}
.prog-f{height:100%;background:var(--acc);border-radius:2px}

/* Terminal */
.term-wrap{flex:1;display:flex;flex-direction:column;background:#000;overflow:hidden}
.term-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--sur);border-bottom:1px solid var(--bor);flex-shrink:0}
.tdot{width:8px;height:8px;border-radius:50%;background:var(--bor);transition:.2s;flex-shrink:0}
.tdot.on{background:var(--grn)}
.tstat{font-size:12px;color:var(--sec)}
#terminal-wrap{flex:1;overflow:hidden}

/* Accounts */
.accs-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:16px}
.accs-sec{display:flex;flex-direction:column;gap:8px}
.accs-sec-hdr{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sec);padding-bottom:8px;border-bottom:1px solid var(--bor)}
.acc-item{display:flex;align-items:center;gap:10px;background:var(--sur);border:1px solid var(--bor);border-radius:8px;padding:10px 12px}
.acc-av{width:32px;height:32px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--sec);overflow:hidden;flex-shrink:0}
.acc-av img{width:100%;height:100%;object-fit:cover}
.acc-name{font-size:13px;font-weight:600}
.acc-key{font-size:11px;color:var(--sec);margin-top:2px}
.abtn{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;transition:.12s}
.abtn:hover{color:var(--tx);border-color:var(--sec)}
.abtn.danger{border-color:rgba(248,81,73,.3);color:var(--red)}
.abtn.danger:hover{background:rgba(248,81,73,.08);border-color:var(--red)}
details summary{cursor:pointer;color:var(--sec);font-size:12px;padding:6px 0;user-select:none;list-style:none}
details summary::before{content:'▶ ';font-size:10px}
details[open] summary::before{content:'▼ '}
details summary:hover{color:var(--tx)}

/* Profile modal */
.pm-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100;align-items:center;justify-content:center}
.pm-ov.vis{display:flex}
.pm-box{background:var(--sur);border:1px solid var(--bor);border-radius:12px;padding:22px;width:360px;max-width:94vw}
.pm-box h3{font-size:15px;font-weight:700;margin-bottom:14px}
.pm-av-wrap{display:flex;justify-content:center;margin-bottom:14px}
.pm-av{width:56px;height:56px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--sec);overflow:hidden}
.pm-av img{width:100%;height:100%;object-fit:cover}
.pm-field{margin-bottom:10px}
.pm-field label{display:block;font-size:10px;color:var(--sec);margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.pm-inp{width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:6px;padding:7px 10px;color:var(--tx);font:inherit;font-size:13px;outline:none}
.pm-inp:focus{border-color:var(--acc)}
.pm-msg{min-height:16px;font-size:12px;margin-bottom:8px}
.pm-acts{display:flex;gap:8px}
.pm-save{flex:1;background:var(--acc);color:#000;border:none;border-radius:7px;padding:9px;cursor:pointer;font:inherit;font-weight:700;font-size:13px}
.pm-cancel{background:none;border:1px solid var(--bor);color:var(--sec);border-radius:7px;padding:9px 16px;cursor:pointer;font:inherit;font-size:13px}
</style>
</head>
<body>

<!-- Profile modal -->
<div class="pm-ov" id="pm-overlay">
  <div class="pm-box">
    <h3>&#9998; Edit Profile</h3>
    <div class="pm-av-wrap"><div class="pm-av" id="pm-av">?</div></div>
    <div class="pm-field"><label>Display Name</label><input class="pm-inp" id="pm-name" placeholder="Name…"></div>
    <div class="pm-field"><label>Avatar URL</label><input class="pm-inp" id="pm-avatar-url" placeholder="https://…" oninput="pmPreview()"></div>
    <div class="pm-msg" id="pm-msg"></div>
    <div class="pm-acts">
      <button class="pm-save" id="pm-save" onclick="pmSave()">Save</button>
      <button class="pm-cancel" onclick="pmClose()">Cancel</button>
    </div>
  </div>
</div>

<!-- Header -->
<header class="hdr">
  <div class="hdr-logo">&#9654; TemuTalk</div>
  <div class="hdr-stats" id="hdr-stats"></div>
  <div class="hdr-acts">
    <button class="hdr-btn" id="restart-btn" onclick="doRestart()">&#8635; Restart</button>
    <button class="hdr-btn danger" onclick="logout()">Sign out</button>
  </div>
</header>

<!-- Tabs -->
<nav class="tabbar">
  <button class="tab on" data-tab="chat"     onclick="switchTab('chat')">&#128172; Chat <span class="tbadge" id="chat-badge" style="display:none">0</span></button>
  <button class="tab"    data-tab="devices"  onclick="switchTab('devices')">&#128241; Devices <span class="tbadge" id="dev-badge" style="display:none">0</span></button>
  <button class="tab"    data-tab="terminal" onclick="switchTab('terminal')">&gt;_ Terminal</button>
  <button class="tab"    data-tab="accounts" onclick="switchTab('accounts')">&#9881; Accounts</button>
</nav>

<!-- Chat pane -->
<div class="pane on" id="pane-chat">
  <div class="split">
    <div class="sidebar">
      <div class="search-wrap">
        <input class="search-inp" id="room-search" placeholder="&#128269; Search rooms…" oninput="renderRooms()">
      </div>
      <div class="rooms-scroll" id="rooms-col"></div>
    </div>
    <div class="main">
      <div class="msg-hdr">
        <div class="msg-hdr-left">
          <div class="msg-hdr-name" id="m-hdr-name">Select a conversation</div>
          <div class="msg-hdr-type" id="m-hdr-type" style="display:none"></div>
        </div>
        <div class="msg-hdr-acts">
          <button class="btn-clear" id="clear-btn" onclick="clearRoom()" style="display:none">&#128465; Clear history</button>
        </div>
      </div>
      <div class="msg-body" id="msgs-wrap">
        <div class="msg-empty"><div class="msg-empty-ico">&#128172;</div><div>Select a conversation from the sidebar</div></div>
      </div>
      <div class="compose" id="m-compose" style="display:none">
        <div class="compose-sender">
          <span class="compose-sender-label">Send as</span>
          <button class="sender-pill on" id="sp-server" onclick="setSender('server')">&#128226; Admin</button>
          <button class="sender-pill"    id="sp-test"   onclick="setSender('testuser')">&#129514; Test User</button>
        </div>
        <div class="compose-row">
          <textarea class="compose-inp" id="m-inp" placeholder="Type a message… (Ctrl+Enter to send)" rows="2"
            onkeydown="if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();panelSend();}"></textarea>
          <button class="compose-send" id="m-send" onclick="panelSend()">Send</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Devices pane -->
<div class="pane" id="pane-devices">
  <div class="split">
    <div class="sidebar" style="width:260px">
      <div class="search-wrap" style="padding:10px 8px 6px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sec)">Connected Devices</div>
      </div>
      <div class="dev-scroll" id="dev-list"></div>
    </div>
    <div class="main">
      <div class="det-body" id="det-body"><div class="det-empty">Select a device</div></div>
    </div>
  </div>
</div>

<!-- Terminal pane -->
<div class="pane" id="pane-terminal">
  <div class="term-wrap">
    <div class="term-bar">
      <div class="tdot" id="term-dot"></div>
      <div class="tstat" id="term-status">Not connected</div>
    </div>
    <div id="terminal-wrap"><div id="terminal"></div></div>
  </div>
</div>

<!-- Accounts pane -->
<div class="pane" id="pane-accounts">
  <div class="accs-body">
    <div class="accs-sec">
      <div class="accs-sec-hdr">Chat Accounts</div>
      <div id="accs-list"><div style="color:var(--sec);font-size:13px">Loading…</div></div>
    </div>
    <div class="accs-sec">
      <div class="accs-sec-hdr">Groups</div>
      <div id="groups-list"></div>
    </div>
    <div class="accs-sec">
      <details>
        <summary>Test User tools</summary>
        <div style="padding-top:10px;display:flex;flex-direction:column;gap:8px">
          <div class="acc-item" style="gap:12px">
            <div class="acc-av" style="background:rgba(88,166,255,.12);color:#58a6ff;font-size:10px">TU</div>
            <div style="flex:1;min-width:0">
              <div class="acc-name">Test User</div>
              <div class="acc-key">ID: test-user — send messages &amp; accept friend requests for testing</div>
            </div>
          </div>
          <div id="tu-reqs"></div>
          <button class="abtn" onclick="testFriendAll()" style="align-self:flex-start">&#128101; Friend with all users</button>
        </div>
      </details>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
const P='${base}';
const MAIN_PORT=${SERVER_PORT};

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ini(s){return(String(s||'?')[0]||'?').toUpperCase();}
function avErr(el){var s=document.createElement('span');s.textContent=(el.alt||'?')[0].toUpperCase();el.parentNode.replaceChild(s,el);}
function avHtml(name,url){
  if(url)return '<img src="'+esc(url)+'" alt="'+esc(name)+'" onerror="avErr(this)">';
  return '<span>'+ini(name)+'</span>';
}
function fmtDur(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
function fmtUp(s){if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function fmtTime(ts){return new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function fmtDate(ts){
  var d=new Date(ts),n=new Date();
  if(d.toDateString()===n.toDateString())return 'Today';
  if(d.toDateString()===new Date(n-86400000).toDateString())return 'Yesterday';
  return d.toLocaleDateString();
}

var curTab='chat',curRoom=null,curDevice=null,activeSender='server';
var adminData={connectedDevices:[],offlineDevices:[],system:null};
var spyWs=null;
var spyRooms=new Map();spyRooms.set('global',{name:'Global Chat',type:'global'});
var spyMsgs=new Map();spyMsgs.set('global',[]);
var unread=new Map(),totalUnread=0;
var chatAccounts=[];
var pmKey=null;

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name){
  curTab=name;
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t.dataset.tab===name);});
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('on');});
  var p=document.getElementById('pane-'+name);if(p)p.classList.add('on');
  if(name==='chat'){renderRooms();if(curRoom)renderMsgs();}
  if(name==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
  if(name==='accounts')loadAccounts();
  if(name==='terminal'){initTerm();setTimeout(function(){if(fit)fit.fit();},40);}
}

// ── Room list ─────────────────────────────────────────────────────────────────
function roomIcon(type){
  if(type==='global')return '🌐';
  if(type==='group') return '👥';
  if(type==='dm')    return '💬';
  return '💬';
}

function renderRooms(){
  var col=document.getElementById('rooms-col');if(!col)return;
  var q=(document.getElementById('room-search')?.value||'').toLowerCase().trim();
  var global=[],groups=[],dms=[];
  spyRooms.forEach(function(r,id){
    if(q&&!(r.name||id).toLowerCase().includes(q))return;
    if(id==='global')global.push([id,r]);
    else if(id.startsWith('group:'))groups.push([id,r]);
    else dms.push([id,r]);
  });

  var h='';
  function section(title,rooms){
    if(!rooms.length)return;
    h+='<div class="rs-hdr">'+esc(title)+'</div>';
    rooms.forEach(function(pair){
      var id=pair[0],r=pair[1];
      var msgs=spyMsgs.get(id)||[];
      var last=msgs[msgs.length-1];
      var badge=unread.get(id)||0;
      var sel=curRoom===id;
      h+='<div class="r-item'+(sel?' on':'')+'" onclick="selectRoom(\''+esc(id)+'\')">';
      h+='<div class="r-av">'+avHtml(r.name||id,null)+'<div class="r-type-badge">'+roomIcon(r.type||'dm')+'</div></div>';
      h+='<div class="r-inf">';
      h+='<div class="r-name">'+esc(r.name||id)+'</div>';
      if(last)h+='<div class="r-prev">'+esc(last.fromName||'')+(last.fromName?': ':'')+esc((last.text||'').slice(0,40))+'</div>';
      else h+='<div class="r-prev" style="opacity:.4">No messages</div>';
      h+='</div>';
      h+='<div class="r-meta">';
      if(last)h+='<div class="r-time">'+fmtTime(last.ts)+'</div>';
      if(badge)h+='<div class="r-badge">'+badge+'</div>';
      h+='</div></div>';
    });
  }
  section('Global',global);
  section('Groups',groups);
  section('Direct Messages',dms);
  if(!h)h='<div style="padding:14px;color:var(--sec);font-size:12px">No results</div>';
  col.innerHTML=h;
}

function selectRoom(id){
  var wasUnread=unread.get(id)||0;
  curRoom=id;
  totalUnread=Math.max(0,totalUnread-wasUnread);
  unread.set(id,0);
  updateChatBadge();
  renderRooms();
  var r=spyRooms.get(id)||{name:id,type:'dm'};
  var nameEl=document.getElementById('m-hdr-name');
  var typeEl=document.getElementById('m-hdr-type');
  var clearBtn=document.getElementById('clear-btn');
  var compose=document.getElementById('m-compose');
  if(nameEl)nameEl.textContent=r.name||id;
  if(typeEl){
    var labels={global:'Global',group:'Group',dm:'DM'};
    typeEl.textContent=roomIcon(r.type||'dm')+' '+(labels[r.type]||'DM');
    typeEl.style.display='';
    // Only allow clearing global and group rooms (not DMs) — or allow all
    typeEl.style.display='';
  }
  if(clearBtn)clearBtn.style.display='';
  if(compose)compose.style.display='';
  renderMsgs();
}

// ── Messages ──────────────────────────────────────────────────────────────────
function renderMsgs(){
  var wrap=document.getElementById('msgs-wrap');if(!wrap)return;
  if(!curRoom){
    wrap.innerHTML='<div class="msg-empty"><div class="msg-empty-ico">&#128172;</div><div>Select a conversation from the sidebar</div></div>';
    return;
  }
  var msgs=spyMsgs.get(curRoom)||[];
  if(!msgs.length){
    wrap.innerHTML='<div class="msg-empty"><div class="msg-empty-ico">&#128172;</div><div>No messages yet</div></div>';
    return;
  }
  var h='',lastDate='';
  msgs.forEach(function(m){
    var d=fmtDate(m.ts);
    if(d!==lastDate){h+='<div class="date-row"><span class="date-chip">'+esc(d)+'</span></div>';lastDate=d;}
    h+=buildMsgRow(m);
  });
  wrap.innerHTML=h;
  wrap.scrollTop=wrap.scrollHeight;
}

function buildMsgRow(m){
  var isAdmin=m.from==='panel-bot'||m.isPanelMsg;
  var av=isAdmin
    ?'<div class="r-av" style="background:rgba(210,153,34,.15);color:#d29922">&#128226;</div>'
    :'<button class="m-av-btn" onclick="pmOpen(\''+esc((m.fromName||'').toLowerCase())+'\')"><div class="r-av">'+avHtml(m.fromName,m.avatarUrl)+'</div></button>';
  var sender=isAdmin
    ?'<span class="m-sender-name admin-label">Server <span style="font-size:10px;background:rgba(210,153,34,.15);color:#d29922;border-radius:3px;padding:1px 5px">ADMIN</span></span>'
    :'<button class="m-sender-name" onclick="pmOpen(\''+esc((m.fromName||'').toLowerCase())+'\')">'+esc(m.fromName||'Unknown')+'</button>';
  var bubbleCls='bubble'+(isAdmin?' admin':'');
  return '<div class="m-row">'+av+'<div class="m-bubble-col">'+sender
    +'<span class="'+bubbleCls+'">'+esc(m.text||'')+'<span class="m-time">'+fmtTime(m.ts)+'</span></span>'
    +'</div></div>';
}

function appendMsg(m){
  var wrap=document.getElementById('msgs-wrap');if(!wrap)return;
  var empty=wrap.querySelector('.msg-empty');if(empty)wrap.innerHTML='';
  var row=document.createElement('div');
  row.innerHTML=buildMsgRow(m);
  wrap.appendChild(row.firstChild);
  wrap.scrollTop=wrap.scrollHeight;
}

// ── Clear (actually persists to server) ──────────────────────────────────────
async function clearRoom(){
  if(!curRoom)return;
  var name=spyRooms.get(curRoom)?.name||curRoom;
  if(!confirm('Clear all messages in "'+name+'"? This cannot be undone.'))return;
  var btn=document.getElementById('clear-btn');
  if(btn)btn.disabled=true;
  try{
    var r=await fetch(P+'/api/clear-room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:curRoom})});
    var d=await r.json();
    if(!d.ok)alert(d.error||'Failed to clear');
    // spyMsg handler will receive chat:clear and update local view
  }catch(e){alert('Error: '+e.message);}
  if(btn)btn.disabled=false;
}

// ── Compose ───────────────────────────────────────────────────────────────────
function setSender(mode){
  activeSender=mode;
  document.getElementById('sp-server').classList.toggle('on',mode==='server');
  document.getElementById('sp-test').classList.toggle('on',mode==='testuser');
}

async function panelSend(){
  var room=curRoom;
  var inp=document.getElementById('m-inp');
  var text=(inp?.value||'').trim();
  if(!room||!text)return;
  var btn=document.getElementById('m-send');if(btn)btn.disabled=true;
  try{
    var endpoint=activeSender==='testuser'?'/api/test-msg':'/api/panel-broadcast';
    var r=await fetch(P+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:room,text:text})});
    var d=await r.json();
    if(d.ok){if(inp)inp.value='';inp?.focus();}
    else alert(d.error||'Failed');
  }catch(e){alert('Error: '+e.message);}
  if(btn)btn.disabled=false;
}

// ── Unread badge ──────────────────────────────────────────────────────────────
function updateChatBadge(){
  var el=document.getElementById('chat-badge');
  if(!el)return;
  el.textContent=totalUnread;
  el.style.display=totalUnread?'':'none';
}

// ── Devices ───────────────────────────────────────────────────────────────────
function renderDeviceList(){
  var col=document.getElementById('dev-list');if(!col)return;
  var devs=adminData.connectedDevices||[];
  var badge=document.getElementById('dev-badge');
  if(badge){badge.textContent=devs.length;badge.style.display=devs.length?'':'none';}
  if(!devs.length){col.innerHTML='<div style="color:var(--sec);font-size:12px;padding:4px">No devices connected</div>';return;}
  var h='';
  devs.forEach(function(d){
    var name=(d.user&&d.user.displayName)||d.deviceId.slice(0,10)+'…';
    var track=d.player&&d.player.track;
    var sub=d.radio?'&#128191; '+esc(d.radio.name||'Radio'):track?'&#9654; '+esc(track.name):'Connected';
    var sel=curDevice===d.deviceId;
    h+='<div class="dev-card'+(sel?' on':'')+'" onclick="selectDevice(\''+esc(d.deviceId)+'\')">';
    h+='<div class="dev-av"><span>'+ini(name)+'</span><div class="dev-dot"></div></div>';
    h+='<div class="dev-inf"><div class="dev-name">'+esc(name)+'</div>';
    h+='<div class="dev-sub">'+sub+'</div>';
    h+='<div class="pills">';
    if(d.authenticated)h+='<span class="pill pg">Spotify</span>';
    h+='<span class="pill pb">'+(d.tabs||0)+' tab'+(d.tabs!==1?'s':'')+'</span>';
    if(d.player&&d.player.isPlaying)h+='<span class="pill pg">Playing</span>';
    h+='</div></div></div>';
  });
  col.innerHTML=h;
}

function selectDevice(id){
  curDevice=id;
  renderDeviceList();
  var all=(adminData.connectedDevices||[]).concat(adminData.offlineDevices||[]);
  var d=null;for(var i=0;i<all.length;i++){if(all[i].deviceId===id){d=all[i];break;}}
  var body=document.getElementById('det-body');if(!body)return;
  if(!d){body.innerHTML='<div class="det-empty">Device not found</div>';return;}
  var name=(d.user&&d.user.displayName)||d.deviceId.slice(0,10)+'…';
  var p=d.player,t=p&&p.track;
  var h='';
  h+='<div class="det-card"><div class="det-title">Connection</div>';
  h+='<div class="det-row"><span class="det-k">Device ID</span><span class="det-v" style="font-family:ui-monospace,monospace;font-size:11px">'+esc(d.deviceId.slice(0,24))+'…</span></div>';
  h+='<div class="det-row"><span class="det-k">IP</span><span class="det-v">'+esc((d.ips||[]).join(', ')||'Unknown')+'</span></div>';
  h+='<div class="det-row"><span class="det-k">Tabs open</span><span class="det-v">'+(d.tabs||0)+'</span></div>';
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
    h+=t.albumArt?'<img class="alb-img" src="'+esc(t.albumArt)+'" onerror="this.style.display=\'none\'">':'<div class="alb-img"></div>';
    h+='<div><div class="t-name">'+esc(t.name)+'</div><div class="t-sub">'+esc(t.artists||'')+'</div><div class="t-sub">'+esc(t.album||'')+'</div></div></div>';
    h+='<div class="prog"><div class="prog-f" style="width:'+pct+'%"></div></div>';
    h+='<div class="det-row"><span class="det-k">State</span><span>'+(p.isPlaying?'<span class="pill pg">&#9654; Playing</span>':'<span class="pill pn">Paused</span>')+'</span></div>';
    h+='<div class="det-row"><span class="det-k">Progress</span><span class="det-v">'+fmtDur(t.progressMs||0)+' / '+fmtDur(t.durationMs||0)+'</span></div>';
    if(p.device)h+='<div class="det-row"><span class="det-k">Output</span><span class="det-v">'+esc(p.device.name)+' ('+esc(p.device.type)+')</span></div>';
    h+='</div>';
  }
  if(d.radio){
    h+='<div class="det-card"><div class="det-title">Radio</div>';
    h+='<div class="det-row"><span class="det-k">Station</span><span class="det-v">'+esc(d.radio.name||'Unknown')+'</span></div></div>';
  }
  body.innerHTML=h;
}

// ── Admin data polling ────────────────────────────────────────────────────────
async function refreshAdmin(){
  try{
    var r=await fetch(P+'/api/admin');
    if(r.status===401){location.reload();return;}
    var j=await r.json();
    if(!j.overview)return;
    adminData=j.overview;
    var sys=adminData.system;
    var statsEl=document.getElementById('hdr-stats');
    if(statsEl&&sys){
      var load=sys.loadAvg&&sys.loadAvg[0]?sys.loadAvg[0].toFixed(2):'?';
      var loadColor=parseFloat(load)>2?'var(--red)':parseFloat(load)>1?'var(--ylw)':'var(--grn)';
      statsEl.innerHTML=
        '<div class="stat-chip">&#128421; '+esc(sys.hostname)+'</div>'+
        '<div class="stat-chip">&#9201; up '+fmtUp(sys.uptime)+'</div>'+
        '<div class="stat-chip"><div class="dot" style="background:'+loadColor+'"></div>load '+load+'</div>'+
        '<div class="stat-chip">RAM '+sys.memPct+'%</div>'+
        (adminData.ffmpegRunning?'<div class="stat-chip"><div class="dot dot-grn"></div>Casting</div>':'');
    }
    var n=(adminData.connectedDevices||[]).length;
    var badge=document.getElementById('dev-badge');
    if(badge){badge.textContent=n;badge.style.display=n?'':'none';}
    if(curTab==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
  }catch(e){}
}

// ── Accounts ──────────────────────────────────────────────────────────────────
async function loadAccounts(){
  try{
    var r=await fetch(P+'/api/chat-accounts');
    if(!r.ok){document.getElementById('accs-list').innerHTML='<div style="color:var(--sec);font-size:13px">Could not load</div>';return;}
    var d=await r.json();
    chatAccounts=d.accounts||[];
    renderAccounts();
    renderGroups(d.groups||[]);
    loadTestReqs();
  }catch(e){}
}

function renderAccounts(){
  var el=document.getElementById('accs-list');if(!el)return;
  if(!chatAccounts.length){el.innerHTML='<div style="color:var(--sec);font-size:13px">No chat users yet</div>';return;}
  var h='';
  chatAccounts.forEach(function(a){
    h+='<div class="acc-item">';
    h+='<div class="acc-av">'+avHtml(a.name,a.avatarUrl)+'</div>';
    h+='<div style="flex:1;min-width:0"><div class="acc-name">'+esc(a.name)+'</div><div class="acc-key">'+esc(a.key)+'</div></div>';
    h+='<button class="abtn" onclick="pmOpen(\''+esc(a.key)+'\')">&#9998; Edit</button>';
    h+='</div>';
  });
  el.innerHTML=h;
}

function renderGroups(groups){
  var el=document.getElementById('groups-list');if(!el)return;
  if(!groups.length){el.innerHTML='<div style="color:var(--sec);font-size:13px">No groups yet</div>';return;}
  var h='';
  groups.forEach(function(g){
    h+='<div class="acc-item">';
    h+='<div class="acc-av" style="font-size:.9rem">&#128101;</div>';
    h+='<div style="flex:1;min-width:0"><div class="acc-name">'+esc(g.name)+'</div><div class="acc-key">'+g.memberCount+' member'+(g.memberCount!==1?'s':'')+'</div></div>';
    h+='<button class="abtn danger" onclick="deleteGroup(\''+esc(g.id)+'\')">&#128465;</button>';
    h+='</div>';
  });
  el.innerHTML=h;
}

async function deleteGroup(id){
  if(!confirm('Delete this group and all its messages?'))return;
  try{
    var r=await fetch(P+'/api/admin/chat-group/'+encodeURIComponent(id),{method:'DELETE'});
    var d=await r.json();
    if(d.ok)loadAccounts();else alert(d.error||'Delete failed');
  }catch(e){alert('Error: '+e.message);}
}

// ── Test user ─────────────────────────────────────────────────────────────────
async function loadTestReqs(){
  try{
    var r=await fetch(P+'/api/test-friend-reqs');
    var d=await r.json();
    var el=document.getElementById('tu-reqs');if(!el)return;
    var reqs=d.reqs||[];
    if(!reqs.length){el.innerHTML='<div style="color:var(--sec);font-size:12px">No pending friend requests</div>';return;}
    var h='<div style="font-size:11px;color:var(--sec);margin-bottom:6px">Pending friend requests:</div>';
    reqs.forEach(function(req){
      h+='<div class="acc-item" style="padding:8px 10px"><div class="acc-av" style="width:26px;height:26px">'
        +(req.avatarUrl?'<img src="'+esc(req.avatarUrl)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':'<span>'+ini(req.name)+'</span>')
        +'</div><div style="flex:1;min-width:0"><div class="acc-name">'+esc(req.name)+'</div></div>'
        +'<button class="abtn" onclick="testAcceptReq(\''+esc(req.id)+'\')">Accept</button></div>';
    });
    el.innerHTML=h;
  }catch(e){}
}

async function testFriendAll(){
  try{
    var r=await fetch(P+'/api/test-friend-all',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    var d=await r.json();
    if(d.ok)alert('Friended '+d.count+' user(s) with Test User.');
    else alert(d.error||'Failed');
  }catch(e){alert('Error: '+e.message);}
}

async function testAcceptReq(fromId){
  try{
    var r=await fetch(P+'/api/test-accept-req',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fromId:fromId})});
    var d=await r.json();
    if(d.ok)loadTestReqs();else alert(d.error||'Failed');
  }catch(e){alert('Error: '+e.message);}
}

// ── Profile modal ─────────────────────────────────────────────────────────────
function pmOpen(key){
  pmKey=key;
  var acc=chatAccounts.find(function(a){return a.key===key;})||{name:key,avatarUrl:null};
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
  if(!pmKey)return pmClose();
  var btn=document.getElementById('pm-save'),msg=document.getElementById('pm-msg');
  btn.disabled=true;msg.style.color='';msg.textContent='Saving…';
  var body={key:pmKey,name:document.getElementById('pm-name').value.trim(),avatarUrl:document.getElementById('pm-avatar-url').value.trim()||null};
  try{
    var r=await fetch(P+'/api/chat-account',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var d=await r.json();
    if(d.ok){
      msg.style.color='#3fb950';msg.textContent='Saved';
      var idx=chatAccounts.findIndex(function(a){return a.key===pmKey;});
      if(idx>=0){chatAccounts[idx].name=d.name;chatAccounts[idx].avatarUrl=d.avatarUrl;}
      renderAccounts();setTimeout(pmClose,700);
    }else{msg.style.color='#f85149';msg.textContent=d.error||'Failed';}
  }catch(e){msg.style.color='#f85149';msg.textContent='Error: '+e.message;}
  btn.disabled=false;
}

// ── Header actions ────────────────────────────────────────────────────────────
async function doRestart(){
  var btn=document.getElementById('restart-btn');
  btn.textContent='Restarting…';btn.disabled=true;
  try{var r=await fetch(P+'/api/restart-server',{method:'POST'});var d=await r.json();btn.textContent=d.ok?'Done ✓':'Failed';}
  catch(e){btn.textContent='Error';}
  setTimeout(function(){btn.innerHTML='&#8635; Restart';btn.disabled=false;},3000);
}
async function logout(){await fetch(P+'/api/logout',{method:'POST'});location.reload();}

// ── Ghost spy WebSocket ───────────────────────────────────────────────────────
async function spyConnect(){
  if(spyWs&&spyWs.readyState<2)return;
  try{
    var r=await fetch(P+'/api/ghost-token');if(!r.ok)return;
    var j=await r.json();if(!j.token)return;
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
      var msgs=d.messages||[];
      var parts=[...new Set(msgs.map(function(msg){return msg.fromName||'';}))].filter(Boolean);
      spyRooms.set(d.room,{name:parts.length?parts.join(' ↔ '):'DM',type:'dm'});
      spyMsgs.set(d.room,msgs);
    });
    if(curTab==='chat')renderRooms();
    if(curRoom)renderMsgs();
    // Auto-select global on first load if nothing selected
    if(!curRoom)selectRoom('global');
    return;
  }
  if(m.type==='chat:msg'){
    if(!spyMsgs.has(m.room))spyMsgs.set(m.room,[]);
    spyMsgs.get(m.room).push(m);
    if(curRoom===m.room)appendMsg(m);
    else{
      var n=(unread.get(m.room)||0)+1;
      unread.set(m.room,n);
      if(curTab!=='chat'){totalUnread++;updateChatBadge();}
      if(curTab==='chat')renderRooms();
    }
    return;
  }
  if(m.type==='chat:group-created'){
    spyRooms.set(m.group.id,{name:m.group.name,type:'group'});
    spyMsgs.set(m.group.id,[]);
    if(curTab==='chat')renderRooms();
    return;
  }
  if(m.type==='chat:group-deleted'){
    spyRooms.delete(m.groupId);spyMsgs.delete(m.groupId);
    if(curRoom===m.groupId){curRoom=null;renderRooms();renderMsgs();}
    return;
  }
  if(m.type==='chat:clear'){
    spyMsgs.set(m.room,[]);
    if(curRoom===m.room)renderMsgs();
    return;
  }
}

// ── Terminal ──────────────────────────────────────────────────────────────────
var term=null,fit=null,termWs=null,termInited=false;
function termConnect(){
  if(!term){document.getElementById('term-status').textContent='xterm not loaded';return;}
  if(termWs&&termWs.readyState<2)termWs.close();
  var proto=location.protocol==='https:'?'wss:':'ws:';
  termWs=new WebSocket(proto+'//'+location.host+P+'/terminal');
  termWs.onopen=function(){
    document.getElementById('term-dot').classList.add('on');
    document.getElementById('term-status').textContent='Connected — running install.sh';
    if(fit)fit.fit();
    termWs.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
  };
  termWs.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='data')term.write(msg.data);}catch(err){term.write(e.data);}};
  termWs.onclose=function(){
    document.getElementById('term-dot').classList.remove('on');
    document.getElementById('term-status').textContent='Disconnected — reconnecting…';
    setTimeout(termConnect,3000);
  };
  termWs.onerror=function(){termWs.close();};
  term.onData(function(d){if(termWs&&termWs.readyState===1)termWs.send(JSON.stringify({type:'data',data:d}));});
  term.onResize(function(s){if(termWs&&termWs.readyState===1)termWs.send(JSON.stringify({type:'resize',cols:s.cols,rows:s.rows}));});
}
function initTerm(){
  if(termInited)return;termInited=true;
  try{
    term=new Terminal({cursorBlink:true,scrollback:10000,theme:{background:'#0d1117',foreground:'#e6edf3',cursor:'#58a6ff',selectionBackground:'#264f78'},fontFamily:'ui-monospace,Menlo,monospace',fontSize:13,lineHeight:1.2});
    fit=new FitAddon.FitAddon();
    term.loadAddon(fit);term.open(document.getElementById('terminal'));fit.fit();
    var tw=document.getElementById('terminal-wrap');
    if(tw)new ResizeObserver(function(){if(fit)fit.fit();}).observe(tw);
    termConnect();
  }catch(e){console.error('xterm:',e);document.getElementById('term-status').textContent='xterm failed to load';}
}

// ── Boot ─────────────────────────────────────────────────────────────────────
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

  if (req.method === 'POST' && url.pathname === '/api/clear-room') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const data = await callServerJson('/api/admin/clear-room', 'POST', parsed);
        sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-msg') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const data = await callServerJson('/api/admin/test-msg', 'POST', parsed);
        sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/test-friend-reqs') {
    const data = await callServerJson('/api/admin/test-friend-reqs');
    sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-accept-req') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const data = await callServerJson('/api/admin/test-accept-req', 'POST', parsed);
        sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-friend-all') {
    const data = await callServerJson('/api/admin/test-friend-all', 'POST', {});
    sendJson(res, data ? 200 : 502, data || { error: 'unavailable' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/env') {
    const envFile = path.join(__dirname, '.env');
    const KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
    const result = {};
    try {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && KEYS.includes(m[1])) result[m[1]] = m[2].trim();
      }
    } catch {}
    sendJson(res, 200, result);
    return;
  }

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
          if (idx >= 0) lines[idx] = `${key}=${val}`; else lines.push(`${key}=${val}`);
        }
        fs.writeFileSync(envFile, lines.join('\n'));
        try {
          const pid = parseInt(fs.readFileSync(path.join(RUN_DIR, 'launcher.pid'), 'utf8').trim(), 10);
          if (pid) process.kill(pid, 'SIGUSR1');
        } catch {}
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
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
