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
const axios      = require('axios');
const https      = require('https');
const http       = require('http');
const WebSocket  = require('ws');
const selfsigned = require('selfsigned');
const crypto     = require('crypto');
const zlib       = require('zlib');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const { exec, spawn: spawnProc, execFileSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const MAIN_PORT    = parseInt(process.env.PORT || '3000', 10);
const WEATHER_CITY = process.env.WEATHER_CITY || 'London';

// ─── Network info ─────────────────────────────────────────────────────────────
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

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
const pkceStore = new Map();
function pkceVerifier()   { return crypto.randomBytes(32).toString('base64url'); }
function pkceChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

// ─── Per-device credentials ───────────────────────────────────────────────────
const deviceCredentials = new Map();

// ─── Per-device token store ───────────────────────────────────────────────────
const DEVICES_FILE = path.join(__dirname, 'devices.json');
function loadDevices() {
  try {
    const obj = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) {
      const { creds, ...rest } = v;
      map.set(k, rest);
      if (creds?.clientId) deviceCredentials.set(k, creds);
    }
    return map;
  } catch { return new Map(); }
}
function saveDevices() {
  const obj = {};
  for (const [k, v] of devices) {
    obj[k] = { ...v };
    const creds = deviceCredentials.get(k);
    if (creds) obj[k].creds = creds;
  }
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(obj, null, 2));
}
const devices = loadDevices();

function resolveDevice(req) {
  return req.query.device || req.headers['x-device-id'] || null;
}

async function getDeviceToken(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev?.tokens?.access_token) return null;
  if (Date.now() > dev.tokens.expires_at - 60_000) {
    const creds = deviceCredentials.get(deviceId);
    if (!creds) return null;
    try {
      const r = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: dev.tokens.refresh_token,
          client_id: creds.clientId,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      dev.tokens.access_token  = r.data.access_token;
      dev.tokens.expires_at    = Date.now() + r.data.expires_in * 1000;
      if (r.data.refresh_token) dev.tokens.refresh_token = r.data.refresh_token;
      saveDevices();
    } catch (e) {
      console.error(`[device:${deviceId}] Token refresh failed:`, e.response?.data?.error || e.message);
      dev.tokens.access_token = null;
      saveDevices();
      return null;
    }
  }
  return dev.tokens.access_token;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════════
const app        = express();
const mainServer = https.createServer(tlsOpts, app);
const wss        = new WebSocket.Server({ server: mainServer });

// Redirect broadcast subdomain to /broadcast page
app.use((req, res, next) => {
  if (req.hostname === 'broadcast.codecade.co.za' && req.path === '/') return res.redirect('/broadcast');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Control panel proxy (/panel → localhost:PORT+1) ─────────────────────────
app.use('/panel', (req, res) => {
  const panelPort = parseInt(process.env.PANEL_PORT || '9090', 10) + 1;
  // express.json() has already consumed the body — re-serialize it for the proxy
  const bodyBuf = req.body && Object.keys(req.body).length
    ? Buffer.from(JSON.stringify(req.body))
    : null;
  const headers = { ...req.headers, 'x-panel-base': '/panel', host: 'localhost' };
  if (bodyBuf) {
    headers['content-type']   = 'application/json';
    headers['content-length'] = bodyBuf.length;
  }
  const opts = {
    hostname: '127.0.0.1', port: panelPort,
    path: req.url || '/', method: req.method, headers,
  };
  const proxy = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  proxy.on('error', () => res.status(502).send('Control panel offline'));
  if (bodyBuf) { proxy.end(bodyBuf); } else { proxy.end(); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js'))
      res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ─── App config ───────────────────────────────────────────────────────────────
app.get('/api/auth-info', (req, res) => {
  res.json({ redirectUri: REDIRECT_URI });
});

app.get('/api/config', (req, res) => {
  const deviceId = resolveDevice(req);
  const dev = deviceId ? devices.get(deviceId) : null;
  res.json({ weatherCity: WEATHER_CITY, authenticated: !!(dev?.tokens?.access_token) });
});

app.get('/api/status', (req, res) => {
  const deviceId = resolveDevice(req);
  const dev = deviceId ? devices.get(deviceId) : null;
  res.json({ authenticated: !!(dev?.tokens?.access_token) });
});

// ─── Spotify OAuth ─────────────────────────────────────────────────────────────
const SCOPES = [
  'streaming','user-read-email','user-read-private',
  'user-read-currently-playing','user-read-playback-state',
  'user-modify-playback-state','user-read-recently-played',
  'user-top-read','user-library-read','user-library-modify',
  'playlist-read-private','playlist-read-collaborative','user-follow-read',
].join(' ');

app.get('/auth/spotify', (req, res) => {
  const { device: deviceId, cid: clientId, csec: clientSecret } = req.query;
  if (!deviceId)                   return res.status(400).send('device id required');
  if (!clientId || !clientSecret)  return res.status(400).send('Spotify Client ID and Client Secret required');
  const redirectUri = REDIRECT_URI;
  const verifier  = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state     = crypto.randomBytes(16).toString('hex');
  pkceStore.set(state, { deviceId, verifier, clientId, clientSecret, redirectUri });
  setTimeout(() => pkceStore.delete(state), 5 * 60 * 1000);
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES,
    redirect_uri: redirectUri, code_challenge_method: 'S256',
    code_challenge: challenge, state,
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  const entry = pkceStore.get(state);
  pkceStore.delete(state);
  if (!entry) return res.redirect('/?error=state_mismatch');
  try {
    const r = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: entry.redirectUri || REDIRECT_URI, client_id: entry.clientId,
        code_verifier: entry.verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!devices.has(entry.deviceId)) devices.set(entry.deviceId, {});
    const dev = devices.get(entry.deviceId);
    dev.tokens = {
      access_token:  r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at:    Date.now() + r.data.expires_in * 1000,
    };
    deviceCredentials.set(entry.deviceId, { clientId: entry.clientId, clientSecret: entry.clientSecret });
    saveDevices();
    broadcastToDevice(entry.deviceId, { type: 'status', authenticated: true });
    res.redirect('/');
  } catch (e) {
    console.error('OAuth callback error:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ─── Spotify Player API ───────────────────────────────────────────────────────
app.get('/api/player', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, active: r.status !== 204, ...(r.status !== 204 ? r.data : {}) });
  } catch (e) {
    if (e.response?.status === 401) { devices.get(deviceId).tokens.access_token = null; return res.json({ authenticated: false }); }
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/recently-played', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.json({ authenticated: false, items: [] });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false, items: [] });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/player/recently-played?limit=50', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, items: r.data.items });
  } catch (e) { res.status(500).json({ error: e.message, items: [] }); }
});

app.post('/api/player/:action', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const map = {
    play:     ['put',  'https://api.spotify.com/v1/me/player/play'],
    pause:    ['put',  'https://api.spotify.com/v1/me/player/pause'],
    next:     ['post', 'https://api.spotify.com/v1/me/player/next'],
    previous: ['post', 'https://api.spotify.com/v1/me/player/previous'],
  };
  const [method, url] = map[req.params.action] || [];
  if (!method) return res.status(400).json({ error: 'Unknown action' });
  try {
    await axios[method](url, {}, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) {
    if (e.response?.status === 404 && req.params.action === 'play') {
      try {
        const spDeviceId = await activateDevice(token);
        if (!spDeviceId) return res.status(404).json({ error: 'No Spotify devices available.' });
        await axios.put(`https://api.spotify.com/v1/me/player/play?device_id=${spDeviceId}`, {}, { headers: { Authorization: `Bearer ${token}` } });
        res.json({ ok: true });
      } catch (e2) { res.status(500).json({ error: e2.response?.data?.error?.message || e2.message }); }
    } else {
      res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
    }
  }
});

app.post('/api/player/seek', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const ms = parseInt(req.query.ms, 10);
  if (isNaN(ms)) return res.status(400).json({ error: 'Invalid position' });
  try {
    await axios.put(`https://api.spotify.com/v1/me/player/seek?position_ms=${ms}`, {}, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/player/volume', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const vol = parseInt(req.body.volume, 10);
  if (isNaN(vol) || vol < 0 || vol > 100) return res.status(400).json({ error: 'Invalid volume' });
  try {
    await axios.put(`https://api.spotify.com/v1/me/player/volume?volume_percent=${vol}`, {}, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.put('/api/player/shuffle', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await axios.put(`https://api.spotify.com/v1/me/player/shuffle?state=${!!req.body.state}`, {}, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/player/repeat', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const state = req.body.state;
  if (!['off','track','context'].includes(state)) return res.status(400).json({ error: 'Invalid state' });
  try {
    await axios.put(`https://api.spotify.com/v1/me/player/repeat?state=${state}`, {}, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: { items: [] }, artists: { items: [] }, albums: { items: [] }, playlists: { items: [] } });
  try {
    const r = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track,artist,album,playlist&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/playlists', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/playlists?limit=50', { headers: { Authorization: `Bearer ${token}` } });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/playlist/:id', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get(
      `https://api.spotify.com/v1/playlists/${req.params.id}?fields=id,name,description,images,owner,tracks.total,uri`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/playlist/:id/tracks', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get(
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=50&fields=items(track(id,name,duration_ms,artists,album(images,name),uri)),next`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/artists', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/following?type=artist&limit=50', { headers: { Authorization: `Bearer ${token}` } });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/artist/:id', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const [artist, topTracks, albums] = await Promise.all([
      axios.get(`https://api.spotify.com/v1/artists/${req.params.id}`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`https://api.spotify.com/v1/artists/${req.params.id}/top-tracks?market=from_token`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`https://api.spotify.com/v1/artists/${req.params.id}/albums?include_groups=album,single&limit=20&market=from_token`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    res.json({ artist: artist.data, topTracks: topTracks.data.tracks, albums: albums.data.items });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/album/:id', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const [album, tracks] = await Promise.all([
      axios.get(`https://api.spotify.com/v1/albums/${req.params.id}`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`https://api.spotify.com/v1/albums/${req.params.id}/tracks?limit=50`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    res.json({ ...album.data, tracks: tracks.data });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

async function transferAndPlay(token, playBody, spDeviceId) {
  const url = spDeviceId
    ? `https://api.spotify.com/v1/me/player/play?device_id=${spDeviceId}`
    : 'https://api.spotify.com/v1/me/player/play';
  return axios.put(url, playBody, { headers: { Authorization: `Bearer ${token}` } });
}

function launchSpotify() {
  const p   = os.platform();
  const cmd = p === 'win32'  ? 'start "" "spotify:"' :
              p === 'darwin' ? 'open -a Spotify' :
                               'spotify || flatpak run com.spotify.Client || snap run spotify';
  return new Promise(resolve => exec(cmd, err => {
    if (err) console.error('[Spotify] launch error:', err.message);
    resolve();
  }));
}

async function activateDevice(token) {
  let r = await axios.get('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: `Bearer ${token}` } });
  let devList = r.data.devices || [];
  if (!devList.length) {
    console.log('[Spotify] No active devices — launching Spotify on host...');
    await launchSpotify();
    for (let i = 0; i < 5; i++) {
      await new Promise(res => setTimeout(res, 2000));
      r = await axios.get('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: `Bearer ${token}` } });
      devList = r.data.devices || [];
      if (devList.length) break;
    }
  }
  if (!devList.length) return null;
  const localName = os.hostname().toLowerCase();
  const device = devList.find(d => d.name.toLowerCase() === localName && !d.is_restricted)
              || devList.find(d => !d.is_restricted)
              || devList[0];
  await axios.put('https://api.spotify.com/v1/me/player', { device_ids: [device.id], play: false }, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise(res => setTimeout(res, 700));
  return device.id;
}

app.put('/api/play-context', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const body = {};
  if (req.body.context_uri)    body.context_uri = req.body.context_uri;
  if (req.body.uris)           body.uris        = req.body.uris;
  if (req.body.offset != null) body.offset      = req.body.offset;
  try {
    await transferAndPlay(token, body, null);
    res.json({ ok: true });
  } catch (e) {
    if (e.response?.status === 404) {
      try {
        const spDeviceId = await activateDevice(token);
        if (!spDeviceId) return res.status(404).json({ error: 'No Spotify devices available. Open Spotify on a device.' });
        await transferAndPlay(token, body, spDeviceId);
        res.json({ ok: true });
      } catch (e2) { res.status(500).json({ error: e2.response?.data?.error?.message || e2.message }); }
    } else {
      res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
    }
  }
});

app.get('/api/token', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  res.json({ token });
});

app.get('/api/devices', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false, devices: [] });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ devices: r.data.devices || [] });
  } catch (e) { res.status(500).json({ error: e.message, devices: [] }); }
});

app.put('/api/transfer', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    await axios.put('https://api.spotify.com/v1/me/player', { device_ids: [device_id], play: true }, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.post('/api/save-creds', (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'credentials required' });
  const dev = devices.get(deviceId);
  if (!dev?.tokens?.access_token) return res.status(404).json({ error: 'not authenticated' });
  deviceCredentials.set(deviceId, { clientId, clientSecret });
  saveDevices();
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, ...r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, ...r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/top-tracks', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  const range = ['short_term','medium_term','long_term'].includes(req.query.range) ? req.query.range : 'medium_term';
  try {
    const r = await axios.get(`https://api.spotify.com/v1/me/top/tracks?limit=20&time_range=${range}`, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, items: r.data.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/top-artists', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  const range = ['short_term','medium_term','long_term'].includes(req.query.range) ? req.query.range : 'medium_term';
  try {
    const r = await axios.get(`https://api.spotify.com/v1/me/top/artists?limit=10&time_range=${range}`, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, items: r.data.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/new-releases', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  try {
    const r = await axios.get('https://api.spotify.com/v1/browse/new-releases?limit=10', { headers: { Authorization: `Bearer ${token}` } });
    res.json({ authenticated: true, albums: r.data.albums.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/like-status', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.json({ authenticated: false });
  const ids = (req.query.ids || '').trim();
  if (!ids) return res.json([]);
  try {
    const r = await axios.get(`https://api.spotify.com/v1/me/tracks/contains?ids=${ids}`, { headers: { Authorization: `Bearer ${token}` } });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/like', async (req, res) => {
  const deviceId = resolveDevice(req);
  if (!deviceId) return res.status(400).json({ error: 'device id required' });
  const token = await getDeviceToken(deviceId);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { id, liked } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    if (liked) await axios.put(`https://api.spotify.com/v1/me/tracks?ids=${id}`, {}, { headers: { Authorization: `Bearer ${token}` } });
    else       await axios.delete(`https://api.spotify.com/v1/me/tracks?ids=${id}`, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Map tile proxy (LRU cache) ───────────────────────────────────────────────
const TILE_STYLES    = new Set(['dark_nolabels', 'dark_only_labels', 'dark_all']);
const TILE_CACHE_MAX = 8000;
const tileCache      = new Map();

function tileGet(key)        { const v = tileCache.get(key); if (v) { tileCache.delete(key); tileCache.set(key, v); } return v; }
function tileSet(key, buf)   { if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value); tileCache.set(key, buf); }

app.get('/api/tiles/:style/:z/:x/:y', async (req, res) => {
  const { style, z, x, y } = req.params;
  if (!TILE_STYLES.has(style))      return res.status(400).end();
  if (!/^\d+$/.test(z + x + y))    return res.status(400).end();
  const key = `${style}/${z}/${x}/${y}`;
  const cached = tileGet(key);
  if (cached) {
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
    return res.send(cached);
  }
  const sub = 'abcd'[(Math.abs(parseInt(x, 10)) + Math.abs(parseInt(y, 10))) % 4];
  const url = `https://${sub}.basemaps.cartocdn.com/${style}/${z}/${x}/${y}.png`;
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': 'TemuTalk/1.0' } });
    const buf = Buffer.from(r.data);
    tileSet(key, buf);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
    res.send(buf);
  } catch { res.status(404).end(); }
});

// ─── Radio cache ──────────────────────────────────────────────────────────────
const mapStation = s => ({
  stationuuid:  s.stationuuid,
  name:         s.name,
  url_resolved: s.url_resolved,
  favicon:      s.favicon,
  country:      s.country,
  countrycode:  s.countrycode,
  tags:         s.tags,
  votes:        s.votes,
  bitrate:      s.bitrate,
  geo_lat:  s.geo_lat  ? parseFloat(s.geo_lat)  : null,
  geo_long: s.geo_long ? parseFloat(s.geo_long) : null,
});

const RADIO_CACHE_TTL = 6 * 60 * 60 * 1000;
let radioCache        = [];
let radioCacheGeoGzip = null;   // pre-gzipped geo-only JSON for /api/radio/geo
let radioCacheTs      = 0;
let radioFetchPromise = null;

async function refreshRadioCache() {
  if (radioFetchPromise) return radioFetchPromise;
  radioFetchPromise = (async () => {
    const stations = [];
    let offset = 0;
    // 2000 per API call = 10 requests for 20k stations (vs 200 requests at 100 each)
    const PAGE = 2000;
    const CAP  = 20000;
    while (stations.length < CAP) {
      const limit = Math.min(PAGE, CAP - stations.length);
      const params = new URLSearchParams({
        hidebroken: 'true', order: 'votes', reverse: 'true',
        limit: String(limit), offset: String(offset),
      });
      const r = await axios.get(
        `http://all.api.radio-browser.info/json/stations/search?${params}`,
        { headers: { 'User-Agent': 'TemuTalk/1.0' }, timeout: 30000 }
      );
      const page = (r.data || []).map(mapStation);
      if (!page.length) break;
      stations.push(...page);
      if (page.length < limit) break;
      offset += page.length;
    }
    radioCache   = stations;
    radioCacheTs = Date.now();
    console.log(`[radio] cached ${stations.length} stations`);

    // Pre-build gzipped geo payload for the fast map endpoint
    const geo = stations.filter(s => s.geo_lat && s.geo_long);
    zlib.gzip(Buffer.from(JSON.stringify(geo)), { level: 6 }, (err, buf) => {
      if (!err) { radioCacheGeoGzip = buf; console.log(`[radio] geo cache: ${geo.length} stations, ${(buf.length/1024).toFixed(0)} KB gzipped`); }
    });
  })()
    .catch(e => console.error('[radio] prefetch failed:', e.message))
    .finally(() => { radioFetchPromise = null; });
  return radioFetchPromise;
}

// Warm cache at startup
refreshRadioCache();

// Fast map endpoint — single gzipped JSON response, no streaming
app.get('/api/radio/geo', (req, res) => {
  if (!radioCacheGeoGzip) {
    return res.status(503).json({ error: 'cache warming, try again shortly' });
  }
  res.set({
    'Content-Type':     'application/json',
    'Content-Encoding': 'gzip',
    'Cache-Control':    'public, max-age=3600',
  });
  res.send(radioCacheGeoGzip);
});

// Full list endpoint — SSE stream from cache
app.get('/api/radio', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  if (!radioCache.length || Date.now() - radioCacheTs > RADIO_CACHE_TTL) {
    if (!radioCache.length) {
      await refreshRadioCache();
    } else {
      refreshRadioCache(); // stale — refresh in background, serve stale now
    }
  }

  const SEND = 500;
  for (let i = 0; i < radioCache.length; i += SEND) {
    if (res.destroyed) break;
    res.write(`data: ${JSON.stringify(radioCache.slice(i, i + SEND))}\n\n`);
  }
  res.write('event: done\ndata: {}\n\n');
  res.end();
});

// ─── Radio stream proxy (avoids mixed-content HTTPS→HTTP block) ───────────────
app.get('/api/radio/proxy', (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).end();
  const mod = url.startsWith('https') ? require('https') : http;
  const upstream = mod.get(url, { headers: { 'User-Agent': 'TemuTalk/1.0', 'Icy-MetaData': '0' }, timeout: 10000 }, up => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      res.redirect('/api/radio/proxy?url=' + encodeURIComponent(up.headers.location));
      up.destroy(); return;
    }
    res.writeHead(200, {
      'Content-Type': up.headers['content-type'] || 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Transfer-Encoding': 'chunked',
    });
    up.pipe(res);
    req.on('close', () => up.destroy());
  });
  upstream.on('error', () => res.status(502).end());
  upstream.setTimeout(10000, () => { upstream.destroy(); res.status(504).end(); });
});

// ─── Lyrics ───────────────────────────────────────────────────────────────────
app.get('/api/lyrics', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  const track  = (req.query.track  || '').trim();
  const album  = (req.query.album  || '').trim();
  if (!artist || !track) return res.status(400).json({ error: 'artist and track required' });
  try {
    const params = { artist_name: artist, track_name: track };
    if (album) params.album_name = album;
    const r = await axios.get('https://lrclib.net/api/get', { params, timeout: 8000 });
    const d = r.data;
    if (d.syncedLyrics) return res.json({ lyrics: d.plainLyrics || null, synced: d.syncedLyrics });
    if (d.plainLyrics)  return res.json({ lyrics: d.plainLyrics, synced: null });
    return res.json({ lyrics: null, synced: null });
  } catch { res.json({ lyrics: null, synced: null }); }
});

// ─── Crypto ───────────────────────────────────────────────────────────────────
app.get('/api/crypto', async (req, res) => {
  const ids = (req.query.ids || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,avalanche-2,polkadot,chainlink').replace(/[^a-z0-9,\-]/g, '');
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency: 'usd', ids, order: 'market_cap_desc', per_page: 20, page: 1, sparkline: false, price_change_percentage: '24h' },
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── System info ──────────────────────────────────────────────────────────────
app.get('/api/system', (req, res) => {
  const cpus     = os.cpus();
  const load     = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const procMem  = process.memoryUsage();
  const netList  = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const addr of (addrs || []))
      if (!addr.internal && addr.family === 'IPv4') netList.push({ name, address: addr.address, mac: addr.mac });
  res.json({
    platform: os.platform(), arch: os.arch(), hostname: os.hostname(),
    uptime: Math.floor(os.uptime()), procUptime: Math.floor(process.uptime()),
    cpuModel: cpus[0]?.model?.trim() || 'Unknown', cpuCount: cpus.length,
    cpuSpeed: cpus[0]?.speed ? (cpus[0].speed / 1000).toFixed(2) + ' GHz' : 'N/A',
    loadAvg: load.map(l => +l.toFixed(2)),
    totalMem, freeMem, usedMem, memPct: +(usedMem / totalMem * 100).toFixed(1),
    heapUsed: procMem.heapUsed, heapTotal: procMem.heapTotal, rss: procMem.rss,
    nodeVersion: process.version, pid: process.pid, network: netList,
  });
});

// ─── Weather ──────────────────────────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const city = (req.query.city || WEATHER_CITY).trim();
  try {
    const r = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { headers: { 'User-Agent': 'GoogleHomeHub/1.0' }, timeout: 10000 });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Icecast stream proxy ─────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const entry = { ip, ua: req.headers['user-agent'] || '', connectedAt: Date.now() };
  streamListeners.set(res, entry);
  const proxy = http.get('http://localhost:8000/stream', iceRes => {
    res.writeHead(iceRes.statusCode, {
      'Content-Type':              iceRes.headers['content-type'] || 'audio/mpeg',
      'Cache-Control':             'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    iceRes.pipe(res);
    const cleanup = () => { streamListeners.delete(res); iceRes.destroy(); };
    req.on('close', cleanup);
    res.on('finish', cleanup);
  });
  proxy.on('error', () => { streamListeners.delete(res); res.status(503).end(); });
});

// ─── ffmpeg → Icecast broadcast management ────────────────────────────────────
let ffmpegProc = null;

function getPulseMonitor() {
  const uid = process.getuid ? process.getuid() : 1000;
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
  // PipeWire/PulseAudio require XDG_RUNTIME_DIR — systemd services don't inherit it
  const uid = process.getuid ? process.getuid() : 1000;
  const xdgDir = `/run/user/${uid}`;
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || xdgDir,
    PULSE_SERVER:    process.env.PULSE_SERVER    || `unix:${xdgDir}/pulse/native`,
  };
  ffmpegProc = spawnProc('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  ffmpegProc.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim().split('\n').pop()));
  ffmpegProc.on('close', code => {
    console.log(`[ffmpeg] exited ${code}`);
    ffmpegProc = null;
  });
  ffmpegProc.on('error', err => {
    console.error(`[ffmpeg] error: ${err.message}`);
    ffmpegProc = null;
  });
  return { ok: true, source };
}

function stopFfmpeg() {
  if (!ffmpegProc) return { ok: false, error: 'not running' };
  ffmpegProc.kill('SIGTERM');
  ffmpegProc = null;
  return { ok: true };
}

app.get('/api/broadcast/status', (req, res) => {
  res.json({ running: !!ffmpegProc, pid: ffmpegProc?.pid ?? null });
});

app.post('/api/broadcast/start', (req, res) => {
  res.json(startFfmpeg());
});

app.post('/api/broadcast/stop', (req, res) => {
  res.json(stopFfmpeg());
});

// ─── Broadcast control page ───────────────────────────────────────────────────
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

    let playerRunning = false;
    const volRow = document.getElementById('vol-row');
    document.getElementById('vol').oninput = function(){ player.volume = this.value; };
    function startPlayer() {
      if(playerRunning) return;
      playerRunning = true;
      player.src = '/stream?t=' + Date.now();
      player.style.display = 'none';
      volRow.style.display = 'block';
      player.play().catch(()=>{});
    }
    function stopPlayer() {
      playerRunning = false;
      player.pause();
      player.src = '';
      volRow.style.display = 'none';
    }
    // Reconnect on stall/error without resetting to 1s
    function reconnect() {
      if(!playerRunning) return;
      player.pause();
      player.src = '/stream?t=' + Date.now();
      player.load();
      player.play().catch(()=>{});
    }
    player.addEventListener('error', () => setTimeout(reconnect, 1000));
    player.addEventListener('stalled', () => setTimeout(reconnect, 2000));
    player.addEventListener('ended', reconnect);

    function setUI(running, msg) {
      dot.className='dot '+(running?'live':'off');
      stxt.textContent=msg;
      btnStart.style.display=running?'none':'block';
      btnStop.style.display=running?'block':'none';
      if(running) startPlayer(); else stopPlayer();
    }

    async function checkStatus() {
      try {
        const res=await fetch('/api/broadcast/status');
        if(!res.ok) throw new Error('HTTP '+res.status);
        const r=await res.json();
        setUI(r.running, r.running ? 'Live - streaming via ffmpeg (PID '+r.pid+')' : 'Idle - not streaming');
      } catch(e) { dot.className='dot warn'; stxt.textContent='Server error: '+e.message; }
    }

    btnStart.onclick = async () => {
      btnStart.disabled=true;
      dot.className='dot warn'; stxt.textContent='Starting ffmpeg...';
      try {
        const res=await fetch('/api/broadcast/start',{method:'POST'});
        const r=await res.json();
        if(r.ok) setTimeout(checkStatus, 1500);
        else { stxt.textContent='Failed: '+(r.error||'unknown'); btnStart.disabled=false; }
      } catch(e) { stxt.textContent='Error: '+e.message; btnStart.disabled=false; }
    };

    btnStop.onclick = async () => {
      btnStop.disabled=true;
      await fetch('/api/broadcast/stop',{method:'POST'}).catch(()=>{});
      setTimeout(checkStatus, 500);
    };

    checkStatus();
    setInterval(checkStatus, 5000);
  </script>
</body>
</html>`);
});

// ─── WebSocket (per-device rooms + MSE audio relay) ───────────────────────────
const deviceClients    = new Map();
let   mseBroadcaster   = null;
let   mseMimeType      = null;
let   mseInitChunk     = null;
const mseListeners     = new Set();
const streamListeners  = new Map();   // res → { ip, ua, connectedAt }
const wsClientIps      = new WeakMap(); // ws → ip string
const radioNowPlaying  = new Map();   // deviceId → { name, url, since }
const playerStateCache = new Map();   // deviceId → playerData
const spotifyUserCache = new Map();   // deviceId → { displayName, email, product }

function relayToClients(str) {
  for (const [, conns] of deviceClients)
    for (const c of conns)
      if (c !== mseBroadcaster && c.readyState === WebSocket.OPEN) c.send(str);
}

function broadcastListenerCount() {
  if (mseBroadcaster?.readyState === WebSocket.OPEN)
    mseBroadcaster.send(JSON.stringify({ type: 'mse-listener-count', count: mseListeners.size }));
}

wss.on('connection', (ws, req) => {
  const wsIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  wsClientIps.set(ws, wsIp);
  let wsDeviceId = null;

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (ws === mseBroadcaster) {
        if (!mseInitChunk) {
          mseInitChunk = Buffer.from(raw);
          console.log('[mse] init chunk saved, size:', mseInitChunk.length);
        }
        for (const c of mseListeners) if (c.readyState === WebSocket.OPEN) c.send(raw);
      }
      return;
    }
    const str = raw.toString();
    let msg;
    try { msg = JSON.parse(str); } catch { return; }

    if (msg.type === 'join') {
      wsDeviceId = msg.deviceId;
      if (!deviceClients.has(wsDeviceId)) deviceClients.set(wsDeviceId, new Set());
      deviceClients.get(wsDeviceId).add(ws);
      const dev = devices.get(wsDeviceId);
      ws.send(JSON.stringify({ type: 'status', authenticated: !!(dev?.tokens?.access_token) }));
      ws.send(JSON.stringify({ type: 'mse-broadcaster-status', online: !!(mseBroadcaster?.readyState === WebSocket.OPEN), mimeType: mseMimeType }));
      return;
    }

    if (msg.type === 'mse-broadcaster-ready') {
      mseBroadcaster = ws;
      mseMimeType = msg.mimeType;
      mseInitChunk = null;
      console.log('[mse] broadcaster connected, mime:', mseMimeType);
      relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: true, mimeType: mseMimeType }));
      return;
    }

    if (msg.type === 'mse-broadcaster-leave') {
      relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: false }));
      return;
    }

    if (msg.type === 'mse-listener-join') {
      mseListeners.add(ws);
      console.log('[mse] listener joined, total:', mseListeners.size);
      if (mseInitChunk) ws.send(mseInitChunk);
      broadcastListenerCount();
      return;
    }

    if (msg.type === 'mse-listener-leave') {
      mseListeners.delete(ws);
      broadcastListenerCount();
      return;
    }

    if (msg.type === 'host-play-radio' || msg.type === 'host-stop-radio') {
      if (mseBroadcaster?.readyState === WebSocket.OPEN) mseBroadcaster.send(str);
      return;
    }

    if (msg.type === 'radio-now-playing' && wsDeviceId) {
      radioNowPlaying.set(wsDeviceId, { name: msg.name || '', url: msg.url || '', since: Date.now() });
      return;
    }
    if (msg.type === 'radio-stopped' && wsDeviceId) {
      radioNowPlaying.delete(wsDeviceId);
      return;
    }
  });

  const cleanup = () => {
    if (wsDeviceId) {
      deviceClients.get(wsDeviceId)?.delete(ws);
      if (!deviceClients.get(wsDeviceId)?.size) radioNowPlaying.delete(wsDeviceId);
    }
    if (ws === mseBroadcaster) {
      mseBroadcaster = null;
      mseInitChunk   = null;
      console.log('[mse] broadcaster disconnected');
      relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: false }));
    }
    if (mseListeners.delete(ws)) broadcastListenerCount();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

function broadcastToDevice(deviceId, data) {
  const msg = JSON.stringify(data);
  for (const ws of deviceClients.get(deviceId) || [])
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

async function pushAllDeviceStates() {
  for (const [deviceId] of deviceClients) {
    if (!deviceClients.get(deviceId)?.size) continue;
    const token = await getDeviceToken(deviceId);
    if (!token) { broadcastToDevice(deviceId, { type: 'player', authenticated: false }); continue; }
    try {
      const [playerRes, userRes] = await Promise.allSettled([
        axios.get('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }),
        spotifyUserCache.has(deviceId) ? Promise.resolve(null) :
          axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (playerRes.status === 'fulfilled') {
        const r = playerRes.value;
        const data = { type: 'player', authenticated: true, active: r.status !== 204, ...(r.status !== 204 ? r.data : {}) };
        broadcastToDevice(deviceId, data);
        playerStateCache.set(deviceId, data);
      }
      if (userRes.status === 'fulfilled' && userRes.value) {
        const u = userRes.value.data;
        spotifyUserCache.set(deviceId, { displayName: u.display_name, email: u.email, product: u.product, country: u.country });
      }
    } catch (_) {}
  }
}
setInterval(pushAllDeviceStates, 3000);

// ─── Admin overview (localhost only — called by control-panel.js) ─────────────
app.get('/api/admin/overview', (req, res) => {
  const remoteIp = req.socket.remoteAddress || '';
  if (!remoteIp.includes('127.0.0.1') && !remoteIp.includes('::1') && remoteIp !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const connectedDevices = [];
  for (const [deviceId, wsSet] of deviceClients) {
    if (!wsSet.size) continue;
    const ips = [...new Set([...wsSet].map(w => wsClientIps.get(w) || '').filter(Boolean))];
    const player = playerStateCache.get(deviceId) || null;
    const user   = spotifyUserCache.get(deviceId) || null;
    const radio  = radioNowPlaying.get(deviceId) || null;
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
          name: player.device.name,
          type: player.device.type,
          volume: player.device.volume_percent,
          isActive: player.device.is_active,
        } : null,
        repeatState: player.repeat_state,
        shuffleState: player.shuffle_state,
      } : null,
    });
  }

  const offlineDevices = [];
  for (const [deviceId, dev] of devices) {
    if (deviceClients.has(deviceId) && deviceClients.get(deviceId).size) continue;
    offlineDevices.push({ deviceId, authenticated: !!(dev?.tokens?.access_token) });
  }

  const cpus = os.cpus();
  const totalMem = os.totalmem(), freeMem = os.freemem();
  res.json({
    connectedDevices,
    offlineDevices,
    streamListeners: [...streamListeners.values()].map(e => ({ ...e, durationMs: Date.now() - e.connectedAt })),
    mse: { broadcasting: !!(mseBroadcaster?.readyState === WebSocket.OPEN), listenerCount: mseListeners.size },
    ffmpegRunning: !!ffmpegProc,
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
