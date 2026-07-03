// ── Sports tab ─────────────────────────────────────────────────────────────────

const SPORTS_CATS = [
  { id:'soccer', icon:'⚽', label:'Soccer', leagues:[
    { sport:'soccer', league:'fifa.world',     label:'World Cup',      flag:'🌍' },
    { sport:'soccer', league:'eng.1',          label:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { sport:'soccer', league:'esp.1',          label:'La Liga',        flag:'🇪🇸' },
    { sport:'soccer', league:'ger.1',          label:'Bundesliga',     flag:'🇩🇪' },
    { sport:'soccer', league:'ita.1',          label:'Serie A',        flag:'🇮🇹' },
    { sport:'soccer', league:'fra.1',          label:'Ligue 1',        flag:'🇫🇷' },
    { sport:'soccer', league:'usa.1',          label:'MLS',            flag:'🇺🇸' },
    { sport:'soccer', league:'rsa.1',          label:'PSL',            flag:'🇿🇦' },
    { sport:'soccer', league:'uefa.champions', label:'UCL',            flag:'🏆' },
    { sport:'soccer', league:'eng.fa_cup',     label:'FA Cup',         flag:'🏆' },
  ]},
  { id:'basketball', icon:'🏀', label:'Basketball', leagues:[
    { sport:'basketball', league:'nba',                     label:'NBA' },
    { sport:'basketball', league:'mens-college-basketball', label:'NCAA' },
    { sport:'basketball', league:'wnba',                    label:'WNBA' },
  ]},
  { id:'football', icon:'🏈', label:'Football', leagues:[
    { sport:'american-football', league:'nfl',             label:'NFL' },
    { sport:'american-football', league:'college-football', label:'College' },
  ]},
  { id:'baseball', icon:'⚾', label:'Baseball', leagues:[
    { sport:'baseball', league:'mlb', label:'MLB' },
  ]},
  { id:'hockey', icon:'🏒', label:'Hockey', leagues:[
    { sport:'hockey', league:'nhl', label:'NHL' },
  ]},
  { id:'tennis', icon:'🎾', label:'Tennis', leagues:[
    { sport:'tennis', league:'atp', label:'ATP' },
    { sport:'tennis', league:'wta', label:'WTA' },
  ]},
  { id:'rugby', icon:'🏉', label:'Rugby', leagues:[
    { sport:'rugby-union', league:'urc',           label:'URC' },
    { sport:'rugby-union', league:'international', label:'International' },
  ]},
  { id:'combat', icon:'🥊', label:'Combat', leagues:[
    { sport:'mma', league:'ufc', label:'UFC' },
  ]},
  { id:'golf', icon:'⛳', label:'Golf', leagues:[
    { sport:'golf', league:'pga',  label:'PGA' },
    { sport:'golf', league:'lpga', label:'LPGA' },
  ]},
  { id:'cricket', icon:'🏏', label:'Cricket', leagues:[
    { sport:'cricket', league:'icc.t20worldcup', label:'ICC T20' },
    { sport:'cricket', league:'ipl',             label:'IPL' },
  ]},
  { id:'racing', icon:'🏎', label:'Racing', leagues:[
    { sport:'motorsports', league:'f1', label:'Formula 1' },
  ]},
];

let sportsCurCat    = SPORTS_CATS[0];
let sportsCurLeague = SPORTS_CATS[0].leagues[0];
let sportsLoaded    = false;
let sportsRefreshTimer = null;
let _sportsEvents   = [];

// Event tracking
let sportsEventId    = null;
let sportsEventTimer = null;

// ── Init & navigation ──────────────────────────────────────────────────────────
function sportsInit() {
  if (!sportsLoaded) {
    sportsLoaded = true;
    _sportsBuildCats();
    _sportsBuildLeagues();
  }
  sportsLoad();
}

function _sportsBuildCats() {
  const el = document.getElementById('sports-cats'); if (!el) return;
  el.innerHTML = SPORTS_CATS.map(c =>
    `<button class="sports-cat${c.id===sportsCurCat.id?' on':''}" data-cat="${c.id}" onclick="sportsCatPick('${c.id}')">${c.icon} ${c.label}</button>`
  ).join('');
}

function _sportsBuildLeagues() {
  const el = document.getElementById('sports-leagues'); if (!el) return;
  const ls = sportsCurCat.leagues;
  if (ls.length <= 1) { el.style.display='none'; return; }
  el.style.display='';
  el.innerHTML = ls.map(l =>
    `<button class="sports-league${l.league===sportsCurLeague.league?' on':''}" data-league="${l.league}" onclick="sportsLeaguePick('${l.league}')">${l.flag||''} ${l.label}</button>`
  ).join('');
}

function sportsCatPick(id) {
  sportsCurCat    = SPORTS_CATS.find(c => c.id===id) || SPORTS_CATS[0];
  sportsCurLeague = sportsCurCat.leagues[0];
  document.querySelectorAll('.sports-cat').forEach(b => b.classList.toggle('on', b.dataset.cat===id));
  _sportsBuildLeagues();
  sportsLoad();
}

function sportsLeaguePick(leagueId) {
  sportsCurLeague = sportsCurCat.leagues.find(l => l.league===leagueId) || sportsCurCat.leagues[0];
  document.querySelectorAll('.sports-league').forEach(b => b.classList.toggle('on', b.dataset.league===leagueId));
  sportsLoad();
}

function sportsRefresh() { sportsLoad(); }

// ── Scoreboard ─────────────────────────────────────────────────────────────────
async function sportsLoad() {
  sportsCloseEvent(true);
  const el = document.getElementById('sports-scoreboard'); if (!el) return;
  el.style.display = '';
  el.innerHTML = '<div class="sports-loading">Loading…</div>';
  if (sportsRefreshTimer) { clearTimeout(sportsRefreshTimer); sportsRefreshTimer=null; }
  try {
    const { sport, league } = sportsCurLeague;
    const r = await fetch('/api/sports?sport='+encodeURIComponent(sport)+'&league='+encodeURIComponent(league)+'&device='+deviceId);
    const d = await r.json();
    _sportsEvents = d.events || [];
    const lu = document.getElementById('sports-last-update');
    if (lu) lu.textContent = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if (!_sportsEvents.length) {
      el.innerHTML = '<div class="sports-empty">No games scheduled right now.</div>';
      return;
    }
    const byDate = {};
    _sportsEvents.forEach(ev => {
      const key = new Date(ev.date).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
      (byDate[key] = byDate[key]||[]).push(ev);
    });
    let html = '';
    for (const [date, evs] of Object.entries(byDate)) {
      html += `<div class="sports-section-hdr">${_esc(date)}</div>`;
      html += evs.map(ev => _renderCard(ev)).join('');
    }
    el.innerHTML = html;
    if (_sportsEvents.some(e => e.status?.type?.state==='in'))
      sportsRefreshTimer = setTimeout(sportsLoad, 60000);
  } catch {
    el.innerHTML = '<div class="sports-empty">Could not load scores.</div>';
  }
}

function _cName(t) {
  return t.team?.displayName || t.team?.name ||
         t.athlete?.displayName || t.athlete?.fullName || '?';
}
function _cShort(t) {
  return t.team?.shortDisplayName || t.team?.abbreviation ||
         t.athlete?.shortName || t.athlete?.displayName?.split(' ').slice(-1)[0] || '?';
}
function _cLogo(t) {
  return t.team?.logo || t.athlete?.headshot?.href || t.athlete?.flag?.href || null;
}
function _cAbbr(t) {
  return (t.team?.abbreviation || t.athlete?.abbreviation ||
          _cName(t).split(' ').slice(-1)[0] || '?').slice(0,4);
}

function _renderCard(ev) {
  const comp   = ev.competitions?.[0] || {};
  const teams  = comp.competitors || [];
  const status = ev.status || {};
  const state  = status.type?.state || 'pre';
  const detail = status.type?.shortDetail || status.type?.description || '';
  const away   = teams.find(t => t.homeAway==='away') || teams[0] || {};
  const home   = teams.find(t => t.homeAway==='home') || teams[1] || {};
  const isPost = state==='post', isLive=state==='in';
  const homeW  = isPost && +home.score > +away.score;
  const awayW  = isPost && +away.score > +home.score;

  const row = (t, win) => {
    const logo  = _cLogo(t);
    const abbr  = _cAbbr(t);
    const name  = _cName(t);
    const score = state!=='pre' && t.score!=null ? String(t.score) : '';
    return `<div class="game-team">` +
      (logo ? `<img class="team-logo" src="${_esc(logo)}" alt="" loading="lazy" onerror="this.style.opacity='.2'">`
            : `<div class="team-logo-ph">${_esc(abbr)}</div>`) +
      `<span class="team-name${win?' w':''}">${_esc(name)}</span>` +
      (score ? `<span class="team-score${win?' w':''}">${_esc(score)}</span>` : '') +
      `</div>`;
  };

  const badge = isLive
    ? `<span class="game-badge-live"><span class="live-dot"></span>${_esc(detail)||'LIVE'}</span>`
    : isPost ? `<span class="game-badge-final">FT</span>`
    : `<span class="game-badge-pre">${_esc(new Date(ev.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</span>`;

  const venue = comp.venue?.shortName || comp.venue?.fullName || '';

  return `<div class="game-card${isLive?' live':''}" onclick="sportsOpenEvent('${_esc(ev.id)}')">` +
    `<div class="game-teams">${row(away,awayW)}${row(home,homeW)}</div>` +
    `<div class="game-foot">${badge}` +
    (venue ? `<span class="game-venue">${_esc(venue)}</span>` : '') +
    `<span class="game-tap-hint">Details →</span></div></div>`;
}

// ── Event detail panel ─────────────────────────────────────────────────────────
function sportsOpenEvent(id) {
  const ev = _sportsEvents.find(e => e.id===id); if (!ev) return;
  sportsEventId = id;
  document.getElementById('sports-scoreboard').style.display = 'none';
  document.getElementById('sports-event-panel').style.display = '';
  // Render score immediately from what we have
  const comp = ev.competitions?.[0] || {};
  document.getElementById('sep-header').innerHTML = _renderSepHeader(comp, ev.status);
  document.getElementById('sep-timeline').innerHTML = '<div class="sep-empty">Loading events…</div>';
  _loadEventDetail();
}

function sportsCloseEvent(silent) {
  if (sportsEventTimer) { clearTimeout(sportsEventTimer); sportsEventTimer=null; }
  sportsEventId = null;
  const panel = document.getElementById('sports-event-panel');
  const board = document.getElementById('sports-scoreboard');
  if (panel) panel.style.display='none';
  if (board) board.style.display='';
}

async function _loadEventDetail() {
  if (!sportsEventId) return;
  try {
    const { sport, league } = sportsCurLeague;
    const r = await fetch(`/api/sports/event?sport=${encodeURIComponent(sport)}&league=${encodeURIComponent(league)}&event=${encodeURIComponent(sportsEventId)}&device=${deviceId}`);
    const d = await r.json();
    const comp = d.header?.competitions?.[0];
    if (comp) document.getElementById('sep-header').innerHTML = _renderSepHeader(comp, comp.status);
    const tl = document.getElementById('sep-timeline');
    if (tl) tl.innerHTML = _renderTimeline(d, sportsCurLeague.sport);
    const state = comp?.status?.type?.state;
    if (state==='in') sportsEventTimer = setTimeout(_loadEventDetail, 25000);
  } catch {
    const tl = document.getElementById('sep-timeline');
    if (tl) tl.innerHTML = '<div class="sep-empty">Event details unavailable.</div>';
  }
}

function _renderSepHeader(comp, status) {
  const teams = comp.competitors || [];
  const away  = teams.find(t => t.homeAway==='away') || teams[0] || {};
  const home  = teams.find(t => t.homeAway==='home') || teams[1] || {};
  const st    = status?.type || {};
  const isLive = st.state==='in', isPost = st.state==='post';
  const detail = st.shortDetail || st.detail || '';
  const awayW  = isPost && +away.score > +home.score;
  const homeW  = isPost && +home.score > +away.score;

  const logoEl = t => { const l=_cLogo(t);
    return l ? `<img class="sep-logo" src="${_esc(l)}" alt="" onerror="this.style.opacity='.2'">`
             : `<div class="sep-logo-ph">${_esc(_cAbbr(t))}</div>`; };

  const scoreEl = (t, win) => t.score!=null
    ? `<div class="sep-score-val${win?' sep-win':''}">${_esc(String(t.score))}</div>`
    : `<div class="sep-score-val sep-score-na">—</div>`;

  return `<div class="sep-scorebox">
    <div class="sep-teams-row">
      <div class="sep-team-col${awayW?' sep-winner':''}">
        ${logoEl(away)}
        <div class="sep-tname">${_esc(_cShort(away))}</div>
      </div>
      <div class="sep-center-col">
        <div class="sep-scores-ctr">
          ${scoreEl(away,awayW)}
          <div class="sep-scores-dash">–</div>
          ${scoreEl(home,homeW)}
        </div>
        <div class="sep-status-line${isLive?' sep-status-live':''}">
          ${isLive?'<span class="live-dot"></span>':''}
          ${_esc(isPost?'Full Time':isLive?detail||'LIVE':detail)}
        </div>
      </div>
      <div class="sep-team-col${homeW?' sep-winner':''}">
        ${logoEl(home)}
        <div class="sep-tname">${_esc(_cShort(home))}</div>
      </div>
    </div>
  </div>`;
}

function _renderTimeline(data, sport) {
  // Try scoringPlays first, then keyEvents
  let plays = data.scoringPlays || [];
  if (!plays.length && data.keyEvents?.length) plays = data.keyEvents;

  if (!plays.length) {
    const state = data.header?.competitions?.[0]?.status?.type?.state;
    if (state==='pre')  return '<div class="sep-empty">Match not started yet.</div>';
    if (state==='post') return '<div class="sep-empty">No scoring data available.</div>';
    return '<div class="sep-empty">No events yet — check back during the match.</div>';
  }

  const sorted = [...plays].reverse(); // most recent first
  return `<div class="sep-tl-hdr">Match Events</div>` +
    sorted.map(p => {
      const clock  = p.clock?.displayValue || '';
      const period = p.period?.displayValue || '';
      const text   = p.text || p.description || '';
      const icon   = _eventIcon(text, sport, p.type?.text||'');
      const aScore = p.awayScore ?? '';
      const hScore = p.homeScore ?? '';
      const scoreStr = aScore!=='' && hScore!=='' ? `${aScore} – ${hScore}` : '';
      return `<div class="sep-event">
        <div class="sep-ev-time">${_esc(clock)}${period?`<br><span style="font-weight:400;opacity:.6">${_esc(period)}</span>`:''}</div>
        <div class="sep-ev-icon">${icon}</div>
        <div class="sep-ev-body">
          <div class="sep-ev-text">${_esc(text)}</div>
          ${scoreStr?`<div class="sep-ev-score">${scoreStr}</div>`:''}
        </div>
      </div>`;
    }).join('');
}

function _eventIcon(text, sport, typeText) {
  const t = (text+' '+typeText).toLowerCase();
  if (sport==='soccer') {
    if (t.includes('yellow')) return '🟡';
    if (t.includes('red card')) return '🟥';
    if (t.includes('own goal')) return '🥅';
    if (t.includes('penalty') && t.includes('goal')) return '⚽';
    if (t.includes('goal')) return '⚽';
    if (t.includes('substitut') || t.includes('replaces')) return '↔';
    if (t.includes('penalty')) return '🎯';
  } else if (sport==='basketball') {
    if (t.includes('three') || t.includes('3-point') || t.includes('3pt')) return '🎯';
    return '🏀';
  } else if (sport==='american-football') {
    if (t.includes('touchdown')) return '🏈';
    if (t.includes('field goal')) return '🦵';
    if (t.includes('safety')) return '🛡';
    if (t.includes('extra point') || t.includes(' pat')) return '●';
  } else if (sport==='baseball') {
    if (t.includes('home run')) return '💥';
    return '⚾';
  } else if (sport==='hockey') {
    if (t.includes('power play') || t.includes(' pp')) return '⚡';
    if (t.includes('empty') || t.includes(' en ')) return '🕳';
    if (t.includes('shorthanded') || t.includes(' sh ')) return '🔻';
    return '🏒';
  } else if (sport==='rugby-union' || sport==='rugby-league') {
    if (t.includes('try')) return '🏉';
    if (t.includes('conversion')) return '↑';
    if (t.includes('penalty')) return '🎯';
    if (t.includes('drop')) return '🎯';
    return '🏉';
  } else if (sport==='mma') { return '🥊'; }
    else if (sport==='golf') { return '⛳'; }
    else if (sport==='motorsports') { return '🏎'; }
  return '●';
}

function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
