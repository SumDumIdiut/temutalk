'use strict';
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const PORT        = parseInt(process.env.PANEL_PORT || '9090', 10);
const RUN_DIR     = path.join(__dirname, '.run');
const SERVER_PORT = parseInt(process.env.PORT || '3001', 10);

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
    "img-src 'self' data: blob: https://i.scdn.co https://avatars.githubusercontent.com"
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
  <div class="drop-label" style="font-size:11px;margin-top:4px;opacity:.6">key.key</div>
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
</style>
</head>
<body>

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
  <button class="tab on" data-tab="devices"  onclick="switchTab('devices')">&#128241; Devices <span class="tbadge" id="dev-badge" style="display:none">0</span></button>
</nav>

<!-- Devices pane -->
<div class="pane on" id="pane-devices">
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

<script>
const P='${base}';
const MAIN_PORT=${SERVER_PORT};

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ini(s){return(String(s||'?')[0]||'?').toUpperCase();}
function fmtDur(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
function fmtUp(s){if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}

var curTab='devices',curDevice=null;
var adminData={connectedDevices:[],offlineDevices:[],system:null};

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name){
  curTab=name;
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t.dataset.tab===name);});
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('on');});
  var p=document.getElementById('pane-'+name);if(p)p.classList.add('on');
  if(name==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
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
    h+='<div class="dev-card'+(sel?' on':'')+'" onclick="selectDevice(\\''+esc(d.deviceId)+'\\')">';
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
    h+=t.albumArt?'<img class="alb-img" src="'+esc(t.albumArt)+'" onerror="this.style.display=\\'none\\'">':'<div class="alb-img"></div>';
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
        '<div class="stat-chip">RAM '+sys.memPct+'%</div>';
    }
    var n=(adminData.connectedDevices||[]).length;
    var badge=document.getElementById('dev-badge');
    if(badge){badge.textContent=n;badge.style.display=n?'':'none';}
    if(curTab==='devices'){renderDeviceList();if(curDevice)selectDevice(curDevice);}
  }catch(e){}
}

// ── Header actions ────────────────────────────────────────────────────────────
async function doRestart(){
  var btn=document.getElementById('restart-btn');
  btn.textContent='Restarting…';btn.disabled=true;
  try{var r=await fetch(P+'/api/restart-server',{method:'POST'});var d=await r.json();btn.textContent=d.ok?'Done':'Failed';}
  catch(e){btn.textContent='Error';}
  setTimeout(function(){btn.innerHTML='&#8635; Restart';btn.disabled=false;},3000);
}
async function logout(){await fetch(P+'/api/logout',{method:'POST'});location.reload();}

// ── Boot ─────────────────────────────────────────────────────────────────────
refreshAdmin();
setInterval(refreshAdmin,4000);
</script>
</body>
</html>`;
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

  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
}

// ─── Servers ───────────────────────────────────────────────────────────────────
const tls = loadOrCreateCert();

const server = https.createServer(tls, handleRequest);
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} already in use`);
  else console.error('Server error:', err);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => console.log(`Control panel on https://0.0.0.0:${PORT}`));

const internalServer = http.createServer(handleRequest);
internalServer.listen(PORT + 1, '127.0.0.1', () => console.log(`Control panel internal on http://127.0.0.1:${PORT + 1}`));
