// YouTube Music — Google OAuth PKCE + Data API proxy + IFrame API proxy

const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { devices, saveDevices } = require('./devices');

const CREDS_FILE  = path.join(__dirname, '..', '.yt-creds.json');
const ytCreds     = new Map(); // deviceId -> { clientId, clientSecret }
const ytPkce      = new Map(); // state    -> { deviceId, verifier }
let   ytIframeJs  = null, ytIframeTs = 0;

;(function load() {
  try { const d = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8')); for (const [k,v] of Object.entries(d)) ytCreds.set(k,v); } catch {}
})();
function saveCreds() {
  const o = {}; for (const [k,v] of ytCreds) o[k]=v;
  try { fs.writeFileSync(CREDS_FILE, JSON.stringify(o,null,2)); } catch {}
}

function pkceV()   { return crypto.randomBytes(32).toString('base64url'); }
function pkceC(v)  { return crypto.createHash('sha256').update(v).digest('base64url'); }

async function getToken(deviceId) {
  const dev = devices.get(deviceId);
  const tok = dev?.ytTokens;
  if (!tok?.access_token) return null;
  if (!tok.expiry || Date.now() < tok.expiry - 60000) return tok.access_token;
  const c = ytCreds.get(deviceId);
  if (!c?.clientId || !c?.clientSecret || !tok.refresh_token) return null;
  try {
    const r = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' },
      timeout: 8000,
    });
    dev.ytTokens = { ...tok, access_token: r.data.access_token, expiry: Date.now() + (r.data.expires_in||3600)*1000 };
    saveDevices();
    return dev.ytTokens.access_token;
  } catch { return null; }
}

module.exports = function setupYtMusicRoutes(app, MAIN_BASE) {
  const REDIRECT = `${MAIN_BASE}/callback/google`;
  const SCOPE    = 'https://www.googleapis.com/auth/youtube.readonly';

  app.post('/api/yt/save-creds', (req, res) => {
    const { clientId, clientSecret } = req.body || {};
    const dev = req.query.device;
    if (!dev || !clientId) return res.status(400).json({ error: 'missing fields' });
    ytCreds.set(dev, { clientId, clientSecret: clientSecret || '' });
    saveCreds();
    res.json({ ok: true });
  });

  app.get('/auth/google', (req, res) => {
    const dev = req.query.device;
    const c   = dev && ytCreds.get(dev);
    if (!c?.clientId) return res.status(400).send('Save credentials first');
    const v = pkceV(), ch = pkceC(v), st = crypto.randomBytes(16).toString('hex');
    ytPkce.set(st, { deviceId: dev, verifier: v });
    const p = new URLSearchParams({ client_id: c.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE, state: st, code_challenge: ch, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p);
  });

  app.get('/callback/google', async (req, res) => {
    const { code, state, error } = req.query;
    const html = (msg, script='') => `<html><body style="font:14px system-ui;background:#111;color:#ccc;padding:32px"><p>${msg}</p>${script}</body></html>`;
    if (error || !code || !state) return res.send(html(`Auth failed: ${error||'missing params'}`, `<script>window.opener?.postMessage({type:'yt-auth-error'},'*')</script>`));
    const stored = ytPkce.get(state); if (!stored) return res.send(html('Invalid or expired state — please try again.'));
    ytPkce.delete(state);
    const { deviceId, verifier } = stored;
    const c = ytCreds.get(deviceId); if (!c) return res.send(html('No credentials found.'));
    try {
      const r = await axios.post('https://oauth2.googleapis.com/token', null, {
        params: { client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier },
        timeout: 10000,
      });
      let dev = devices.get(deviceId); if (!dev) { dev = {}; devices.set(deviceId, dev); }
      dev.ytTokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token || dev.ytTokens?.refresh_token, expiry: Date.now() + (r.data.expires_in||3600)*1000 };
      saveDevices();
      res.send(html('✓ Connected to YouTube Music! You can close this window.', `<script>window.opener?.postMessage({type:'yt-auth-done'},'*');setTimeout(()=>window.close(),1200)</script>`));
    } catch (e) { res.send(html(`Token exchange failed: ${e.message}`)); }
  });

  app.get('/api/yt/status', async (req, res) => {
    res.json({ authenticated: !!(await getToken(req.query.device)) });
  });

  app.post('/api/yt/disconnect', (req, res) => {
    const dev = devices.get(req.query.device);
    if (dev) { delete dev.ytTokens; saveDevices(); }
    res.json({ ok: true });
  });

  app.get('/api/yt/search', async (req, res) => {
    const tok = await getToken(req.query.device);
    if (!tok) return res.status(401).json({ error: 'not authenticated' });
    const q = (req.query.q||'').trim().slice(0,100);
    if (!q) return res.status(400).json({ error: 'q required' });
    try {
      const r = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: { part: 'snippet', q, type: 'video', videoCategoryId: '10', maxResults: 25 },
        headers: { Authorization: 'Bearer '+tok }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/yt/playlists', async (req, res) => {
    const tok = await getToken(req.query.device);
    if (!tok) return res.status(401).json({ error: 'not authenticated' });
    try {
      const r = await axios.get('https://www.googleapis.com/youtube/v3/playlists', {
        params: { part: 'snippet,contentDetails', mine: true, maxResults: 50 },
        headers: { Authorization: 'Bearer '+tok }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/yt/playlist-items', async (req, res) => {
    const tok = await getToken(req.query.device);
    if (!tok) return res.status(401).json({ error: 'not authenticated' });
    const id = (req.query.id||'').replace(/[^a-zA-Z0-9_\-]/g,'');
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const r = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
        params: { part: 'snippet,contentDetails', playlistId: id, maxResults: 50 },
        headers: { Authorization: 'Bearer '+tok }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/yt/liked', async (req, res) => {
    const tok = await getToken(req.query.device);
    if (!tok) return res.status(401).json({ error: 'not authenticated' });
    try {
      const r = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50 },
        headers: { Authorization: 'Bearer '+tok }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Cache and proxy YouTube IFrame API script
  app.get('/yt/iframe-api.js', async (req, res) => {
    if (ytIframeJs && Date.now() - ytIframeTs < 3600000)
      return res.type('application/javascript').set('Cache-Control','public,max-age=3600').send(ytIframeJs);
    try {
      const r = await axios.get('https://www.youtube.com/iframe_api', { timeout: 8000, responseType: 'text' });
      ytIframeJs = r.data; ytIframeTs = Date.now();
      res.type('application/javascript').set('Cache-Control','public,max-age=3600').send(ytIframeJs);
    } catch { res.status(502).end(); }
  });
};
