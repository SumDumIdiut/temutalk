// ── Finance tab ────────────────────────────────────────────────────────────────
let financeLoaded = false, cryptoData = null;
let finActiveSection = 'crypto';
let stockWatchlist = JSON.parse(localStorage.getItem('stockWatchlist') || '[]');
let stockDetailSym = null, stockDetailRange = '1mo';
let ratesBase = 'USD', ratesData = null, ratesDetailPair = null, ratesDetailRange = '30';
let ratesHistoryCache = {};
let stockSearchTimer = null;

// ── Section switching ──────────────────────────────────────────────────────────
function finSwitch(sec) {
  finActiveSection = sec;
  ['crypto','stocks','rates'].forEach(s => {
    document.getElementById('fin-' + s).style.display = s === sec ? '' : 'none';
    document.getElementById('fst-' + s).classList.toggle('on', s === sec);
  });
  const lu = document.getElementById('finance-last-update');
  if (lu) lu.textContent = '';
  if (sec === 'crypto') loadCrypto();
  if (sec === 'stocks') renderWatchlist();
  if (sec === 'rates')  loadRates();
}

function finRefresh() {
  if (finActiveSection === 'crypto') loadCrypto(true);
  if (finActiveSection === 'stocks') refreshWatchlistPrices();
  if (finActiveSection === 'rates')  loadRates(true);
}

// ── Shared chart drawing ───────────────────────────────────────────────────────
function drawChart(canvas, values, labels, opts = {}) {
  const { color = '#34d399', fill = true, tickCount = 4 } = opts;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 300, H = canvas.offsetHeight || 180;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const valid = values.filter(v => v != null && isFinite(v));
  if (!valid.length) return;
  const mn = Math.min(...valid), mx = Math.max(...valid);
  const rng = mx - mn || mx * 0.01 || 1;
  const pad = { t: 8, r: 8, b: 28, l: 58 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  // Grid + Y labels
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.font = `${10 * dpr / dpr}px system-ui`; ctx.textAlign = 'right';
  for (let i = 0; i <= tickCount; i++) {
    const y = pad.t + ch / tickCount * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
    const v = mx - rng / tickCount * i;
    ctx.fillText(fmtChartVal(v), pad.l - 4, y + 4);
  }

  // X labels
  if (labels && labels.length) {
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.textAlign = 'center';
    const step = Math.floor(labels.length / 4);
    for (let i = 0; i < labels.length; i += step || 1) {
      const x = pad.l + (i / (values.length - 1)) * cw;
      ctx.fillText(labels[i], x, H - pad.b + 14);
    }
    // last label
    const x = pad.l + cw;
    ctx.fillText(labels[labels.length - 1], x, H - pad.b + 14);
  }

  // Build points
  const pts = values.map((v, i) => ({
    x: pad.l + (i / Math.max(values.length - 1, 1)) * cw,
    y: v == null ? null : pad.t + (1 - (v - mn) / rng) * ch,
  }));

  // Fill
  if (fill) {
    ctx.beginPath();
    let started = false;
    pts.forEach(p => { if (p.y == null) return; if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); });
    const first = pts.find(p => p.y != null), last = [...pts].reverse().find(p => p.y != null);
    if (first && last) {
      ctx.lineTo(last.x, pad.t + ch); ctx.lineTo(first.x, pad.t + ch); ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
      g.addColorStop(0, color + '44'); g.addColorStop(1, color + '00');
      ctx.fillStyle = g; ctx.fill();
    }
  }

  // Line
  ctx.beginPath(); let started = false;
  pts.forEach(p => { if (p.y == null) { started = false; return; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); });
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

function fmtChartVal(v) {
  if (v >= 1e9) return '$' + (v/1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  if (v === 0) return '0';
  if (v < 0.01) return v.toFixed(5);
  return v.toFixed(4);
}

function drawSparkline(canvas, values, up) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 80, H = canvas.offsetHeight || 30;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const valid = values.filter(v => v != null && isFinite(v));
  if (valid.length < 2) return;
  const mn = Math.min(...valid), mx = Math.max(...valid), rng = mx - mn || 1;
  const color = up ? '#34d399' : '#f87171';
  ctx.beginPath();
  valid.forEach((v, i) => {
    const x = (i / (valid.length - 1)) * W;
    const y = (1 - (v - mn) / rng) * H;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
}

// ── Crypto ─────────────────────────────────────────────────────────────────────
function loadCrypto(force) {
  const el = document.getElementById('crypto-list');
  if (!el) return;
  if (cryptoData && !force) { renderCrypto(cryptoData); return; }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px;text-align:center">Loading…</div>';
  fetch('/api/crypto?device=' + deviceId)
    .then(r => r.json()).then(data => {
      if (!Array.isArray(data) || !data.length) throw new Error('empty');
      cryptoData = data;
      setLastUpdate();
      renderCrypto(data);
    }).catch(() => {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px;text-align:center">Could not load — try again shortly</div>';
    });
}

function renderCrypto(data) {
  const el = document.getElementById('crypto-list');
  if (!el) return;
  el.innerHTML = data.map((c, i) => {
    const chg = c.price_change_percentage_24h ?? 0, up = chg >= 0;
    const price = c.current_price >= 1000
      ? c.current_price.toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 })
      : c.current_price >= 1
      ? c.current_price.toLocaleString('en-US', { style:'currency', currency:'USD', minimumFractionDigits:2, maximumFractionDigits:2 })
      : '$' + c.current_price.toPrecision(4);
    const mcap = c.market_cap >= 1e12 ? '$' + (c.market_cap/1e12).toFixed(2) + 'T'
               : c.market_cap >= 1e9  ? '$' + (c.market_cap/1e9).toFixed(1)  + 'B'
               : c.market_cap >= 1e6  ? '$' + (c.market_cap/1e6).toFixed(0)  + 'M' : '';
    const vol  = c.total_volume >= 1e9 ? '$' + (c.total_volume/1e9).toFixed(1) + 'B'
               : c.total_volume >= 1e6 ? '$' + (c.total_volume/1e6).toFixed(0) + 'M' : '';
    return '<div class="coin-card">' +
      '<span class="coin-rank">' + (i+1) + '</span>' +
      '<img class="coin-img" src="' + esc(c.image||'') + '" alt="" loading="lazy" onerror="this.style.opacity=\'.3\'">' +
      '<div class="coin-info"><div class="coin-name">' + esc(c.name) + '</div>' +
      '<div class="coin-sym">' + esc(c.symbol) + (mcap ? ' · ' + mcap : '') + '</div></div>' +
      '<div class="coin-price"><div class="coin-usd">' + price + '</div>' +
      '<div class="coin-chg ' + (up?'up':'down') + '">' + (up?'▲':'▼') + ' ' + Math.abs(chg).toFixed(2) + '%</div>' +
      (vol ? '<div class="coin-mcap">Vol ' + vol + '</div>' : '') +
      '</div></div>';
  }).join('');
}

// ── Stocks ─────────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function stockSearchDebounced() {
  clearTimeout(stockSearchTimer);
  stockSearchTimer = setTimeout(stockSearch, 280);
}

async function stockSearch() {
  const q = (document.getElementById('stock-search-inp')?.value || '').trim();
  const drop = document.getElementById('stock-search-drop');
  if (!drop) return;
  if (q.length < 1) { drop.style.display = 'none'; return; }
  drop.style.display = '';
  drop.innerHTML = '<div class="stock-drop-item" style="color:var(--text-muted)">Searching…</div>';
  try {
    const r = await fetch('/api/stock/search?q=' + encodeURIComponent(q) + '&device=' + deviceId);
    const d = await r.json();
    const quotes = (d.quotes || []).filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'INDEX' || q.quoteType === 'CURRENCY');
    if (!quotes.length) { drop.innerHTML = '<div class="stock-drop-item" style="color:var(--text-muted)">No results</div>'; return; }
    drop.innerHTML = quotes.slice(0, 7).map(q =>
      '<div class="stock-drop-item" onclick="stockAdd(\'' + esc(q.symbol) + '\',\'' + esc((q.shortname||q.longname||'').replace(/'/g,'')) + '\')">' +
      '<span class="stock-drop-sym">' + esc(q.symbol) + '</span>' +
      '<span class="stock-drop-name">' + esc(q.shortname || q.longname || '') + '</span>' +
      '<span class="stock-drop-type">' + esc(q.quoteType||'') + '</span></div>'
    ).join('');
    drop.style.display = '';
  } catch { drop.innerHTML = '<div class="stock-drop-item" style="color:var(--text-muted)">Error</div>'; }
}

function stockAdd(symbol, name) {
  const inp = document.getElementById('stock-search-inp');
  const drop = document.getElementById('stock-search-drop');
  if (inp) inp.value = '';
  if (drop) drop.style.display = 'none';
  if (!stockWatchlist.find(s => s.sym === symbol)) {
    stockWatchlist.push({ sym: symbol, name });
    localStorage.setItem('stockWatchlist', JSON.stringify(stockWatchlist));
  }
  renderWatchlist();
  stockOpen(symbol, name);
}

function stockRemove(symbol, e) {
  e.stopPropagation();
  stockWatchlist = stockWatchlist.filter(s => s.sym !== symbol);
  localStorage.setItem('stockWatchlist', JSON.stringify(stockWatchlist));
  if (stockDetailSym === symbol) {
    stockDetailSym = null;
    const det = document.getElementById('stock-detail');
    if (det) det.style.display = 'none';
  }
  renderWatchlist();
}

async function renderWatchlist() {
  const el = document.getElementById('stock-watchlist');
  if (!el) return;
  if (!stockWatchlist.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px 0;text-align:center">Search for a stock, ETF or index to add it to your watchlist</div>';
    return;
  }
  el.innerHTML = stockWatchlist.map(s =>
    '<div class="stock-card' + (stockDetailSym === s.sym ? ' on' : '') + '" onclick="stockOpen(\'' + esc(s.sym) + '\',\'' + esc((s.name||'').replace(/'/g,'')) + '\')">' +
    '<div style="min-width:0;flex:1">' +
    '<div class="stock-sym">' + esc(s.sym) + '</div>' +
    '<div class="stock-name">' + esc(s.name||'') + '</div></div>' +
    '<canvas class="rate-spark" id="spark-' + esc(s.sym) + '" height="30" width="80"></canvas>' +
    '<div class="stock-price">' +
    '<div class="stock-px" id="spx-' + esc(s.sym) + '">—</div>' +
    '<div class="stock-chg" id="spch-' + esc(s.sym) + '">…</div></div>' +
    '<button class="stock-remove" onclick="stockRemove(\'' + esc(s.sym) + '\',event)" title="Remove">×</button>' +
    '</div>'
  ).join('');
  refreshWatchlistPrices();
}

async function refreshWatchlistPrices() {
  for (const s of stockWatchlist) {
    try {
      const r = await fetch('/api/stock?symbol=' + encodeURIComponent(s.sym) + '&range=5d&device=' + deviceId);
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      if (!res) continue;
      const meta = res.meta;
      const closes = res.indicators?.quote?.[0]?.close || [];
      const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
      const prev  = meta.chartPreviousClose || closes[closes.length - 2] || price;
      const chg   = prev ? ((price - prev) / prev * 100) : 0;
      const up    = chg >= 0;

      const pxEl  = document.getElementById('spx-'  + s.sym);
      const chEl  = document.getElementById('spch-' + s.sym);
      const spEl  = document.getElementById('spark-' + s.sym);
      if (pxEl)  pxEl.textContent  = fmtStockPrice(price, meta.currency || 'USD');
      if (chEl)  { chEl.textContent = (up?'▲':'▼') + ' ' + Math.abs(chg).toFixed(2) + '%'; chEl.className = 'stock-chg ' + (up?'up':'down'); }
      if (spEl)  drawSparkline(spEl, closes.filter(v => v != null), up);
    } catch {}
  }
  setLastUpdate();
}

async function stockOpen(sym, name) {
  stockDetailSym = sym;
  renderWatchlist();
  const det = document.getElementById('stock-detail');
  if (det) det.style.display = '';
  document.getElementById('sd-sym').textContent  = sym;
  document.getElementById('sd-name').textContent = name || sym;
  document.getElementById('sd-price').textContent = '…';
  document.getElementById('sd-chg').textContent  = '';
  document.getElementById('sd-stats').innerHTML  = '';
  await loadStockChart(sym, stockDetailRange);
}

async function stockChartRange(range) {
  stockDetailRange = range;
  document.querySelectorAll('.cr-btn').forEach(b => {
    if (b.closest('#stock-detail')) b.classList.toggle('on', b.textContent.toLowerCase().replace('d','d').replace('m','mo') === range || b.textContent === range.replace('mo','M').replace('d','D').replace('y','Y'));
  });
  // Update active button
  const btnMap = { '1d':'1D','5d':'5D','1mo':'1M','3mo':'3M','6mo':'6M','1y':'1Y','5y':'5Y' };
  document.querySelectorAll('#stock-detail .cr-btn').forEach(b => b.classList.toggle('on', b.textContent === (btnMap[range]||range)));
  if (stockDetailSym) loadStockChart(stockDetailSym, range);
}

async function loadStockChart(sym, range) {
  try {
    const r = await fetch('/api/stock?symbol=' + encodeURIComponent(sym) + '&range=' + range + '&device=' + deviceId);
    const d = await r.json();
    const res = d?.chart?.result?.[0];
    if (!res) return;
    const meta   = res.meta;
    const ts     = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    const price  = meta.regularMarketPrice ?? closes[closes.length-1];
    const prev   = meta.chartPreviousClose || meta.previousClose || closes[0];
    const chg    = prev ? ((price - prev) / prev * 100) : 0;
    const up     = chg >= 0;

    const pxEl = document.getElementById('sd-price');
    const chEl = document.getElementById('sd-chg');
    if (pxEl) pxEl.textContent = fmtStockPrice(price, meta.currency || 'USD');
    if (chEl) {
      const abs = Math.abs(price - (prev||0));
      chEl.textContent = (up?'▲':'▼') + ' ' + fmtStockPrice(abs, meta.currency||'USD') + ' (' + Math.abs(chg).toFixed(2) + '%)';
      chEl.className = 'stock-detail-chg ' + (up?'up':'down');
    }

    // Stats
    const stats = [
      ['Open',   fmtStockPrice(meta.regularMarketOpen ?? meta.open, meta.currency||'USD')],
      ['Prev Close', fmtStockPrice(prev, meta.currency||'USD')],
      ['High',   fmtStockPrice(meta.regularMarketDayHigh ?? meta.dayHigh, meta.currency||'USD')],
      ['Low',    fmtStockPrice(meta.regularMarketDayLow ?? meta.dayLow, meta.currency||'USD')],
      ['52W High', fmtStockPrice(meta.fiftyTwoWeekHigh, meta.currency||'USD')],
      ['52W Low',  fmtStockPrice(meta.fiftyTwoWeekLow,  meta.currency||'USD')],
    ];
    document.getElementById('sd-stats').innerHTML = stats.filter(([,v])=>v&&v!=='—').map(([k,v]) =>
      '<div class="sd-stat"><div class="sd-stat-k">' + k + '</div><div class="sd-stat-v">' + v + '</div></div>'
    ).join('');

    // Chart
    const canvas = document.getElementById('stock-chart');
    const labels = ts.map(t => {
      const d = new Date(t * 1000);
      return range === '1d' || range === '5d'
        ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
        : d.toLocaleDateString([], {month:'short',day:'numeric'});
    });
    requestAnimationFrame(() => drawChart(canvas, closes, labels, { color: up ? '#34d399' : '#f87171' }));
  } catch (e) { console.error('stock chart:', e); }
}

function fmtStockPrice(v, currency) {
  if (v == null || !isFinite(v)) return '—';
  const sym = currency === 'GBp' ? 'GBp ' : (currency === 'USD' ? '$' : (currency + ' '));
  if (v >= 1000) return sym + v.toLocaleString('en-US', {maximumFractionDigits:0});
  if (v >= 1)   return sym + v.toFixed(2);
  return sym + v.toFixed(4);
}

// ── Exchange Rates ─────────────────────────────────────────────────────────────
const CURRENCY_META = {
  USD:{flag:'🇺🇸',name:'US Dollar'},EUR:{flag:'🇪🇺',name:'Euro'},GBP:{flag:'🇬🇧',name:'British Pound'},
  JPY:{flag:'🇯🇵',name:'Japanese Yen'},ZAR:{flag:'🇿🇦',name:'South African Rand'},AUD:{flag:'🇦🇺',name:'Australian Dollar'},
  CAD:{flag:'🇨🇦',name:'Canadian Dollar'},CHF:{flag:'🇨🇭',name:'Swiss Franc'},CNY:{flag:'🇨🇳',name:'Chinese Yuan'},
  INR:{flag:'🇮🇳',name:'Indian Rupee'},BRL:{flag:'🇧🇷',name:'Brazilian Real'},MXN:{flag:'🇲🇽',name:'Mexican Peso'},
  KRW:{flag:'🇰🇷',name:'South Korean Won'},SGD:{flag:'🇸🇬',name:'Singapore Dollar'},NOK:{flag:'🇳🇴',name:'Norwegian Krone'},
  SEK:{flag:'🇸🇪',name:'Swedish Krona'},DKK:{flag:'🇩🇰',name:'Danish Krone'},NZD:{flag:'🇳🇿',name:'New Zealand Dollar'},
  HKD:{flag:'🇭🇰',name:'Hong Kong Dollar'},RUB:{flag:'🇷🇺',name:'Russian Ruble'},TRY:{flag:'🇹🇷',name:'Turkish Lira'},
  AED:{flag:'🇦🇪',name:'UAE Dirham'},SAR:{flag:'🇸🇦',name:'Saudi Riyal'},PKR:{flag:'🇵🇰',name:'Pakistani Rupee'},
  IDR:{flag:'🇮🇩',name:'Indonesian Rupiah'},MYR:{flag:'🇲🇾',name:'Malaysian Ringgit'},PHP:{flag:'🇵🇭',name:'Philippine Peso'},
  THB:{flag:'🇹🇭',name:'Thai Baht'},CZK:{flag:'🇨🇿',name:'Czech Koruna'},PLN:{flag:'🇵🇱',name:'Polish Zloty'},
};
const PRIORITY_CURRENCIES = ['EUR','GBP','JPY','ZAR','AUD','CAD','CHF','CNY','INR','BRL','MXN','KRW','SGD','NZD'];

async function loadRates(force) {
  const sel = document.getElementById('rates-base');
  if (sel) ratesBase = sel.value;
  const el = document.getElementById('rates-list');
  if (!el) return;
  if (ratesData && ratesData.base === ratesBase && !force) { renderRates(ratesData); return; }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px;text-align:center">Loading…</div>';
  try {
    const r = await fetch('/api/rates?base=' + ratesBase + '&device=' + deviceId);
    ratesData = await r.json();
    setLastUpdate();
    renderRates(ratesData);
    // Pre-load 30d history for the main visible currencies
    loadRatesSparklines();
  } catch {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px;text-align:center">Could not load rates</div>';
  }
}

function renderRates(data) {
  const el = document.getElementById('rates-list');
  if (!el || !data?.rates) return;
  const allPairs = Object.keys(data.rates);
  const ordered  = PRIORITY_CURRENCIES.filter(c => c !== data.base && allPairs.includes(c))
    .concat(allPairs.filter(c => !PRIORITY_CURRENCIES.includes(c) && c !== data.base));
  el.innerHTML = ordered.map(c => {
    const meta = CURRENCY_META[c] || {};
    const rate = data.rates[c];
    return '<div class="rate-card" id="rate-card-' + c + '" onclick="ratesOpen(\'' + c + '\')">' +
      '<span class="rate-flag">' + (meta.flag||'🏳') + '</span>' +
      '<span class="rate-sym">' + c + '</span>' +
      '<span class="rate-name">' + (meta.name||c) + '</span>' +
      '<canvas class="rate-spark" id="rate-spark-' + c + '" height="30" width="80"></canvas>' +
      '<span class="rate-val">' + fmtRate(rate) + '</span>' +
      '<span class="rate-chg" id="rate-chg-' + c + '">…</span>' +
      '</div>';
  }).join('');
}

function fmtRate(v) {
  if (!v) return '—';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 10)   return v.toFixed(2);
  if (v >= 1)    return v.toFixed(4);
  return v.toFixed(6);
}

async function loadRatesSparklines() {
  const pairs = PRIORITY_CURRENCIES.filter(c => c !== ratesBase).slice(0, 8).join(',');
  try {
    const r = await fetch('/api/rates/history?base=' + ratesBase + '&to=' + pairs + '&days=30&device=' + deviceId);
    const d = await r.json();
    if (!d?.rates) return;
    const dates = Object.keys(d.rates).sort();
    // For each currency, extract the time series
    const first = d.rates[dates[0]], last = d.rates[dates[dates.length-1]];
    Object.keys(first || {}).forEach(c => {
      const vals = dates.map(dt => d.rates[dt]?.[c]).filter(v => v != null);
      const el = document.getElementById('rate-spark-' + c);
      if (el) {
        const start = vals[0], end = vals[vals.length-1];
        const up = end >= start;
        drawSparkline(el, vals, up);
        const chgEl = document.getElementById('rate-chg-' + c);
        if (chgEl && start) {
          const pct = ((end - start) / start * 100);
          chgEl.textContent = (pct >= 0 ? '▲' : '▼') + ' ' + Math.abs(pct).toFixed(2) + '%';
          chgEl.className = 'rate-chg ' + (pct >= 0 ? 'up' : 'down');
        }
      }
    });
    ratesHistoryCache[ratesBase + '_30'] = d;
  } catch {}
}

async function ratesOpen(pair) {
  ratesDetailPair = pair;
  document.querySelectorAll('.rate-card').forEach(c => c.classList.toggle('on', c.id === 'rate-card-' + pair));
  const det = document.getElementById('rates-detail');
  const hdr = document.getElementById('rates-detail-hdr');
  if (det) det.style.display = '';
  const meta = CURRENCY_META[pair] || {};
  if (hdr) hdr.textContent = (meta.flag||'') + ' ' + ratesBase + ' / ' + pair + ' — ' + (meta.name||pair);
  await ratesChartRange(ratesDetailRange);
}

async function ratesChartRange(days) {
  ratesDetailRange = days;
  document.querySelectorAll('#rates-detail .cr-btn').forEach(b => {
    const map = {'30':'1M','90':'3M','180':'6M','365':'1Y'};
    b.classList.toggle('on', map[days] === b.textContent);
  });
  if (!ratesDetailPair) return;
  const canvas = document.getElementById('rates-chart');
  if (!canvas) return;
  try {
    const r = await fetch('/api/rates/history?base=' + ratesBase + '&to=' + ratesDetailPair + '&days=' + days + '&device=' + deviceId);
    const d = await r.json();
    if (!d?.rates) return;
    const dates = Object.keys(d.rates).sort();
    const vals  = dates.map(dt => d.rates[dt]?.[ratesDetailPair]);
    const labels = dates.map(dt => { const [,m,dy] = dt.split('-'); return m + '/' + dy; });
    const start = vals.find(v => v != null), end = [...vals].reverse().find(v => v != null);
    const up = (end||0) >= (start||0);
    requestAnimationFrame(() => drawChart(canvas, vals, labels, { color: up ? '#34d399' : '#f87171' }));
  } catch {}
}

function setLastUpdate() {
  const lu = document.getElementById('finance-last-update');
  if (lu) lu.textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
