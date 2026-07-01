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
const SESSION_TTL_MS   = 12 * 60 * 60 * 1000;
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
function fetchServerJson(urlPath) {
  return new Promise(resolve => {
    const req = https.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method: 'GET', agent: tlsAgent },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

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
    "img-src 'self' data: https://i.scdn.co blob:"
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
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0c10;color:#e6e8ec;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#0d1017;border-bottom:1px solid #1a1e2a;flex-shrink:0}
.topbar h1{font-size:.95rem;color:#e6e8ec}
.topbar-right{display:flex;align-items:center;gap:10px}
.server-url{color:#6ab0ff;font-size:.75rem;text-decoration:none}
.logout{background:none;border:1px solid #2c3242;color:#8b93a3;border-radius:7px;padding:4px 10px;font-size:.75rem;cursor:pointer}
.layout{display:flex;flex:1;overflow:hidden;gap:0}
.sessions-panel{width:320px;flex-shrink:0;border-right:1px solid #1a1e2a;display:flex;flex-direction:column;overflow:hidden}
.sessions-hdr{padding:10px 14px;font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#556;border-bottom:1px solid #1a1e2a;flex-shrink:0}
.sessions-body{flex:1;overflow-y:auto;padding:10px}
.terminal-panel{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.terminal-hdr{padding:10px 14px;font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#556;border-bottom:1px solid #1a1e2a;flex-shrink:0;display:flex;align-items:center;gap:8px}
.term-dot{width:7px;height:7px;border-radius:50%;background:#343944;flex-shrink:0}
.term-dot.on{background:#3ddc84;box-shadow:0 0 4px #3ddc84}
#terminal-wrap{flex:1;overflow:hidden;background:#080a0e;padding:4px}
.card{background:#111420;border:1px solid #1e2330;border-radius:10px;padding:12px;margin-bottom:8px}
.card-name{font-weight:600;font-size:.85rem}
.card-sub{color:#8b93a3;font-size:.74rem;margin-top:2px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px}
.dot.on{background:#3ddc84}.dot.off{background:#343944}
.pill{display:inline-block;border-radius:20px;padding:2px 7px;font-size:.68rem;font-weight:600;margin-left:4px}
.pill-green{background:#1a3a28;color:#5ddd8a}.pill-blue{background:#1a2d4a;color:#6ab0ff}
.pill-gray{background:#1e222c;color:#8b93a3}.pill-yellow{background:#3a2d10;color:#f0c060}
.track-row{display:flex;align-items:center;gap:10px;margin-top:8px}
.album-art{width:36px;height:36px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#1e2330}
.track-name{font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track-meta{font-size:.72rem;color:#8b93a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress-bar{background:#1e2330;border-radius:2px;height:2px;margin-top:6px;overflow:hidden}
.progress-fill{background:#3ddc84;height:100%}
.ip{font-family:ui-monospace,monospace;font-size:.7rem;color:#9aa4b5;margin-top:3px}
.dim{color:#4a5060;font-style:italic;font-size:.8rem}
@media(max-width:680px){
  .layout{flex-direction:column}
  .sessions-panel{width:100%;height:220px;border-right:none;border-bottom:1px solid #1a1e2a}
}
</style>
</head>
<body>
<div class="topbar">
  <h1>&#9654; TemuTalk</h1>
  <div class="topbar-right">
    <a class="server-url" id="app-url" href="https://codecade.co.za" target="_blank">codecade.co.za</a>
    <button class="logout" onclick="logout()">Log out</button>
  </div>
</div>
<div class="layout">

  <div class="sessions-panel">
    <div class="sessions-hdr">Sessions &mdash; <span id="sess-count">0</span> device(s)</div>
    <div class="sessions-body" id="sessions"><div class="dim">Loading&hellip;</div></div>
  </div>

  <div class="terminal-panel">
    <div class="terminal-hdr">
      <div class="term-dot" id="term-dot"></div>
      <span>Terminal</span>
      <span id="term-status" style="font-weight:400;color:#8b93a3;font-size:.7rem">— connecting&hellip;</span>
    </div>
    <div id="terminal-wrap"><div id="terminal"></div></div>
  </div>

</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
const P = '${base}';

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtDur(ms){if(!ms)return'0:00';const s=Math.floor(ms/1000),m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}
function fmtUptime(s){if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function refreshSessions() {
  try {
    const r = await fetch(P + '/api/admin');
    if (r.status === 401) { location.reload(); return; }
    const { overview } = await r.json();
    if (!overview) return;
    const devices = overview.connectedDevices || [];
    document.getElementById('sess-count').textContent = devices.length;
    const el = document.getElementById('sessions');
    if (!devices.length) { el.innerHTML = '<div class="dim">No browsers connected</div>'; return; }
    el.innerHTML = devices.map(d => {
      const p = d.player, u = d.user, r2 = d.radio;
      const art = p?.track?.albumArt
        ? \`<img class="album-art" src="\${esc(p.track.albumArt)}" onerror="this.style.display='none'">\`
        : '<div class="album-art"></div>';
      const track = p?.track ? \`
        <div class="track-row">\${art}
          <div style="min-width:0">
            <div class="track-name">\${esc(p.track.name)}</div>
            <div class="track-meta">\${esc(p.track.artists)}</div>
            \${p.track.durationMs ? \`<div class="progress-bar"><div class="progress-fill" style="width:\${Math.min(100,(p.track.progressMs||0)/p.track.durationMs*100).toFixed(1)}%"></div></div>\` : ''}
          </div>
        </div>\` : '';
      const radio = r2 ? \`<div style="margin-top:6px;font-size:.75rem">&#127925; \${esc(r2.name)}</div>\` : '';
      return \`<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="card-name">
            <span class="dot \${d.authenticated?'on':'off'}"></span>
            \${u?.displayName ? esc(u.displayName) : esc(d.deviceId.slice(0,8))+'&hellip;'}
          </div>
          <div>
            <span class="pill pill-blue">\${d.tabs}t</span>
            \${p?.isPlaying ? '<span class="pill pill-green">&#9654;</span>' : (p ? '<span class="pill pill-gray">&#9646;&#9646;</span>' : '')}
          </div>
        </div>
        \${u?.email ? \`<div class="card-sub">\${esc(u.email)}</div>\` : ''}
        <div class="ip">\${(d.ips||[]).join(' &middot; ')}</div>
        \${track}\${radio}
      </div>\`;
    }).join('');
  } catch {}
}

// ── Terminal ──────────────────────────────────────────────────────────────────
const term = new Terminal({
  cursorBlink: true,
  scrollback: 10000,
  theme: { background:'#080a0e', foreground:'#e6e8ec', cursor:'#3ddc84', selectionBackground:'#2a3a55' },
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.2,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

let ws = null;
function connect() {
  if (ws && ws.readyState < 2) ws.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + P + '/terminal');
  ws.onopen = () => {
    document.getElementById('term-dot').classList.add('on');
    document.getElementById('term-status').textContent = '— connected';
    fit.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = e => {
    try { const m = JSON.parse(e.data); if (m.type === 'data') term.write(m.data); } catch { term.write(e.data); }
  };
  ws.onclose = () => {
    document.getElementById('term-dot').classList.remove('on');
    document.getElementById('term-status').textContent = '— disconnected (reconnecting in 3s)';
    setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
  term.onData(data => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data })));
  term.onResize(({ cols, rows }) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols, rows })));
}

new ResizeObserver(() => fit.fit()).observe(document.getElementById('terminal-wrap'));
connect();

async function logout() {
  await fetch(P + '/api/logout', { method: 'POST' });
  location.reload();
}

refreshSessions();
setInterval(refreshSessions, 4000);
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isAuthed(req) ? page(base) : loginPage(base));
    return;
  }

  if (!isAuthed(req)) { sendJson(res, 401, { error: 'Not authenticated' }); return; }

  if (req.method === 'GET' && url.pathname === '/api/admin') {
    const overview = await fetchServerJson('/api/admin/overview');
    sendJson(res, 200, { overview });
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
