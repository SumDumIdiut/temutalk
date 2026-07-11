// ── System ────────────────────────────────────────────────────────────────
let sysAutoInterval = null;

function toggleSysAuto(on) {
  clearInterval(sysAutoInterval);
  if (on) { loadSystem(); sysAutoInterval = setInterval(loadSystem, 5000); }
}

function loadSystem() {
  fetch(BASE_PATH + '/api/system?device=' + deviceId).then(r => r.json()).then(d => {
    const cardsEl = document.getElementById('sys-cards');
    const infoEl  = document.getElementById('sys-info-list');
    const procEl  = document.getElementById('sys-proc-list');
    const netEl   = document.getElementById('sys-net-list');
    const luEl    = document.getElementById('sys-last-update');
    if (!cardsEl) return;

    if (luEl) luEl.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    const memPct  = d.memPct || 0;
    const load1   = d.loadAvg?.[0] || 0;
    const loadPct = Math.min(100, (load1 / Math.max(1, d.cpuCount)) * 100);
    const upSec   = d.uptime || 0;
    const upStr   = fmtUptime(upSec);
    const memUsed = fmtBytes(d.usedMem);
    const memTot  = fmtBytes(d.totalMem);

    cardsEl.innerHTML =
      sysCard('Memory',   memUsed,         'of ' + memTot,                memPct,  memPct  > 90 ? 'danger' : memPct  > 75 ? 'warn' : '') +
      sysCard('CPU Load', load1.toFixed(2),' / ' + (d.cpuCount||1) + ' cores', loadPct, loadPct > 85 ? 'danger' : loadPct > 65 ? 'warn' : '') +
      sysCard('Uptime',   upStr,           'system running',              0, '') +
      sysCard('Process',  fmtUptime(d.procUptime || 0), 'node ' + (d.nodeVersion||''), 0, '');

    if (infoEl) infoEl.innerHTML =
      sysRow('Hostname',   d.hostname) +
      sysRow('Platform',   d.platform + ' ' + (d.arch||'')) +
      sysRow('CPU',        d.cpuModel + (d.cpuSpeed ? ' @ ' + d.cpuSpeed : '')) +
      sysRow('Load avg',   (d.loadAvg||[]).map((l,i)=>['1m','5m','15m'][i]+': '+l).join('  '));

    if (procEl) {
      const heap     = fmtBytes(d.heapUsed);
      const heapTot  = fmtBytes(d.heapTotal);
      const rss      = fmtBytes(d.rss);
      const heapPct  = d.heapTotal ? +(d.heapUsed/d.heapTotal*100).toFixed(1) : 0;
      procEl.innerHTML =
        sysRow('PID',        String(d.pid)) +
        sysRow('Heap',       heap + ' / ' + heapTot) +
        sysRow('RSS',        rss) +
        '<div class="sys-bar-wrap" style="margin:4px 0 10px;"><div class="sys-bar' + (heapPct>85?' danger':heapPct>65?' warn':'') + '" style="width:' + heapPct + '%"></div></div>';
    }

    if (netEl) {
      const nets = d.network || [];
      netEl.innerHTML = nets.length
        ? nets.map(n => '<div class="sys-net-card"><div class="sys-net-name">' + esc(n.name) + '</div>' +
            '<div class="sys-net-addr">' + esc(n.address) + '</div>' +
            (n.mac && n.mac !== '00:00:00:00:00:00' ? '<div class="sys-net-addr" style="opacity:.6;">' + esc(n.mac) + '</div>' : '') +
            '</div>').join('')
        : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No network interfaces found</div>';
    }
  }).catch(() => {
    const cardsEl = document.getElementById('sys-cards');
    if (cardsEl) cardsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;grid-column:span 2;padding:12px 0;">Could not load system stats</div>';
  });
}

function fmtBytes(b) {
  if (!b) return '0 B';
  if (b >= 1073741824) return (b/1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)    return (b/1048576).toFixed(0) + ' MB';
  if (b >= 1024)       return (b/1024).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtUptime(s) {
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d ? d + 'd ' + h + 'h ' + m + 'm' : h ? h + 'h ' + m + 'm' : m + 'm ' + (s%60) + 's';
}
function sysCard(label, val, sub, pct, barCls) {
  return '<div class="sys-card">' +
    '<div class="sys-card-label">' + esc(label) + '</div>' +
    '<div class="sys-card-val">'   + esc(String(val)) + '</div>' +
    '<div class="sys-card-sub">'   + esc(String(sub)) + '</div>' +
    (pct > 0 ? '<div class="sys-bar-wrap"><div class="sys-bar' + (barCls?' '+barCls:'') + '" style="width:' + (+pct).toFixed(1) + '%"></div></div>' : '') +
    '</div>';
}
function sysRow(label, val) {
  return '<div class="sys-row"><span class="sys-row-label">' + esc(label) + '</span><span class="sys-row-val">' + esc(String(val||'')) + '</span></div>';
}

