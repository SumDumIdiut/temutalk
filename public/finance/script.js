// ── Finance / Crypto ──────────────────────────────────────────────────────
let financeLoaded = false, cryptoData = null;

function loadCrypto(force) {
  const el = document.getElementById('crypto-list');
  if (!el) return;
  if (cryptoData && !force) { renderCrypto(cryptoData); return; }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px 0;text-align:center;">Loading…</div>';
  fetch('/api/crypto?device=' + deviceId)
    .then(r => r.json()).then(data => {
      if (!Array.isArray(data) || !data.length) throw new Error('empty');
      cryptoData = data;
      const lu = document.getElementById('finance-last-update');
      if (lu) lu.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      renderCrypto(data);
    }).catch(() => {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px 0;text-align:center;">Could not load market data.<br>CoinGecko may be rate-limiting — try again in a minute.</div>';
    });
}
function renderCrypto(data) {
  const el = document.getElementById('crypto-list');
  if (!el || !Array.isArray(data)) return;
  el.innerHTML = data.map((c, i) => {
    const chg  = c.price_change_percentage_24h ?? 0;
    const up   = chg >= 0;
    const absChg = Math.abs(chg).toFixed(2);
    const price = c.current_price >= 1000
      ? c.current_price.toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits: 0 })
      : c.current_price >= 1
      ? c.current_price.toLocaleString('en-US', { style:'currency', currency:'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '$' + c.current_price.toPrecision(4);
    const mcap = c.market_cap >= 1e12 ? '$' + (c.market_cap/1e12).toFixed(2) + 'T'
               : c.market_cap >= 1e9  ? '$' + (c.market_cap/1e9).toFixed(1)  + 'B'
               : c.market_cap >= 1e6  ? '$' + (c.market_cap/1e6).toFixed(0)  + 'M' : '';
    const vol  = c.total_volume >= 1e9 ? '$' + (c.total_volume/1e9).toFixed(1) + 'B'
               : c.total_volume >= 1e6 ? '$' + (c.total_volume/1e6).toFixed(0) + 'M' : '';
    return '<div class="coin-card">' +
      '<span class="coin-rank">' + (i+1) + '</span>' +
      '<img class="coin-img" src="' + esc(c.image || '') + '" alt="" loading="lazy" onerror="this.style.opacity=\'.3\'">' +
      '<div class="coin-info">' +
        '<div class="coin-name">' + esc(c.name) + '</div>' +
        '<div class="coin-sym">' + esc(c.symbol) + (mcap ? ' · ' + mcap : '') + '</div>' +
      '</div>' +
      '<div class="coin-price">' +
        '<div class="coin-usd">' + price + '</div>' +
        '<div class="coin-chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' + absChg + '%</div>' +
        (vol ? '<div class="coin-mcap">Vol ' + vol + '</div>' : '') +
      '</div></div>';
  }).join('');
}
