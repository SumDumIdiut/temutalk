// Icecast stream proxy, ffmpeg management, live channel list, broadcast control page.

const http     = require('http');
const axios    = require('axios');
const { execFileSync, spawn: spawnProc } = require('child_process');
const os       = require('os');
const WebSocket = require('ws');

const state = require('./state');

// ─── ffmpeg management ────────────────────────────────────────────────────────
let ffmpegProc = null;

function getPulseMonitor() {
  const uid    = process.getuid ? process.getuid() : 1000;
  const xdgDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  try {
    const out = execFileSync('pactl', ['list', 'short', 'sources'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_RUNTIME_DIR: xdgDir, PULSE_SERVER: `unix:${xdgDir}/pulse/native` },
    });
    const line = out.split('\n').find(l => l.includes('.monitor') && !l.includes('auto_null'));
    if (line) { const name = line.split('\t')[1]; console.log('[ffmpeg] monitor source:', name); return name; }
  } catch (e) { console.error('[ffmpeg] pactl failed:', e.message); }
  return 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor';
}

function startFfmpeg() {
  if (ffmpegProc) return { ok: false, error: 'already running' };
  const source = getPulseMonitor();
  const args = [
    '-f', 'pulse', '-i', source,
    '-acodec', 'libmp3lame', '-ab', '192k', '-ar', '44100', '-ac', '2',
    '-f', 'mp3',
    'icecast://source:hackme@localhost:8000/stream',
  ];
  const uid    = process.getuid ? process.getuid() : 1000;
  const xdgDir = `/run/user/${uid}`;
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || xdgDir,
    PULSE_SERVER:    process.env.PULSE_SERVER    || `unix:${xdgDir}/pulse/native`,
  };
  ffmpegProc = spawnProc('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  ffmpegProc.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim().split('\n').pop()));
  ffmpegProc.on('close', code => { console.log(`[ffmpeg] exited ${code}`); ffmpegProc = null; });
  ffmpegProc.on('error', err  => { console.error(`[ffmpeg] error: ${err.message}`); ffmpegProc = null; });
  return { ok: true, source };
}

function stopFfmpeg() {
  if (!ffmpegProc) return { ok: false, error: 'not running' };
  ffmpegProc.kill('SIGTERM');
  ffmpegProc = null;
  return { ok: true };
}

// Exported for admin overview
function ffmpegRunning() { return !!ffmpegProc; }

// ─── Live channel list broadcast ──────────────────────────────────────────────
function broadcastLiveList() {
  const list = [...state.liveChannels.entries()]
    .filter(([, ch]) => ch.ws?.readyState === WebSocket.OPEN)
    .map(([id, ch]) => ({ id, name: ch.name, avatarUrl: ch.avatarUrl, listeners: ch.listeners.size, mimeType: ch.mimeType, startedAt: ch.startedAt }));
  const msg = JSON.stringify({ type: 'live-list', channels: list });
  for (const [, sockets] of state.deviceClients)
    for (const s of sockets)
      if (s.readyState === WebSocket.OPEN) s.send(msg);
}

// ─── Route setup ──────────────────────────────────────────────────────────────
module.exports = function setupStreamRoutes(app, MAIN_BASE) {

  app.get('/stream', (req, res) => {
    const ip    = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const entry = { ip, ua: req.headers['user-agent'] || '', connectedAt: Date.now() };
    state.streamListeners.set(res, entry);
    const proxy = http.get('http://localhost:8000/stream', iceRes => {
      res.writeHead(iceRes.statusCode, {
        'Content-Type':              iceRes.headers['content-type'] || 'audio/mpeg',
        'Cache-Control':             'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      iceRes.pipe(res);
      const cleanup = () => { state.streamListeners.delete(res); iceRes.destroy(); };
      req.on('close', cleanup);
      res.on('finish', cleanup);
    });
    proxy.on('error', () => { state.streamListeners.delete(res); res.status(503).end(); });
  });

  app.get('/api/broadcast/status', (req, res) => {
    res.json({ running: !!ffmpegProc, pid: ffmpegProc?.pid ?? null });
  });

  app.post('/api/broadcast/start', (req, res) => { res.json(startFfmpeg()); });
  app.post('/api/broadcast/stop',  (req, res) => { res.json(stopFfmpeg()); });

  app.get('/api/live', (req, res) => {
    const list = [...state.liveChannels.entries()]
      .filter(([, ch]) => ch.ws?.readyState === WebSocket.OPEN)
      .map(([id, ch]) => ({ id, name: ch.name, avatarUrl: ch.avatarUrl, listeners: ch.listeners.size, mimeType: ch.mimeType, startedAt: ch.startedAt }));
    res.json(list);
  });

  app.get('/broadcast', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TemuTalk Broadcast</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font:14px/1.6 system-ui,sans-serif;background:#0d0f1a;color:#e0e4f0;padding:36px 24px;max-width:500px}
    h1{font-size:20px;font-weight:800;margin-bottom:4px}
    .sub{color:#7b82a8;font-size:13px;margin-bottom:28px}
    button{width:100%;padding:13px 14px;border-radius:12px;border:2px solid rgba(255,255,255,.13);background:rgba(255,255,255,.07);color:#e0e4f0;font:inherit;font-weight:800;cursor:pointer;transition:background .2s,border-color .2s;margin-bottom:10px}
    button:hover{background:rgba(255,255,255,.12)}
    #btn-start{background:#7c6cf8;border-color:#7c6cf8}
    #btn-start:disabled,#btn-stop:disabled{opacity:.4;cursor:default}
    #status{font-size:13px;padding:14px;background:rgba(255,255,255,.05);border-radius:12px;border:1.5px solid rgba(255,255,255,.09);display:flex;align-items:center;gap:10px;margin-bottom:16px}
    .dot{width:10px;height:10px;border-radius:50%;background:#4e5578;flex-shrink:0}
    .dot.live{background:#3ef5a8;box-shadow:0 0 6px #3ef5a8}
    .dot.off{background:#4e5578}
    .dot.warn{background:#ff9f4a}
    .stream-link{font-size:12px;color:#b09ffc;word-break:break-all;margin-top:4px}
    audio{width:100%;margin-top:10px;border-radius:8px}
    .info{font-size:12px;color:#4e5578;margin-top:12px;line-height:1.6}
  </style>
</head>
<body>
  <h1>TemuTalk Broadcast</h1>
  <p class="sub">Controls the ffmpeg + Icecast audio pipeline on the server.</p>
  <div id="status"><div class="dot off" id="dot"></div><span id="stxt">Checking...</span></div>
  <button id="btn-start">Start Broadcasting</button>
  <button id="btn-stop" style="display:none">Stop Broadcasting</button>
  <audio id="player" style="display:none"></audio>
  <div id="vol-row" style="display:none;margin-top:10px;display:none">
    <label style="font-size:11px;color:#7b82a8;display:block;margin-bottom:4px">VOLUME</label>
    <input id="vol" type="range" min="0" max="1" step="0.05" value="1" style="width:100%;accent-color:#7c6cf8">
  </div>
  <div class="info">
    Stream URL: <span class="stream-link">/stream</span><br>
    Icecast: <span class="stream-link">http://localhost:8000/stream</span><br>
    Source: PulseAudio monitor (system audio - Spotify, etc.)
  </div>
  <script>
    const dot=document.getElementById('dot');
    const stxt=document.getElementById('stxt');
    const btnStart=document.getElementById('btn-start');
    const btnStop=document.getElementById('btn-stop');
    const player=document.getElementById('player');
    let playerRunning=false;
    const volRow=document.getElementById('vol-row');
    document.getElementById('vol').oninput=function(){player.volume=this.value;};
    function startPlayer(){if(playerRunning)return;playerRunning=true;player.src='/stream?t='+Date.now();player.style.display='none';volRow.style.display='block';player.play().catch(()=>{});}
    function stopPlayer(){playerRunning=false;player.pause();player.src='';volRow.style.display='none';}
    function reconnect(){if(!playerRunning)return;player.pause();player.src='/stream?t='+Date.now();player.load();player.play().catch(()=>{});}
    player.addEventListener('error',()=>setTimeout(reconnect,1000));
    player.addEventListener('stalled',()=>setTimeout(reconnect,2000));
    player.addEventListener('ended',reconnect);
    function setUI(running,msg){dot.className='dot '+(running?'live':'off');stxt.textContent=msg;btnStart.style.display=running?'none':'block';btnStop.style.display=running?'block':'none';if(running)startPlayer();else stopPlayer();}
    async function checkStatus(){try{const res=await fetch('/api/broadcast/status');if(!res.ok)throw new Error('HTTP '+res.status);const r=await res.json();setUI(r.running,r.running?'Live - streaming via ffmpeg (PID '+r.pid+')':'Idle - not streaming');}catch(e){dot.className='dot warn';stxt.textContent='Server error: '+e.message;}}
    btnStart.onclick=async()=>{btnStart.disabled=true;dot.className='dot warn';stxt.textContent='Starting ffmpeg...';try{const res=await fetch('/api/broadcast/start',{method:'POST'});const r=await res.json();if(r.ok)setTimeout(checkStatus,1500);else{stxt.textContent='Failed: '+(r.error||'unknown');btnStart.disabled=false;}}catch(e){stxt.textContent='Error: '+e.message;btnStart.disabled=false;}};
    btnStop.onclick=async()=>{btnStop.disabled=true;await fetch('/api/broadcast/stop',{method:'POST'}).catch(()=>{});setTimeout(checkStatus,500);};
    checkStatus();
    setInterval(checkStatus,5000);
  </script>
</body>
</html>`);
  });

  return { broadcastLiveList, ffmpegRunning };
};
