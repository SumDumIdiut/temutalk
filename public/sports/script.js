// ── Sports tab ─────────────────────────────────────────────────────────────────
let sportsCurSport = 'soccer', sportsCurLeague = 'eng.1';
let sportsLoaded = false, sportsRefreshTimer = null;

function sportsInit() {
  if (!sportsLoaded) { sportsLoaded = true; sportsLoad(); }
}

function sportsSelect(btn, sport, league) {
  sportsCurSport = sport; sportsCurLeague = league;
  document.querySelectorAll('.sports-ltab').forEach(b => b.classList.toggle('on', b === btn));
  sportsLoad();
}

function sportsRefresh() { sportsLoad(true); }

async function sportsLoad(force) {
  const el = document.getElementById('sports-scoreboard');
  if (!el) return;
  el.innerHTML = '<div class="sports-loading">Loading…</div>';
  if (sportsRefreshTimer) clearTimeout(sportsRefreshTimer);
  try {
    const r = await fetch('/api/sports?sport=' + encodeURIComponent(sportsCurSport) + '&league=' + encodeURIComponent(sportsCurLeague) + '&device=' + deviceId);
    const d = await r.json();
    const events = d.events || [];
    const lu = document.getElementById('sports-last-update');
    if (lu) lu.textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    if (!events.length) {
      el.innerHTML = '<div class="sports-empty">No games scheduled at the moment.<br><span style="font-size:12px">Check back when the season is active.</span></div>';
      return;
    }
    // Group by date
    const byDate = {};
    events.forEach(ev => {
      const dt = new Date(ev.date);
      const key = dt.toLocaleDateString([], {weekday:'long', month:'long', day:'numeric'});
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(ev);
    });
    let html = '';
    for (const [date, evs] of Object.entries(byDate)) {
      html += '<div class="sports-section-hdr">' + escS(date) + '</div>';
      html += evs.map(ev => renderGameCard(ev)).join('');
    }
    el.innerHTML = html;
    // Auto-refresh live games every 60s
    const hasLive = events.some(e => e.status?.type?.state === 'in');
    if (hasLive) sportsRefreshTimer = setTimeout(() => sportsLoad(), 60000);
  } catch (e) {
    el.innerHTML = '<div class="sports-empty">Could not load scores.<br><small>' + escS(String(e.message||'')) + '</small></div>';
  }
}

function renderGameCard(ev) {
  const comps  = ev.competitions?.[0] || {};
  const compts = comps.competitors || [];
  const status = ev.status || {};
  const stateType = status.type?.state || 'pre';
  const stateDisp = status.type?.shortDetail || status.type?.description || stateType;
  const statusClass = stateType === 'in' ? 'live' : stateType === 'post' ? 'final' : 'pre';

  const home = compts.find(c => c.homeAway === 'home') || compts[0] || {};
  const away = compts.find(c => c.homeAway === 'away') || compts[1] || {};

  const homeWin = stateType === 'post' && parseInt(home.score||0) > parseInt(away.score||0);
  const awayWin = stateType === 'post' && parseInt(away.score||0) > parseInt(home.score||0);

  const teamRow = (t, isWinner) => {
    const logo = t.team?.logo;
    const abbr = t.team?.abbreviation || t.team?.displayName || '?';
    const name = t.team?.displayName || abbr;
    const score = stateType !== 'pre' && t.score != null ? String(t.score) : '';
    return '<div class="game-team">' +
      (logo ? '<img class="team-logo" src="' + escS(logo) + '" alt="" loading="lazy" onerror="this.style.opacity=\'.3\'">'
             : '<div class="team-logo-placeholder">' + escS(abbr.slice(0,2)) + '</div>') +
      '<span class="team-name' + (isWinner ? ' winner' : '') + '">' + escS(name) + '</span>' +
      (score ? '<span class="team-score' + (isWinner ? ' winner' : '') + '">' + escS(score) + '</span>' : '') +
      '</div>';
  };

  const venue = comps.venue?.fullName;
  const broadcast = (comps.broadcasts || []).map(b => b.names?.join(', ')).filter(Boolean).join(' · ');
  const timeStr = stateType === 'pre' ? new Date(ev.date).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : stateDisp;

  return '<div class="game-card">' +
    '<div class="game-status ' + statusClass + '">' + escS(timeStr) + (stateType === 'in' ? ' 🔴 LIVE' : '') + '</div>' +
    '<div class="game-teams">' + teamRow(away, awayWin) + teamRow(home, homeWin) + '</div>' +
    ((venue || broadcast) ? '<div class="game-meta">' + (venue ? escS(venue) : '') + (broadcast ? (venue ? ' · ' : '') + escS(broadcast) : '') + '</div>' : '') +
    '</div>';
}

function escS(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
