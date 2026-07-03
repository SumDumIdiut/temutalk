// Data API routes: weather, crypto, system info, lyrics, radio, map tiles.

const axios = require('axios');
const zlib  = require('zlib');
const http  = require('http');
const os    = require('os');

// ─── Map tile proxy (LRU cache) ───────────────────────────────────────────────
const TILE_STYLES    = new Set(['dark_nolabels', 'dark_only_labels', 'dark_all']);
const TILE_CACHE_MAX = 8000;
const tileCache      = new Map();

function tileGet(key)      { const v = tileCache.get(key); if (v) { tileCache.delete(key); tileCache.set(key, v); } return v; }
function tileSet(key, buf) { if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value); tileCache.set(key, buf); }

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
let radioCacheGeoGzip = null;
let radioCacheTs      = 0;
let radioFetchPromise = null;

async function refreshRadioCache() {
  if (radioFetchPromise) return radioFetchPromise;
  radioFetchPromise = (async () => {
    const stations = [];
    let offset = 0;
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
    const geo = stations.filter(s => s.geo_lat && s.geo_long);
    zlib.gzip(Buffer.from(JSON.stringify(geo)), { level: 6 }, (err, buf) => {
      if (!err) { radioCacheGeoGzip = buf; console.log(`[radio] geo cache: ${geo.length} stations, ${(buf.length/1024).toFixed(0)} KB gzipped`); }
    });
  })()
    .catch(e => console.error('[radio] prefetch failed:', e.message))
    .finally(() => { radioFetchPromise = null; });
  return radioFetchPromise;
}

refreshRadioCache();

// ─── Route setup ──────────────────────────────────────────────────────────────
module.exports = function setupDataRoutes(app, WEATHER_CITY) {

  app.get('/api/tiles/:style/:z/:x/:y', async (req, res) => {
    const { style, z, x, y } = req.params;
    if (!TILE_STYLES.has(style))   return res.status(400).end();
    if (!/^\d+$/.test(z + x + y)) return res.status(400).end();
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

  app.get('/api/radio/geo', (req, res) => {
    if (!radioCacheGeoGzip) return res.status(503).json({ error: 'cache warming, try again shortly' });
    res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=3600' });
    res.send(radioCacheGeoGzip);
  });

  app.get('/api/radio', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    if (!radioCache.length || Date.now() - radioCacheTs > RADIO_CACHE_TTL) {
      if (!radioCache.length) await refreshRadioCache();
      else refreshRadioCache();
    }
    const SEND = 500;
    for (let i = 0; i < radioCache.length; i += SEND) {
      if (res.destroyed) break;
      res.write(`data: ${JSON.stringify(radioCache.slice(i, i + SEND))}\n\n`);
    }
    res.write('event: done\ndata: {}\n\n');
    res.end();
  });

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

  app.get('/api/weather', async (req, res) => {
    const city = (req.query.city || WEATHER_CITY).trim();
    try {
      const r = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`,
        { headers: { 'User-Agent': 'GoogleHomeHub/1.0' }, timeout: 10000 });
      res.json(r.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
