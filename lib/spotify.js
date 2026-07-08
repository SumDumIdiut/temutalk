// Spotify OAuth + Player API routes + periodic player state push.

const axios  = require('axios');
const crypto = require('crypto');
const os     = require('os');
const { exec } = require('child_process');

const state   = require('./state');
const { devices, deviceCredentials, saveDevices, resolveDevice, getDeviceToken } = require('./devices');
const { broadcastToDevice } = require('./broadcast');

const SCOPES = [
  'streaming','user-read-email','user-read-private',
  'user-read-currently-playing','user-read-playback-state',
  'user-modify-playback-state','user-read-recently-played',
  'user-top-read','user-library-read','user-library-modify',
  'playlist-read-private','playlist-read-collaborative','user-follow-read',
  'playlist-modify-public','playlist-modify-private',
].join(' ');

const pkceStore = new Map();
function pkceVerifier()   { return crypto.randomBytes(32).toString('base64url'); }
function pkceChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Periodic player state push ───────────────────────────────────────────────
async function pushAllDeviceStates() {
  for (const [deviceId] of state.deviceClients) {
    if (!state.deviceClients.get(deviceId)?.size) continue;
    const token = await getDeviceToken(deviceId);
    if (!token) { broadcastToDevice(deviceId, { type: 'player', authenticated: false }); continue; }
    try {
      const [playerRes, userRes] = await Promise.allSettled([
        axios.get('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }),
        state.spotifyUserCache.has(deviceId) ? Promise.resolve(null) :
          axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (playerRes.status === 'fulfilled') {
        const r = playerRes.value;
        const data = { type: 'player', authenticated: true, active: r.status !== 204, ...(r.status !== 204 ? r.data : {}) };
        broadcastToDevice(deviceId, data);
        state.playerStateCache.set(deviceId, data);
      }
      if (userRes.status === 'fulfilled' && userRes.value) {
        const u = userRes.value.data;
        state.spotifyUserCache.set(deviceId, { displayName: u.display_name, email: u.email, product: u.product, country: u.country, avatarUrl: u.images?.[0]?.url || null });
      }
    } catch (_) {}
  }
}
setInterval(pushAllDeviceStates, 3000);

// ─── Routes ───────────────────────────────────────────────────────────────────
module.exports = function setupSpotifyRoutes(app, REDIRECT_URI, MAIN_BASE) {

  app.get('/auth/spotify', (req, res) => {
    const { device: deviceId, cid: clientId, csec: clientSecret } = req.query;
    if (!deviceId)                  return res.status(400).send('device id required');
    if (!clientId || !clientSecret) return res.status(400).send('Spotify Client ID and Client Secret required');
    const verifier  = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    const state2    = crypto.randomBytes(16).toString('hex');
    pkceStore.set(state2, { deviceId, verifier, clientId, clientSecret, redirectUri: REDIRECT_URI });
    setTimeout(() => pkceStore.delete(state2), 5 * 60 * 1000);
    const params = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: SCOPES,
      redirect_uri: REDIRECT_URI, code_challenge_method: 'S256',
      code_challenge: challenge, state: state2,
    });
    res.redirect('https://accounts.spotify.com/authorize?' + params);
  });

  app.get('/callback', async (req, res) => {
    const { code, error, state: stateParam } = req.query;
    if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
    const entry = pkceStore.get(stateParam);
    pkceStore.delete(stateParam);
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
    const repeatState = req.body.state;
    if (!['off','track','context'].includes(repeatState)) return res.status(400).json({ error: 'Invalid state' });
    try {
      await axios.put(`https://api.spotify.com/v1/me/player/repeat?state=${repeatState}`, {}, { headers: { Authorization: `Bearer ${token}` } });
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

  app.post('/api/playlist/:id/tracks', async (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).json({ error: 'device id required' });
    const token = await getDeviceToken(deviceId);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    try {
      await axios.post(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks`, { uris: [uri] }, { headers: { Authorization: `Bearer ${token}` } });
      res.json({ ok: true });
    } catch (e) { res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message }); }
  });

  app.delete('/api/playlist/:id/tracks', async (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).json({ error: 'device id required' });
    const token = await getDeviceToken(deviceId);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'uri required' });
    try {
      await axios.delete(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { tracks: [{ uri }] },
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message }); }
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
    const { device_id, play } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    try {
      // Callers that omit `play` want the old default (start playback);
      // the SDK-ready handler passes `play:false` explicitly and needs that
      // honored, or every reconnect force-resumes/restarts audio on this
      // device out from under whatever was already playing.
      await axios.put('https://api.spotify.com/v1/me/player', { device_ids: [device_id], play: play !== false }, { headers: { Authorization: `Bearer ${token}` } });
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

  // Spotify SDK proxy — bypasses browser tracking protection on sdk.scdn.co
  async function spotifySdkProxy(sdkPath, res) {
    try {
      const r = await axios.get('https://sdk.scdn.co/' + sdkPath, { responseType: 'arraybuffer', timeout: 10000, headers: { 'Accept-Encoding': 'identity' } });
      const ct = (r.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
      const isText = ['text/html','text/javascript','application/javascript','text/css'].includes(ct);
      res.setHeader('Content-Type', r.headers['content-type'] || ct);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('CDN-Cache-Control', 'no-store');
      if (isText) {
        let text = Buffer.from(r.data).toString('utf-8');
        text = text.replace(/https:\/\/sdk\.scdn\.co\//g, MAIN_BASE + '/sp/');
        if (sdkPath === 'embedded/index.html') {
          text = text.replace('</head>', `<script>
window.onerror=function(m,s,l,c,e){parent.postMessage({type:'SP_DEBUG',msg:'onerror: '+m,src:s,line:l,err:String(e)},'*');return false;};
window.addEventListener('unhandledrejection',function(e){parent.postMessage({type:'SP_DEBUG',msg:'unhandledrejection: '+String(e.reason)},'*');});
window.addEventListener('DOMContentLoaded',function(){parent.postMessage({type:'SP_DEBUG',msg:'iframe DOMContentLoaded'},'*');});
window.addEventListener('load',function(){parent.postMessage({type:'SP_DEBUG',msg:'iframe load event'},'*');});
</script></head>`);
        }
        if (sdkPath === 'embedded/index.js') {
          text = `try{\n${text}\n}catch(e){parent.postMessage({type:'SP_DEBUG',msg:'index.js threw: '+String(e)+(e&&e.stack?' '+e.stack:'')},'*');}`;
        }
        res.send(text);
      } else {
        res.send(Buffer.from(r.data));
      }
    } catch (e) {
      res.status(502).send('// SDK proxy error for ' + sdkPath + ': ' + e.message);
    }
  }
  app.get('/spotify-player.js', (req, res) => spotifySdkProxy('spotify-player.js', res));
  app.get('/sp/*', (req, res) => spotifySdkProxy(req.params[0], res));
};

// Playback helpers reused by the voice assistant (lib/assistant.js)
module.exports.transferAndPlay = transferAndPlay;
module.exports.activateDevice  = activateDevice;
