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
        params: { vs_currency: 'usd', ids, order: 'market_cap_desc', per_page: 20, page: 1, sparkline: true, price_change_percentage: '24h', price_change_percentage: '24h', include_24hr_vol: true, include_24hr_change: true, include_last_updated_at: true },
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

  // ── Stocks (Yahoo Finance) ───────────────────────────────────────────────
  app.get('/api/stock', async (req, res) => {
    const sym = (req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    const range = ['1d','5d','1mo','3mo','6mo','1y','5y','max'].includes(req.query.range) ? req.query.range : '1mo';
    const ivMap = { '1d':'5m', '5d':'15m', '1mo':'1d', '3mo':'1d', '6mo':'1wk', '1y':'1wk', '5y':'1mo', 'max':'1mo' };
    try {
      const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`, {
        params: { interval: ivMap[range], range, includeAdjustedClose: true },
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 10000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/stock/search', async (req, res) => {
    const q = (req.query.q || '').trim().slice(0, 50);
    if (!q) return res.status(400).json({ error: 'q required' });
    try {
      const r = await axios.get('https://query1.finance.yahoo.com/v1/finance/search', {
        params: { q, quotesCount: 8, newsCount: 0, listsCount: 0 },
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ── Exchange rates (frankfurter.app) ─────────────────────────────────────
  app.get('/api/rates', async (req, res) => {
    const base = (req.query.base || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    try {
      const r = await axios.get('https://api.frankfurter.app/latest', { params: { from: base }, timeout: 8000 });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/rates/history', async (req, res) => {
    const base = (req.query.base || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    const to   = (req.query.to   || 'EUR').toUpperCase().replace(/[^A-Z,]/g, '').slice(0, 30);
    const days = Math.min(parseInt(req.query.days || '30', 10), 1825);
    const end  = new Date(); const start = new Date(end.getTime() - days * 86400000);
    const fmt  = d => d.toISOString().split('T')[0];
    try {
      const r = await axios.get(`https://api.frankfurter.app/${fmt(start)}..${fmt(end)}`, {
        params: { from: base, to }, timeout: 10000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/crypto/history', async (req, res) => {
    const id   = (req.query.id   || '').replace(/[^a-z0-9\-]/g, '');
    const days = req.query.days === 'max' ? 'max' : Math.min(parseInt(req.query.days||'30',10), 3650);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const r = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart`, {
        params: { vs_currency: 'usd', days },
        headers: { Accept: 'application/json' },
        timeout: 15000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ── Astronomy ─────────────────────────────────────────────────────────────
  app.get('/api/sunrise', async (req, res) => {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
    try {
      const r = await axios.get('https://api.sunrise-sunset.org/json', {
        params: { lat, lng, formatted: 0 }, timeout: 8000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/iss', async (req, res) => {
    const UA = { 'User-Agent': 'Mozilla/5.0 TemuTalk/1.0' };
    let issData = null, cssData = null;
    // ISS — try wheretheiss.at first, fall back to open-notify
    try {
      const r = await axios.get('https://api.wheretheiss.at/v1/satellites/25544', { timeout: 7000, headers: UA });
      issData = r.data;
    } catch {
      try {
        const r = await axios.get('https://api.open-notify.org/iss-now.json', { timeout: 7000 });
        if (r.data?.iss_position) issData = {
          latitude: parseFloat(r.data.iss_position.latitude),
          longitude: parseFloat(r.data.iss_position.longitude),
          altitude: 408, velocity: 27600, visibility: 'unknown',
        };
      } catch {}
    }
    // CSS (Tiangong) — wheretheiss.at only
    try {
      const r = await axios.get('https://api.wheretheiss.at/v1/satellites/48274', { timeout: 6000, headers: UA });
      cssData = r.data;
    } catch {}
    res.json({ iss: issData, css: cssData });
  });

  // ── Sports (ESPN) ─────────────────────────────────────────────────────────
  app.get('/api/sports', async (req, res) => {
    const sport  = (req.query.sport  || 'soccer').replace(/[^a-z\-]/g, '');
    const league = (req.query.league || 'eng.1').replace(/[^a-z0-9.\-]/g, '');
    try {
      const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/sports/event', async (req, res) => {
    const sport  = (req.query.sport  || '').replace(/[^a-z\-]/g, '');
    const league = (req.query.league || '').replace(/[^a-z0-9.\-]/g, '');
    const event  = (req.query.event  || '').replace(/[^0-9a-z\-]/g, '');
    if (!sport || !league || !event) return res.status(400).json({ error: 'sport, league, event required' });
    try {
      const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/summary`, {
        params: { event }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000,
      });
      res.json(r.data);
    } catch (e) { res.status(502).json({ error: e.message }); }
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
