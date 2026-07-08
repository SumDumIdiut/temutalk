// Auto-create .env if missing so the server works from a flash drive
(function () {
  const fs = require('fs'), pt = require('path'), cr = require('crypto');
  const ef = pt.join(__dirname, '.env');
  if (!fs.existsSync(ef))
    fs.writeFileSync(ef,
      'PORT=3001\n' +
      'SESSION_SECRET=' + cr.randomBytes(24).toString('hex') + '\n' +
      'BASE_URL=https://codecade.co.za\n');
}());
require('dotenv').config();

const express    = require('express');
const https      = require('https');
const http       = require('http');
const WebSocket  = require('ws');
const selfsigned = require('selfsigned');
const net        = require('net');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const crypto     = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const MAIN_PORT    = parseInt(process.env.PORT || '3000', 10);
const WEATHER_CITY = process.env.WEATHER_CITY || 'London';

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const a of ifaces)
      if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}
const LOCAL_IP     = getLocalIP();
const MAIN_BASE    = (process.env.BASE_URL || `https://${LOCAL_IP}:${MAIN_PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${MAIN_BASE}/callback`;

// ─── TLS cert ─────────────────────────────────────────────────────────────────
const CERT_KEY_FILE  = path.join(__dirname, '.cert-key.pem');
const CERT_CERT_FILE = path.join(__dirname, '.cert-cert.pem');
const CERT_IP_FILE   = path.join(__dirname, '.cert-ip.txt');

let tlsOpts;
const savedIp = fs.existsSync(CERT_IP_FILE) ? fs.readFileSync(CERT_IP_FILE, 'utf8').trim() : '';
if (fs.existsSync(CERT_KEY_FILE) && fs.existsSync(CERT_CERT_FILE) && savedIp === LOCAL_IP) {
  tlsOpts = { key: fs.readFileSync(CERT_KEY_FILE), cert: fs.readFileSync(CERT_CERT_FILE) };
  console.log('  Reusing existing TLS certificate.\n');
} else {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: LOCAL_IP }],
    {
      days: 3650, algorithm: 'sha256', keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: LOCAL_IP },
        { type: 7, ip: LOCAL_IP },
      ]}],
    }
  );
  fs.writeFileSync(CERT_KEY_FILE,  pems.private);
  fs.writeFileSync(CERT_CERT_FILE, pems.cert);
  fs.writeFileSync(CERT_IP_FILE,   LOCAL_IP);
  tlsOpts = { key: pems.private, cert: pems.cert };
  console.log('  Generated new TLS certificate (accept once in browser).\n');
}

// ─── Modules ──────────────────────────────────────────────────────────────────
const state      = require('./lib/state');
const { devices, resolveDevice, getDeviceToken } = require('./lib/devices');
const setupSpotifyRoutes    = require('./lib/spotify');
const setupDataRoutes       = require('./lib/data');
const setupStreamRoutes     = require('./lib/stream');
const setupWebSocket        = require('./lib/ws');
const chat                  = require('./lib/chat');
const setupYtMusicRoutes    = require('./lib/yt-music');
const setupAppleMusicRoutes = require('./lib/apple-music');
const setupAssistantRoutes  = require('./lib/assistant');

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS + SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const app        = express();
const mainServer = https.createServer(tlsOpts, app);
const wss        = new WebSocket.Server({ noServer: true });

// Route WebSocket upgrades: /panel/* → panel internal server; everything else → wss
mainServer.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/panel/')) {
    const panelPort  = parseInt(process.env.PANEL_PORT || '9090', 10) + 1;
    const targetPath = req.url.replace(/^\/panel/, '') || '/';
    const upstream   = net.connect(panelPort, '127.0.0.1', () => {
      let hdrs = '';
      for (const [k, v] of Object.entries(req.headers)) hdrs += `${k}: ${v}\r\n`;
      upstream.write(`GET ${targetPath} HTTP/1.1\r\n${hdrs}x-panel-base: /panel\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error',   () => upstream.destroy());
    socket.on('close',   () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Redirect broadcast subdomain to /broadcast page
app.use((req, res, next) => {
  if (req.hostname === 'broadcast.codecade.co.za' && req.path === '/') return res.redirect('/broadcast');
  next();
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

// ─── Control panel proxy (/panel → localhost:PORT+1) ─────────────────────────
app.use('/panel', (req, res) => {
  const panelPort = parseInt(process.env.PANEL_PORT || '9090', 10) + 1;
  const bodyBuf   = req.body && Object.keys(req.body).length ? Buffer.from(JSON.stringify(req.body)) : null;
  const headers   = { ...req.headers, 'x-panel-base': '/panel', host: 'localhost' };
  if (bodyBuf) { headers['content-type'] = 'application/json'; headers['content-length'] = bodyBuf.length; }
  const proxy = http.request(
    { hostname: '127.0.0.1', port: panelPort, path: req.url || '/', method: req.method, headers },
    (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); }
  );
  proxy.on('error', () => res.status(502).send('Control panel offline'));
  if (bodyBuf) proxy.end(bodyBuf); else proxy.end();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js'))
      res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ─── Self-signed cert download ────────────────────────────────────────────────
app.get('/cert.pem', (req, res) => {
  if (!fs.existsSync(CERT_CERT_FILE)) return res.status(404).send('No cert');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="temutalk-ca.pem"');
  res.sendFile(CERT_CERT_FILE);
});
app.get('/cert.crt', (req, res) => {
  if (!fs.existsSync(CERT_CERT_FILE)) return res.status(404).send('No cert');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="temutalk-ca.crt"');
  res.sendFile(CERT_CERT_FILE);
});

// ─── App config ───────────────────────────────────────────────────────────────
app.get('/api/auth-info', (req, res) => { res.json({ redirectUri: REDIRECT_URI }); });

app.get('/api/config', (req, res) => {
  const deviceId = resolveDevice(req);
  const dev      = deviceId ? devices.get(deviceId) : null;
  res.json({ weatherCity: WEATHER_CITY, authenticated: !!(dev?.tokens?.access_token) });
});

app.get('/api/status', (req, res) => {
  const deviceId = resolveDevice(req);
  const dev      = deviceId ? devices.get(deviceId) : null;
  res.json({ authenticated: !!(dev?.tokens?.access_token) });
});

// ─── Feature routes ───────────────────────────────────────────────────────────
setupSpotifyRoutes(app, REDIRECT_URI, MAIN_BASE);
setupDataRoutes(app, WEATHER_CITY);
const { broadcastLiveList, ffmpegRunning } = setupStreamRoutes(app, MAIN_BASE);
chat.setupChatRoutes(app, resolveDevice);
setupYtMusicRoutes(app, MAIN_BASE);
setupAppleMusicRoutes(app);
setupAssistantRoutes(app, resolveDevice, WEATHER_CITY);

// ─── WebSocket ────────────────────────────────────────────────────────────────
setupWebSocket(wss, broadcastLiveList);

// ─── Admin overview (localhost only) ─────────────────────────────────────────
app.get('/api/admin/overview', (req, res) => {
  const remoteIp = req.socket.remoteAddress || '';
  if (!remoteIp.includes('127.0.0.1') && !remoteIp.includes('::1') && remoteIp !== '::ffff:127.0.0.1')
    return res.status(403).json({ error: 'forbidden' });

  const connectedDevices = [];
  for (const [deviceId, wsSet] of state.deviceClients) {
    if (!wsSet.size) continue;
    if (deviceId.startsWith('ghost-')) continue;
    const ips    = [...new Set([...wsSet].map(w => state.wsClientIps.get(w) || '').filter(Boolean))];
    const player = state.playerStateCache.get(deviceId) || null;
    const user   = state.spotifyUserCache.get(deviceId) || null;
    const radio  = state.radioNowPlaying.get(deviceId) || null;
    connectedDevices.push({
      deviceId, tabs: wsSet.size, ips,
      authenticated: !!(devices.get(deviceId)?.tokens?.access_token),
      user, radio,
      player: player ? {
        isPlaying: player.is_playing,
        track: player.item ? {
          name: player.item.name,
          artists: player.item.artists?.map(a => a.name).join(', '),
          album: player.item.album?.name,
          durationMs: player.item.duration_ms,
          progressMs: player.progress_ms,
          albumArt: player.item.album?.images?.[0]?.url || null,
        } : null,
        device: player.device ? {
          name: player.device.name, type: player.device.type,
          volume: player.device.volume_percent, isActive: player.device.is_active,
        } : null,
        repeatState: player.repeat_state, shuffleState: player.shuffle_state,
      } : null,
    });
  }

  const offlineDevices = [];
  for (const [deviceId, dev] of devices) {
    if (state.deviceClients.has(deviceId) && state.deviceClients.get(deviceId).size) continue;
    offlineDevices.push({ deviceId, authenticated: !!(dev?.tokens?.access_token) });
  }

  const cpus     = os.cpus();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  res.json({
    connectedDevices, offlineDevices,
    streamListeners: [...state.streamListeners.values()].map(e => ({ ...e, durationMs: Date.now() - e.connectedAt })),
    mse: { broadcasting: !!(state.mseBroadcaster?.readyState === WebSocket.OPEN), listenerCount: state.mseListeners.size },
    ffmpegRunning: ffmpegRunning(),
    system: {
      hostname: os.hostname(), uptime: Math.floor(os.uptime()),
      loadAvg: os.loadavg().map(l => +l.toFixed(2)),
      memPct: +((totalMem - freeMem) / totalMem * 100).toFixed(1),
      totalMem, freeMem,
      cpuModel: cpus[0]?.model?.trim() || 'Unknown', cpuCount: cpus.length,
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
mainServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${MAIN_PORT} is already in use. Another instance may be running.\n`);
    process.exit(1);
  }
  throw err;
});

mainServer.listen(MAIN_PORT, '0.0.0.0', () => {
  console.log(`\n  TemuTalk: ${MAIN_BASE}`);
  console.log(`  Redirect URI (add to Spotify app): ${REDIRECT_URI}\n`);
  console.log(`  ${devices.size} device(s) with stored tokens.\n`);
});
