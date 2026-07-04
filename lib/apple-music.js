// Apple Music — developer token generation + MusicKit.js proxy + catalog search

const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const CREDS_FILE = path.join(__dirname, '..', '.apple-music.json');
let appleConfig  = null; // { teamId, keyId, privateKey }
let mkJsCache    = null, mkJsCacheTs = 0;
let devTokCache  = null, devTokExpiry = 0;

;(function load() {
  try { appleConfig = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8')); } catch {}
})();

function genDevToken() {
  if (!appleConfig) throw new Error('Apple credentials not configured');
  const { teamId, keyId, privateKey } = appleConfig;
  const now = Math.floor(Date.now()/1000);
  const exp = now + 15776999; // ~6 months
  const hdr = Buffer.from(JSON.stringify({ alg:'ES256', kid:keyId })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({ iss:teamId, iat:now, exp })).toString('base64url');
  const data = `${hdr}.${pay}`;
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  // Produce IEEE P1363 format (raw r||s) which JWT requires
  let sig;
  try {
    sig = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  } catch {
    // Fallback: convert DER to P1363
    const der = sign.sign(privateKey);
    let off = 2;
    if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);
    off++; // skip 0x02
    const rLen = der[off++]; let r = der.slice(off, off+rLen); off += rLen;
    off++; // skip 0x02
    const sLen = der[off++]; let s = der.slice(off, off+sLen);
    if (r.length > 32) r = r.slice(r.length-32);
    if (s.length > 32) s = s.slice(s.length-32);
    const rBuf = Buffer.alloc(32); r.copy(rBuf, 32-r.length);
    const sBuf = Buffer.alloc(32); s.copy(sBuf, 32-s.length);
    sig = Buffer.concat([rBuf, sBuf]);
  }
  return `${data}.${sig.toString('base64url')}`;
}

function getDevToken() {
  if (devTokCache && Date.now() < devTokExpiry - 60000) return devTokCache;
  devTokCache  = genDevToken();
  devTokExpiry = Date.now() + 15776999000;
  return devTokCache;
}

module.exports = function setupAppleMusicRoutes(app) {

  // Save Apple developer credentials
  app.post('/api/apple/save-creds', (req, res) => {
    const { teamId, keyId, privateKey } = req.body || {};
    if (!teamId || !keyId || !privateKey) return res.status(400).json({ error: 'missing fields' });
    appleConfig = { teamId, keyId, privateKey };
    devTokCache = null; // reset cache
    try { fs.writeFileSync(CREDS_FILE, JSON.stringify(appleConfig, null, 2)); } catch {}
    res.json({ ok: true });
  });

  // Get (or generate) developer token
  app.get('/api/apple/dev-token', (req, res) => {
    if (!appleConfig) return res.status(400).json({ error: 'Apple credentials not configured' });
    try { res.json({ token: getDevToken() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Disconnect (clear credentials)
  app.post('/api/apple/disconnect', (req, res) => {
    appleConfig = null; devTokCache = null;
    try { if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE); } catch {}
    res.json({ ok: true });
  });

  // Status
  app.get('/api/apple/status', (req, res) => {
    res.json({ configured: !!appleConfig });
  });

  // Catalog search proxy (uses dev token only, no user auth)
  app.get('/api/apple/search', async (req, res) => {
    if (!appleConfig) return res.status(400).json({ error: 'not configured' });
    const q  = (req.query.q||'').trim().slice(0,100);
    const sf = (req.query.storefront||'us').replace(/[^a-z]/g,'');
    if (!q) return res.status(400).json({ error: 'q required' });
    try {
      const tok = getDevToken();
      const r = await axios.get(`https://api.music.apple.com/v1/catalog/${sf}/search`, {
        params: { term: q, types: 'songs,albums,artists', limit: 25 },
        headers: { Authorization: 'Bearer '+tok }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Proxy + cache MusicKit.js (large file, cache for 24h)
  app.get('/mk/musickitjs', async (req, res) => {
    if (mkJsCache && Date.now() - mkJsCacheTs < 86400000)
      return res.type('application/javascript').set('Cache-Control','public,max-age=86400').send(mkJsCache);
    try {
      const r = await axios.get('https://js-cdn.music.apple.com/musickit/v3/musickitjs', {
        timeout: 30000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      mkJsCache = r.data; mkJsCacheTs = Date.now();
      res.type('application/javascript').set('Cache-Control','public,max-age=86400').send(mkJsCache);
    } catch (e) { res.status(502).send('// MusicKit.js unavailable: ' + e.message); }
  });
};
