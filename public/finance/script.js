// ── Finance tab ─────────────────────────────────────────────────────────────────
let financeLoaded = false;
let finActiveSection = 'crypto';

// ── Crypto state ──────────────────────────────────────────────────────────────
let _cryptoList     = null;
let _cryptoDetId    = null;
let _cryptoDetRange = '30';
let _cryptoDetPrice = 0;

// ── Stock state ───────────────────────────────────────────────────────────────
const _DEFAULT_WL = [
  {sym:'AAPL',   name:'Apple'},
  {sym:'MSFT',   name:'Microsoft'},
  {sym:'NVDA',   name:'Nvidia'},
  {sym:'GOOGL',  name:'Alphabet'},
  {sym:'AMZN',   name:'Amazon'},
  {sym:'META',   name:'Meta'},
  {sym:'TSLA',   name:'Tesla'},
  {sym:'JPM',    name:'JPMorgan Chase'},
  {sym:'V',      name:'Visa'},
  {sym:'^GSPC',  name:'S&P 500'},
  {sym:'^DJI',   name:'Dow Jones'},
  {sym:'^IXIC',  name:'Nasdaq'},
];
let stockWatchlist = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('stockWatchlist') || '[]');
    const norm = raw.map(s => typeof s === 'string' ? {sym:s,name:''} : s).filter(s => s?.sym);
    // Upgrade the old 3-item default to the new expanded default
    const syms = norm.map(s=>s.sym).sort().join(',');
    if (!norm.length || syms === 'AAPL,MSFT,^GSPC' || syms === 'AAPL,MSFT,TSLA,^GSPC') return _DEFAULT_WL;
    return norm;
  } catch { return _DEFAULT_WL; }
})();
let _stockDetSym      = null;
let _stockDetRange    = '1mo';
let _stockDetPrice    = 0;
let _stockDetCurrency = 'USD';
let _stockSearchTimer = null;

// ── Rates state ───────────────────────────────────────────────────────────────
let _ratesBase       = 'USD';
let _ratesList       = null;
let _ratesDetPair    = null;
let _ratesDetRange   = '30';
let _ratesConvRate   = 1;
let _ratesConvFromLbl = 'USD';
let _ratesConvToLbl   = 'GBP';
let _ratesHistCache  = {};

// ── Chart state ───────────────────────────────────────────────────────────────
let _cs = null; // { values, labels, pad, cw, ch, mn, mx, rng, color, rateMode, W, H }

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _fmtUSD(v, compact) {
  if (v == null || !isFinite(v)) return '—';
  if (compact) {
    if (Math.abs(v) >= 1e12) return '$' + (v/1e12).toFixed(2) + 'T';
    if (Math.abs(v) >= 1e9)  return '$' + (v/1e9).toFixed(2)  + 'B';
    if (Math.abs(v) >= 1e6)  return '$' + (v/1e6).toFixed(2)  + 'M';
    if (Math.abs(v) >= 1e3)  return '$' + (v/1e3).toFixed(1)  + 'K';
  }
  if (v >= 1000) return '$' + v.toLocaleString('en-US',{maximumFractionDigits:0});
  if (v >= 1)    return '$' + v.toFixed(2);
  if (v >= 0.001)return '$' + v.toFixed(4);
  if (v >= 0)    return '$' + v.toPrecision(4);
  return '-$' + Math.abs(v).toFixed(2);
}

function _fmtCurr(v, currency) {
  if (v == null || !isFinite(v)) return '—';
  const sym = currency === 'GBp' ? 'GBp ' : (currency === 'USD' ? '$' : (currency + ' '));
  if (v >= 1000) return sym + v.toLocaleString('en-US',{maximumFractionDigits:0});
  if (v >= 1)    return sym + v.toFixed(2);
  return sym + v.toFixed(4);
}

function _fmtRate(v) {
  if (!v || !isFinite(v)) return '—';
  if (v >= 10000) return v.toFixed(0);
  if (v >= 100)   return v.toFixed(1);
  if (v >= 10)    return v.toFixed(3);
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(5);
}

function _fmtChartY(v, rateMode) {
  if (rateMode) return _fmtRate(v);
  if (Math.abs(v) >= 1e12) return '$' + (v/1e12).toFixed(1) + 'T';
  if (Math.abs(v) >= 1e9)  return '$' + (v/1e9).toFixed(1)  + 'B';
  if (Math.abs(v) >= 1e6)  return '$' + (v/1e6).toFixed(1)  + 'M';
  if (Math.abs(v) >= 1000) return '$' + (v/1000).toFixed(0) + 'K';
  if (Math.abs(v) >= 1)    return '$' + v.toFixed(2);
  if (v === 0)              return '$0';
  if (Math.abs(v) < 0.01)  return '$' + v.toFixed(5);
  return '$' + v.toFixed(4);
}

function _pct(v, ref) {
  if (!ref) return '';
  const p = (v - ref) / ref * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

function setLastUpdate() {
  const el = document.getElementById('fin-updated');
  if (el) el.textContent = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

// ══════════════════════════════════════════════════════════════════════════════
// CHARTS
// ══════════════════════════════════════════════════════════════════════════════
function drawChart(canvas, values, labels, opts = {}) {
  const { color = '#34d399', fill = true, rateMode = false } = opts;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 320, H = canvas.offsetHeight || 180;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const valid = values.filter(v => v != null && isFinite(v));
  if (!valid.length) return;
  const mn = Math.min(...valid), mx = Math.max(...valid);
  const rng = mx - mn || Math.abs(mx) * 0.02 || 1;
  const pad = { t:12, r:12, b:32, l:64 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  // Grid + Y ticks
  const ticks = 4;
  ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + ch / ticks * i;
    ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
    const v = mx - rng / ticks * i;
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.fillText(_fmtChartY(v, rateMode), pad.l - 4, y + 4);
  }

  // X labels (5 evenly spaced)
  if (labels?.length) {
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.textAlign = 'center'; ctx.font = '9px system-ui';
    const n = 5;
    for (let i = 0; i < n; i++) {
      const li = Math.round(i / (n-1) * (labels.length - 1));
      const x = pad.l + (li / Math.max(values.length-1,1)) * cw;
      ctx.fillText(labels[li], x, H - 6);
    }
  }

  // Points
  const pts = values.map((v, i) => ({
    x: pad.l + (i / Math.max(values.length-1,1)) * cw,
    y: v == null ? null : pad.t + (1-(v-mn)/rng) * ch,
  }));

  // Fill
  if (fill) {
    ctx.beginPath(); let s = false;
    pts.forEach(p => { if(!p.y) return; if(!s){ctx.moveTo(p.x,p.y);s=true;}else ctx.lineTo(p.x,p.y); });
    const f = pts.find(p=>p.y!=null), l = [...pts].reverse().find(p=>p.y!=null);
    if (f && l) {
      ctx.lineTo(l.x, pad.t+ch); ctx.lineTo(f.x, pad.t+ch); ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t+ch);
      g.addColorStop(0, color+'30'); g.addColorStop(1, color+'00');
      ctx.fillStyle = g; ctx.fill();
    }
  }

  // Line
  ctx.beginPath(); let s = false;
  pts.forEach(p => { if(!p.y){s=false;return;} if(!s){ctx.moveTo(p.x,p.y);s=true;}else ctx.lineTo(p.x,p.y); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();

  // Store state for overlay hover
  _cs = { values, labels, pad, cw, ch, mn, mx, rng, color, rateMode, W, H };
}

function initChartHover(ov) {
  if (!ov) return;
  ov.onmousemove = e => {
    if (!_cs) return;
    const { values, labels, pad, cw, ch, mn, rng, color, rateMode, W, H } = _cs;
    const rect = ov.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.max(0, Math.min(Math.round((mouseX - pad.l) / cw * (values.length-1)), values.length-1));
    const v = values[idx];
    if (v == null || !isFinite(v)) return;

    const dpr = window.devicePixelRatio || 1;
    ov.width = W * dpr; ov.height = H * dpr;
    const ctx = ov.getContext('2d'); ctx.scale(dpr, dpr);

    const x = pad.l + (idx / Math.max(values.length-1,1)) * cw;
    const y = pad.t + (1-(v-mn)/rng) * ch;

    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x,pad.t); ctx.lineTo(x,pad.t+ch); ctx.stroke();

    ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

    const valText = rateMode ? _fmtRate(v) : _fmtChartY(v, false);
    const lbl = labels?.[idx] || '';
    const tipW = 118, tipH = 42;
    const tipX = (x + tipW + 14 > W - pad.r) ? x - tipW - 10 : x + 10;
    const tipY = Math.max(pad.t, Math.min(y - tipH/2, pad.t + ch - tipH));

    ctx.fillStyle = 'rgba(10,10,14,.92)'; ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 5;
    ctx.moveTo(tipX+r,tipY); ctx.lineTo(tipX+tipW-r,tipY);
    ctx.arcTo(tipX+tipW,tipY,tipX+tipW,tipY+r,r);
    ctx.lineTo(tipX+tipW,tipY+tipH-r);
    ctx.arcTo(tipX+tipW,tipY+tipH,tipX+tipW-r,tipY+tipH,r);
    ctx.lineTo(tipX+r,tipY+tipH);
    ctx.arcTo(tipX,tipY+tipH,tipX,tipY+tipH-r,r);
    ctx.lineTo(tipX,tipY+r);
    ctx.arcTo(tipX,tipY,tipX+r,tipY,r);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(valText, tipX+8, tipY+16);
    ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.font = '10px system-ui';
    ctx.fillText(lbl, tipX+8, tipY+30);
  };
  ov.onmouseleave = () => {
    ov.width = ov.width; // clear
  };
}

function drawSparkline(canvas, values, up) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 80, H = canvas.offsetHeight || 30;
  canvas.width = W*dpr; canvas.height = H*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const valid = values.filter(v => v != null && isFinite(v));
  if (valid.length < 2) return;
  const mn = Math.min(...valid), mx = Math.max(...valid), rng = mx-mn||1;
  const color = up ? '#34d399' : '#f87171';
  ctx.beginPath();
  valid.forEach((v,i) => {
    const x = i / (valid.length-1) * W;
    const y = (1-(v-mn)/rng) * H;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
}

function _rangeHtml(btnClass, ranges, onclickFn, active) {
  return ranges.map(([val,lbl]) =>
    `<button class="cr-btn${String(val)===String(active)?' on':''}" onclick="${onclickFn}('${val}')">${lbl}</button>`
  ).join('');
}

function _chartWrap(id) {
  return `<div class="chart-wrap">
    <canvas class="chart-main" id="${id}-chart"></canvas>
    <canvas class="chart-ov"   id="${id}-ov"></canvas>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION SWITCHER
// ══════════════════════════════════════════════════════════════════════════════
function finSwitch(sec) {
  finActiveSection = sec;
  ['crypto','stocks','rates'].forEach(s => {
    const p = document.getElementById('fin-'+s);
    const t = document.querySelector(`.fin-tab[data-sec="${s}"]`);
    if (p) p.style.display = s===sec ? '' : 'none';
    if (t) t.classList.toggle('on', s===sec);
  });
  document.getElementById('fin-updated').textContent = '';
  if (sec === 'crypto') loadCrypto();
  if (sec === 'stocks') renderWatchlist();
  if (sec === 'rates')  loadRates();
}

function finRefresh() {
  if (finActiveSection === 'crypto') {
    if (_cryptoDetId) _loadCryptoChart(_cryptoDetId, _cryptoDetRange, true);
    else loadCrypto(true);
  }
  if (finActiveSection === 'stocks') {
    if (_stockDetSym) _loadStockDetail(_stockDetSym, _stockDetRange);
    else refreshWatchlistPrices();
  }
  if (finActiveSection === 'rates') {
    if (_ratesDetPair) _loadRatesChart(_ratesDetPair, _ratesDetRange);
    else loadRates(true);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CRYPTO
// ══════════════════════════════════════════════════════════════════════════════
function loadCrypto(force) {
  const el = document.getElementById('crypto-list'); if (!el) return;
  if (_cryptoList && !force) { _renderCryptoList(_cryptoList); return; }
  el.innerHTML = '<div class="fin-loading">Loading…</div>';
  fetch('/api/crypto?device='+deviceId)
    .then(r=>r.json()).then(d => {
      if (!Array.isArray(d)||!d.length) throw new Error('empty');
      _cryptoList = d; setLastUpdate(); _renderCryptoList(d);
    }).catch(() => { el.innerHTML = '<div class="fin-empty">Could not load — try again shortly</div>'; });
}

function _renderCryptoList(data) {
  const el = document.getElementById('crypto-list'); if (!el) return;
  el.innerHTML = data.map((c,i) => {
    const chg = c.price_change_percentage_24h ?? 0, up = chg >= 0;
    const mcap = c.market_cap >= 1e12 ? '$'+(c.market_cap/1e12).toFixed(2)+'T'
               : c.market_cap >= 1e9  ? '$'+(c.market_cap/1e9).toFixed(1)+'B'
               : c.market_cap >= 1e6  ? '$'+(c.market_cap/1e6).toFixed(0)+'M' : '';
    const vol  = c.total_volume >= 1e9 ? '$'+(c.total_volume/1e9).toFixed(1)+'B'
               : c.total_volume >= 1e6 ? '$'+(c.total_volume/1e6).toFixed(0)+'M' : '';
    return `<div class="coin-card" onclick="cryptoOpen('${_esc(c.id)}')">
      <span class="coin-rank">${i+1}</span>
      <img class="coin-img" src="${_esc(c.image||'')}" alt="" loading="lazy" onerror="this.style.opacity='.2'">
      <div class="coin-info">
        <div class="coin-name">${_esc(c.name)}</div>
        <div class="coin-sym">${_esc(c.symbol.toUpperCase())}${mcap?' · '+mcap:''}</div>
      </div>
      <div style="flex:1;min-width:0;padding:0 8px">
        <canvas class="coin-spark" id="cspark-${_esc(c.id)}" height="32" width="90"></canvas>
      </div>
      <div class="coin-price">
        <div class="coin-usd">${_fmtUSD(c.current_price)}</div>
        <div class="coin-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(2)}%</div>
        ${vol?`<div class="coin-mcap">Vol ${vol}</div>`:''}
      </div>
    </div>`;
  }).join('');
  // Draw sparklines (7d sparkline from CoinGecko)
  data.forEach(c => {
    const spark = c.sparkline_in_7d?.price;
    if (spark?.length > 2) {
      requestAnimationFrame(() => {
        const el = document.getElementById('cspark-'+c.id);
        const chg = c.price_change_percentage_24h ?? 0;
        if (el) drawSparkline(el, spark, chg >= 0);
      });
    }
  });
}

function cryptoOpen(id) {
  const coin = _cryptoList?.find(c => c.id === id); if (!coin) return;
  _cryptoDetId = id;
  _cryptoDetPrice = coin.current_price;
  document.getElementById('crypto-list-wrap').style.display = 'none';
  const wrap = document.getElementById('crypto-det-wrap');
  wrap.style.display = '';
  const chg = coin.price_change_percentage_24h ?? 0, up = chg >= 0;
  const ath = coin.ath ? `<div class="fin-stat"><div class="fin-stat-k">ATH</div><div class="fin-stat-v">${_fmtUSD(coin.ath)}</div></div>` : '';
  const atl = coin.atl ? `<div class="fin-stat"><div class="fin-stat-k">ATL</div><div class="fin-stat-v">${_fmtUSD(coin.atl)}</div></div>` : '';
  const circ = coin.circulating_supply ? `<div class="fin-stat"><div class="fin-stat-k">Circulating</div><div class="fin-stat-v">${(coin.circulating_supply/1e6).toFixed(2)}M ${_esc(coin.symbol.toUpperCase())}</div></div>` : '';
  document.getElementById('crypto-det').innerHTML = `
    <div class="fin-det-hero">
      <img class="fin-det-icon" src="${_esc(coin.image||'')}" alt="">
      <div>
        <div class="fin-det-name">${_esc(coin.name)} <span class="fin-det-sym">${_esc(coin.symbol.toUpperCase())}</span></div>
        <div class="fin-det-price">${_fmtUSD(coin.current_price)}</div>
        <div class="fin-det-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(2)}% (24h)</div>
      </div>
    </div>
    <div class="fin-section-lbl">Price History</div>
    <div class="cr-row">${_rangeHtml('',[[1,'1D'],[7,'7D'],[30,'1M'],[90,'3M'],[365,'1Y'],[1825,'5Y']],'cryptoChartRange',_cryptoDetRange)}</div>
    ${_chartWrap('crypto')}
    <div class="fin-section-lbl">Converter</div>
    <div class="fin-conv-box">
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="crypto-conv-coin" type="number" value="1" min="0" step="any" oninput="cryptoConvert('coin')">
        <span class="fin-conv-lbl">${_esc(coin.symbol.toUpperCase())}</span>
      </div>
      <div class="fin-conv-eq">=</div>
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="crypto-conv-usd" type="number" min="0" step="any" oninput="cryptoConvert('usd')" value="${_fmtUSD(coin.current_price).replace('$','')}">
        <span class="fin-conv-lbl">USD</span>
      </div>
    </div>
    <div class="fin-section-lbl">Statistics</div>
    <div class="fin-stat-grid">
      <div class="fin-stat"><div class="fin-stat-k">Market Cap</div><div class="fin-stat-v">${_fmtUSD(coin.market_cap,true)}</div></div>
      <div class="fin-stat"><div class="fin-stat-k">24h Volume</div><div class="fin-stat-v">${_fmtUSD(coin.total_volume,true)}</div></div>
      <div class="fin-stat"><div class="fin-stat-k">24h High</div><div class="fin-stat-v">${_fmtUSD(coin.high_24h)}</div></div>
      <div class="fin-stat"><div class="fin-stat-k">24h Low</div><div class="fin-stat-v">${_fmtUSD(coin.low_24h)}</div></div>
      ${ath}${atl}${circ}
    </div>`;
  _loadCryptoChart(id, _cryptoDetRange);
}

function cryptoClose() {
  _cryptoDetId = null;
  document.getElementById('crypto-det-wrap').style.display = 'none';
  document.getElementById('crypto-list-wrap').style.display = '';
}

function cryptoChartRange(days) {
  _cryptoDetRange = String(days);
  const lbl = {'1':'1D','7':'7D','30':'1M','90':'3M','365':'1Y','1825':'5Y'}[String(days)];
  document.querySelectorAll('#crypto-det .cr-btn').forEach(b => b.classList.toggle('on', b.textContent === lbl));
  if (_cryptoDetId) _loadCryptoChart(_cryptoDetId, days);
}

function _canvasMsg(canvas, msg) {
  if (!canvas) return;
  _cs = null;
  const ov = document.getElementById('crypto-ov') || document.getElementById('stock-ov') || document.getElementById('rates-ov');
  if (ov) { ov.onmousemove = null; ov.onmouseleave = null; const c = ov.getContext('2d'); if (c) c.clearRect(0,0,ov.width,ov.height); }
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 320, H = canvas.offsetHeight || 190;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(msg, W / 2, H / 2);
}

async function _loadCryptoChart(id, days) {
  const canvas = document.getElementById('crypto-chart');
  const daysNum = parseInt(days) || 30;
  _canvasMsg(canvas, 'Loading…');
  try {
    const r = await fetch(`/api/crypto/history?id=${encodeURIComponent(id)}&days=${days}&device=${deviceId}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.prices?.length) throw new Error('No price data');
    const prices = d.prices.map(([,p]) => p);
    const times  = d.prices.map(([t]) => {
      const dt = new Date(t);
      if (daysNum <= 1)  return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      if (daysNum <= 90) return dt.toLocaleDateString([],{month:'short',day:'numeric'});
      return dt.toLocaleDateString([],{month:'short',year:'2-digit'});
    });
    const first = prices.find(v=>v!=null), last = [...prices].reverse().find(v=>v!=null);
    const up = (last||0) >= (first||0);
    requestAnimationFrame(() => {
      drawChart(document.getElementById('crypto-chart'), prices, times, {color: up?'#34d399':'#f87171'});
      initChartHover(document.getElementById('crypto-ov'));
    });
    setLastUpdate();
  } catch(e) {
    _canvasMsg(canvas, 'Unavailable — ' + (e.message||'try again'));
  }
}

function cryptoConvert(dir) {
  const price = _cryptoDetPrice; if (!price) return;
  const coinInp = document.getElementById('crypto-conv-coin');
  const usdInp  = document.getElementById('crypto-conv-usd');
  if (!coinInp || !usdInp) return;
  if (dir === 'coin') {
    const amt = parseFloat(coinInp.value) || 0;
    usdInp.value = (amt * price).toFixed(2);
  } else {
    const amt = parseFloat(usdInp.value) || 0;
    coinInp.value = (amt / price).toPrecision(6);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STOCKS
// ══════════════════════════════════════════════════════════════════════════════
function stockSearchDebounced() {
  clearTimeout(_stockSearchTimer);
  _stockSearchTimer = setTimeout(_stockSearch, 280);
}

async function _stockSearch() {
  const q = (document.getElementById('stock-search-inp')?.value || '').trim();
  const drop = document.getElementById('stock-search-drop'); if (!drop) return;
  if (q.length < 1) { drop.style.display='none'; return; }
  drop.style.display = '';
  drop.innerHTML = '<div class="fin-drop-item" style="color:var(--text-muted)">Searching…</div>';
  try {
    const r = await fetch('/api/stock/search?q='+encodeURIComponent(q)+'&device='+deviceId);
    const d = await r.json();
    const quotes = (d.quotes||[]).filter(q => ['EQUITY','ETF','INDEX','MUTUALFUND'].includes(q.quoteType));
    if (!quotes.length) { drop.innerHTML='<div class="fin-drop-item" style="color:var(--text-muted)">No results</div>'; return; }
    drop.innerHTML = quotes.slice(0,7).map(q =>
      `<div class="fin-drop-item" onclick="stockAdd('${_esc(q.symbol)}','${_esc((q.shortname||q.longname||'').replace(/'/g,''))}')">
        <span class="fin-drop-sym">${_esc(q.symbol)}</span>
        <span class="fin-drop-name">${_esc(q.shortname||q.longname||'')}</span>
        <span class="fin-drop-type">${_esc(q.quoteType||'')}</span>
      </div>`
    ).join('');
  } catch { drop.innerHTML='<div class="fin-drop-item" style="color:var(--text-muted)">Error</div>'; }
}

function stockAdd(sym, name) {
  const inp = document.getElementById('stock-search-inp');
  const drop = document.getElementById('stock-search-drop');
  if (inp) inp.value = '';
  if (drop) drop.style.display = 'none';
  if (!stockWatchlist.find(s => s.sym === sym)) {
    stockWatchlist.push({sym, name});
    localStorage.setItem('stockWatchlist', JSON.stringify(stockWatchlist));
  }
  renderWatchlist();
  stockOpen(sym, name);
}

function stockRemove(sym, e) {
  e.stopPropagation();
  stockWatchlist = stockWatchlist.filter(s => s.sym !== sym);
  localStorage.setItem('stockWatchlist', JSON.stringify(stockWatchlist));
  if (_stockDetSym === sym) { _stockDetSym = null; document.getElementById('stock-det-wrap').style.display='none'; document.getElementById('stocks-list-wrap').style.display=''; }
  renderWatchlist();
}

async function renderWatchlist() {
  const el = document.getElementById('stock-watchlist'); if (!el) return;
  if (!stockWatchlist.length) {
    el.innerHTML = '<div class="fin-empty">Search for a stock, ETF or index to build your watchlist</div>';
    return;
  }
  el.innerHTML = stockWatchlist.map(s =>
    `<div class="stock-card${_stockDetSym===s.sym?' on':''}" onclick="stockOpen('${_esc(s.sym)}','${_esc((s.name||'').replace(/'/g,''))}')">
      <div class="stock-wl-info">
        <div class="stock-sym">${_esc(s.sym)}</div>
        <div class="stock-name">${_esc(s.name||'')}</div>
      </div>
      <canvas class="fin-mini-spark" id="wl-spark-${_esc(s.sym)}" height="30" width="80"></canvas>
      <div class="stock-price">
        <div class="stock-px" id="wl-px-${_esc(s.sym)}">—</div>
        <div class="stock-chg" id="wl-ch-${_esc(s.sym)}">…</div>
      </div>
      <button class="fin-remove-btn" onclick="stockRemove('${_esc(s.sym)}',event)" title="Remove">×</button>
    </div>`
  ).join('');
  refreshWatchlistPrices();
}

async function refreshWatchlistPrices() {
  for (const s of stockWatchlist) {
    try {
      const r = await fetch('/api/stock?symbol='+encodeURIComponent(s.sym)+'&range=5d&device='+deviceId);
      const d = await r.json();
      const res = d?.chart?.result?.[0]; if (!res) continue;
      const meta   = res.meta;
      const closes = res.indicators?.quote?.[0]?.close || [];
      const price  = meta.regularMarketPrice ?? meta.chartPreviousClose;
      const prev   = meta.chartPreviousClose || closes[closes.length-2] || price;
      const chg    = prev ? (price-prev)/prev*100 : 0;
      const up     = chg >= 0;
      const pxEl   = document.getElementById('wl-px-'+s.sym);
      const chEl   = document.getElementById('wl-ch-'+s.sym);
      const spEl   = document.getElementById('wl-spark-'+s.sym);
      if (pxEl) pxEl.textContent = _fmtCurr(price, meta.currency||'USD');
      if (chEl) { chEl.textContent=(up?'▲':'▼')+' '+Math.abs(chg).toFixed(2)+'%'; chEl.className='stock-chg '+(up?'up':'down'); }
      if (spEl) drawSparkline(spEl, closes.filter(v=>v!=null), up);
    } catch {}
  }
  setLastUpdate();
}

function stockOpen(sym, name) {
  _stockDetSym = sym;
  document.getElementById('stocks-list-wrap').style.display = 'none';
  const wrap = document.getElementById('stock-det-wrap'); wrap.style.display = '';
  document.getElementById('stock-det').innerHTML = `
    <div class="fin-det-hero stock-det-hero">
      <div>
        <div class="fin-det-name">${_esc(sym)} <span class="fin-det-sym">${_esc(name||'')}</span></div>
        <div class="fin-det-price" id="sd-price">…</div>
        <div class="fin-det-chg"   id="sd-chg"></div>
      </div>
    </div>
    <div class="fin-section-lbl">Price History</div>
    <div class="cr-row">${_rangeHtml('',[[('1d'),'1D'],[('5d'),'5D'],[('1mo'),'1M'],[('3mo'),'3M'],[('6mo'),'6M'],[('1y'),'1Y'],[('5y'),'5Y'],[('max'),'MAX']],'stockChartRange',_stockDetRange)}</div>
    ${_chartWrap('stock')}
    <div class="fin-section-lbl">Converter</div>
    <div class="fin-conv-box">
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="sd-conv-amt" type="number" value="1000" min="0" step="any" oninput="stockConvert('usd')">
        <span class="fin-conv-lbl" id="sd-conv-curr">USD</span>
      </div>
      <div class="fin-conv-eq">=</div>
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="sd-conv-shares" type="number" min="0" step="any" oninput="stockConvert('shares')">
        <span class="fin-conv-lbl">shares</span>
      </div>
    </div>
    <div class="fin-section-lbl">Statistics</div>
    <div class="fin-stat-grid" id="sd-stats"></div>`;
  _loadStockDetail(sym, _stockDetRange);
}

function stockClose() {
  _stockDetSym = null;
  document.getElementById('stock-det-wrap').style.display = 'none';
  document.getElementById('stocks-list-wrap').style.display = '';
  renderWatchlist();
}

function stockChartRange(range) {
  _stockDetRange = range;
  document.querySelectorAll('#stock-det .cr-btn').forEach(b => {
    const m={'1d':'1D','5d':'5D','1mo':'1M','3mo':'3M','6mo':'6M','1y':'1Y','5y':'5Y','max':'MAX'};
    b.classList.toggle('on', b.textContent === (m[range]||range));
  });
  if (_stockDetSym) _loadStockDetail(_stockDetSym, range);
}

async function _loadStockDetail(sym, range) {
  try {
    const r = await fetch('/api/stock?symbol='+encodeURIComponent(sym)+'&range='+range+'&device='+deviceId);
    const d = await r.json();
    const res = d?.chart?.result?.[0]; if (!res) return;
    const meta   = res.meta;
    const ts     = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    const price  = meta.regularMarketPrice ?? closes.filter(v=>v!=null).pop();
    const prev   = meta.chartPreviousClose || meta.previousClose || closes[0];
    const chg    = prev ? (price-prev)/prev*100 : 0;
    const abs    = Math.abs(price-(prev||0));
    const up     = chg >= 0;
    const cur    = meta.currency || 'USD';
    _stockDetPrice    = price;
    _stockDetCurrency = cur;

    const pxEl = document.getElementById('sd-price'), chEl = document.getElementById('sd-chg');
    if (pxEl) pxEl.textContent = _fmtCurr(price, cur);
    if (chEl) {
      chEl.textContent = (up?'▲':'▼')+' '+_fmtCurr(abs,cur)+' ('+Math.abs(chg).toFixed(2)+'%)';
      chEl.className = 'fin-det-chg '+(up?'up':'down');
    }
    const curEl = document.getElementById('sd-conv-curr');
    if (curEl) curEl.textContent = cur;
    stockConvert('usd');

    const stats = [
      ['Open',   _fmtCurr(meta.regularMarketOpen ?? meta.open, cur)],
      ['Prev Close', _fmtCurr(prev, cur)],
      ['High',   _fmtCurr(meta.regularMarketDayHigh ?? meta.dayHigh, cur)],
      ['Low',    _fmtCurr(meta.regularMarketDayLow ?? meta.dayLow, cur)],
      ['52W High', _fmtCurr(meta.fiftyTwoWeekHigh, cur)],
      ['52W Low',  _fmtCurr(meta.fiftyTwoWeekLow,  cur)],
    ];
    const statsEl = document.getElementById('sd-stats');
    if (statsEl) statsEl.innerHTML = stats.filter(([,v])=>v&&v!=='—').map(([k,v]) =>
      `<div class="fin-stat"><div class="fin-stat-k">${k}</div><div class="fin-stat-v">${v}</div></div>`
    ).join('');

    const labels = ts.map(t => {
      const dt = new Date(t*1000);
      return range==='1d'||range==='5d'
        ? dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        : range==='max'||range==='5y'
        ? dt.toLocaleDateString([],{month:'short',year:'2-digit'})
        : dt.toLocaleDateString([],{month:'short',day:'numeric'});
    });
    requestAnimationFrame(() => {
      drawChart(document.getElementById('stock-chart'), closes, labels, {color:up?'#34d399':'#f87171'});
      initChartHover(document.getElementById('stock-ov'));
    });
    setLastUpdate();
  } catch(e) { console.error('stock detail:', e); }
}

function stockConvert(dir) {
  const price = _stockDetPrice; if (!price) return;
  const amtEl    = document.getElementById('sd-conv-amt');
  const sharesEl = document.getElementById('sd-conv-shares');
  if (!amtEl || !sharesEl) return;
  if (dir === 'usd') {
    const usd = parseFloat(amtEl.value) || 0;
    sharesEl.value = (usd / price).toFixed(4);
  } else {
    const sh = parseFloat(sharesEl.value) || 0;
    amtEl.value = (sh * price).toFixed(2);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EXCHANGE RATES
// ══════════════════════════════════════════════════════════════════════════════
const CURR_META = {
  USD:{f:'🇺🇸',n:'US Dollar'},EUR:{f:'🇪🇺',n:'Euro'},GBP:{f:'🇬🇧',n:'British Pound'},
  JPY:{f:'🇯🇵',n:'Japanese Yen'},ZAR:{f:'🇿🇦',n:'S. African Rand'},AUD:{f:'🇦🇺',n:'Australian Dollar'},
  CAD:{f:'🇨🇦',n:'Canadian Dollar'},CHF:{f:'🇨🇭',n:'Swiss Franc'},CNY:{f:'🇨🇳',n:'Chinese Yuan'},
  INR:{f:'🇮🇳',n:'Indian Rupee'},BRL:{f:'🇧🇷',n:'Brazilian Real'},MXN:{f:'🇲🇽',n:'Mexican Peso'},
  KRW:{f:'🇰🇷',n:'South Korean Won'},SGD:{f:'🇸🇬',n:'Singapore Dollar'},NOK:{f:'🇳🇴',n:'Norwegian Krone'},
  SEK:{f:'🇸🇪',n:'Swedish Krona'},DKK:{f:'🇩🇰',n:'Danish Krone'},NZD:{f:'🇳🇿',n:'New Zealand Dollar'},
  HKD:{f:'🇭🇰',n:'Hong Kong Dollar'},TRY:{f:'🇹🇷',n:'Turkish Lira'},
  AED:{f:'🇦🇪',n:'UAE Dirham'},SAR:{f:'🇸🇦',n:'Saudi Riyal'},PKR:{f:'🇵🇰',n:'Pakistani Rupee'},
  IDR:{f:'🇮🇩',n:'Indonesian Rupiah'},MYR:{f:'🇲🇾',n:'Malaysian Ringgit'},PHP:{f:'🇵🇭',n:'Philippine Peso'},
  THB:{f:'🇹🇭',n:'Thai Baht'},CZK:{f:'🇨🇿',n:'Czech Koruna'},PLN:{f:'🇵🇱',n:'Polish Zloty'},
  TWD:{f:'🇹🇼',n:'Taiwan Dollar'},ILS:{f:'🇮🇱',n:'Israeli Shekel'},HUF:{f:'🇭🇺',n:'Hungarian Forint'},
};
const RATES_PRIORITY = ['EUR','GBP','JPY','ZAR','AUD','CAD','CHF','CNY','INR','BRL','MXN','KRW','SGD','NZD','HKD'];

async function loadRates(force) {
  const sel = document.getElementById('rates-base');
  if (sel) _ratesBase = sel.value;
  const el = document.getElementById('rates-list'); if (!el) return;
  if (_ratesList && _ratesList.base === _ratesBase && !force) { _renderRatesList(_ratesList); return; }
  el.innerHTML = '<div class="fin-loading">Loading…</div>';
  try {
    const r = await fetch('/api/rates?base='+_ratesBase+'&device='+deviceId);
    _ratesList = await r.json();
    setLastUpdate(); _renderRatesList(_ratesList);
    _loadRatesSparklines();
  } catch { el.innerHTML = '<div class="fin-empty">Could not load rates</div>'; }
}

function _renderRatesList(data) {
  const el = document.getElementById('rates-list'); if (!el || !data?.rates) return;
  const all = Object.keys(data.rates);
  const ordered = RATES_PRIORITY.filter(c => c !== data.base && all.includes(c))
    .concat(all.filter(c => !RATES_PRIORITY.includes(c) && c !== data.base));
  el.innerHTML = ordered.map(c => {
    const m = CURR_META[c] || {};
    return `<div class="rate-card" id="rc-${c}" onclick="ratesOpen('${c}')">
      <span class="rate-flag">${m.f||'🏳'}</span>
      <div class="rate-info">
        <span class="rate-sym">${c}</span>
        <span class="rate-name">${m.n||c}</span>
      </div>
      <canvas class="fin-mini-spark" id="rs-${c}" height="28" width="72"></canvas>
      <div class="rate-right">
        <div class="rate-val">${_fmtRate(data.rates[c])}</div>
        <div class="rate-chg" id="rc-chg-${c}">…</div>
      </div>
    </div>`;
  }).join('');
}

async function _loadRatesSparklines() {
  const pairs = RATES_PRIORITY.filter(c=>c!==_ratesBase).slice(0,10).join(',');
  try {
    const r = await fetch('/api/rates/history?base='+_ratesBase+'&to='+pairs+'&days=30&device='+deviceId);
    const d = await r.json(); if (!d?.rates) return;
    const dates = Object.keys(d.rates).sort();
    const firstDay = d.rates[dates[0]], lastDay = d.rates[dates[dates.length-1]];
    if (!firstDay) return;
    Object.keys(firstDay).forEach(c => {
      const vals = dates.map(dt => d.rates[dt]?.[c]).filter(v=>v!=null);
      const spEl = document.getElementById('rs-'+c);
      const chgEl= document.getElementById('rc-chg-'+c);
      if (spEl && vals.length > 2) {
        const st = vals[0], en = vals[vals.length-1];
        drawSparkline(spEl, vals, en >= st);
        if (chgEl) {
          const p = (en-st)/st*100;
          chgEl.textContent = (p>=0?'▲':'▼')+' '+Math.abs(p).toFixed(2)+'%';
          chgEl.className = 'rate-chg '+(p>=0?'up':'down');
        }
      }
    });
    _ratesHistCache[_ratesBase+'_30'] = d;
  } catch {}
}

function ratesOpen(pair) {
  _ratesDetPair = pair;
  _ratesConvRate = _ratesList?.rates?.[pair] || 1;
  _ratesConvFromLbl = _ratesBase;
  _ratesConvToLbl   = pair;
  document.getElementById('rates-list-wrap').style.display = 'none';
  const wrap = document.getElementById('rates-det-wrap'); wrap.style.display = '';
  const mf = CURR_META[_ratesBase]||{}, mt = CURR_META[pair]||{};
  document.getElementById('rates-det').innerHTML = `
    <div class="fin-det-hero">
      <div>
        <div class="fin-det-name">${mf.f||''} ${_ratesBase} / ${mt.f||''} ${pair}</div>
        <div class="fin-det-subname">${mf.n||_ratesBase} to ${mt.n||pair}</div>
        <div class="fin-det-price">1 ${_ratesBase} = ${_fmtRate(_ratesConvRate)} ${pair}</div>
      </div>
    </div>
    <div class="fin-section-lbl">Exchange Rate History</div>
    <div class="cr-row">${_rangeHtml('',[[30,'1M'],[90,'3M'],[180,'6M'],[365,'1Y'],[1825,'5Y']],'ratesChartRange',_ratesDetRange)}</div>
    ${_chartWrap('rates')}
    <div class="fin-section-lbl">Converter</div>
    <div class="fin-conv-box">
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="rates-from-amt" type="number" value="1" min="0" step="any" oninput="ratesConvert('from')">
        <span class="fin-conv-lbl" id="rates-from-lbl">${_ratesBase}</span>
      </div>
      <button class="fin-conv-swap" onclick="ratesConvSwap()" title="Swap">⇄</button>
      <div class="fin-conv-row">
        <input class="fin-conv-inp" id="rates-to-amt" type="number" min="0" step="any" oninput="ratesConvert('to')">
        <span class="fin-conv-lbl" id="rates-to-lbl">${pair}</span>
      </div>
    </div>`;
  ratesConvert('from');
  _loadRatesChart(pair, _ratesDetRange);
}

function ratesClose() {
  _ratesDetPair = null;
  document.getElementById('rates-det-wrap').style.display = 'none';
  document.getElementById('rates-list-wrap').style.display = '';
}

function ratesChartRange(days) {
  _ratesDetRange = String(days);
  document.querySelectorAll('#rates-det .cr-btn').forEach(b => {
    const m={'30':'1M','90':'3M','180':'6M','365':'1Y','1825':'5Y'};
    b.classList.toggle('on', b.textContent === (m[String(days)]||String(days)));
  });
  if (_ratesDetPair) _loadRatesChart(_ratesDetPair, days);
}

async function _loadRatesChart(pair, days) {
  const canvas = document.getElementById('rates-chart');
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 320, H = canvas.offsetHeight || 190;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Loading…', W / 2, H / 2);
  }
  try {
    const r = await fetch('/api/rates/history?base='+_ratesBase+'&to='+pair+'&days='+days+'&device='+deviceId);
    const d = await r.json(); if (!d?.rates) throw new Error('no data');
    const dates = Object.keys(d.rates).sort();
    const vals  = dates.map(dt => d.rates[dt]?.[pair]);
    const labels = dates.map(dt => {
      const [,m,dy] = dt.split('-');
      return parseInt(days) > 365 ? dt.slice(0,4) : m+'/'+dy;
    });
    const st = vals.find(v=>v!=null), en = [...vals].reverse().find(v=>v!=null);
    requestAnimationFrame(() => {
      drawChart(document.getElementById('rates-chart'), vals, labels, {color:(en||0)>=(st||0)?'#34d399':'#f87171', rateMode:true});
      initChartHover(document.getElementById('rates-ov'));
    });
    setLastUpdate();
  } catch {
    if (canvas) {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.offsetWidth || 320, H = canvas.offsetHeight || 190;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
      ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Chart data unavailable', W / 2, H / 2);
    }
  }
}

function ratesConvert(dir) {
  const fromEl = document.getElementById('rates-from-amt');
  const toEl   = document.getElementById('rates-to-amt');
  if (!fromEl || !toEl) return;
  if (dir === 'from') {
    const v = parseFloat(fromEl.value) || 0;
    toEl.value = (v * _ratesConvRate).toFixed(4);
  } else {
    const v = parseFloat(toEl.value) || 0;
    fromEl.value = _ratesConvRate ? (v / _ratesConvRate).toFixed(4) : '—';
  }
}

function ratesConvSwap() {
  const fromLbl = document.getElementById('rates-from-lbl');
  const toLbl   = document.getElementById('rates-to-lbl');
  const fromEl  = document.getElementById('rates-from-amt');
  const toEl    = document.getElementById('rates-to-amt');
  if (!fromLbl || !toLbl) return;
  // Swap labels
  [_ratesConvFromLbl, _ratesConvToLbl] = [_ratesConvToLbl, _ratesConvFromLbl];
  fromLbl.textContent = _ratesConvFromLbl;
  toLbl.textContent   = _ratesConvToLbl;
  // Invert rate
  _ratesConvRate = _ratesConvRate ? 1 / _ratesConvRate : 1;
  // Move current TO value into FROM and recalculate
  if (toEl && fromEl) { fromEl.value = toEl.value; }
  ratesConvert('from');
}
