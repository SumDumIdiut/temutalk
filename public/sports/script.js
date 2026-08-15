// ── Sports tab ─────────────────────────────────────────────────────────────────

// Drawn (not emoji) sport-category icons -- filled silhouette shapes with
// low-opacity same-color seam/detail lines on top, matching the app's
// single-color filled-path icon convention (nav icons, player controls,
// etc.) instead of introducing a second outline/stroke style.
const SPORT_ICON_SVG = {
  soccer:     '<circle cx="12" cy="12" r="8.5" fill="currentColor"/><g stroke="currentColor" stroke-width=".9" fill="none" opacity=".55"><path d="M12 6.5l3 2.2-1.1 3.4H10.1L9 8.7z"/><path d="M12 6.5V4M15 8.7l2.3-1.4M9 8.7L6.7 7.3M10.9 12.1l-1.6 2.6M13.1 12.1l1.6 2.6"/></g>',
  basketball: '<circle cx="12" cy="12" r="8.5" fill="currentColor"/><g stroke="currentColor" stroke-width=".9" fill="none" opacity=".55"><line x1="3.5" y1="12" x2="20.5" y2="12"/><line x1="12" y1="3.5" x2="12" y2="20.5"/><path d="M6 5.2c2.6 2.8 2.6 11 0 13.6"/><path d="M18 5.2c-2.6 2.8-2.6 11 0 13.6"/></g>',
  football:   '<ellipse cx="12" cy="12" rx="9" ry="5.4" fill="currentColor" transform="rotate(-32 12 12)"/><g stroke="currentColor" stroke-width=".9" opacity=".55" transform="rotate(-32 12 12)"><line x1="7.5" y1="12" x2="16.5" y2="12"/><line x1="9.3" y1="10.6" x2="9.3" y2="13.4"/><line x1="11" y1="10.6" x2="11" y2="13.4"/><line x1="12.7" y1="10.6" x2="12.7" y2="13.4"/><line x1="14.4" y1="10.6" x2="14.4" y2="13.4"/></g>',
  baseball:   '<circle cx="12" cy="12" r="8.5" fill="currentColor"/><g stroke="currentColor" stroke-width=".9" fill="none" opacity=".55"><path d="M6 4.5c2.5 3 2.5 12.5 0 15.5"/><path d="M18 4.5c-2.5 3-2.5 12.5 0 15.5"/></g>',
  hockey:     '<rect x="4" y="10.5" width="16" height="6" rx="3" fill="currentColor"/><line x1="16.5" y1="3" x2="9.5" y2="19.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>',
  tennis:     '<circle cx="12" cy="12" r="8.5" fill="currentColor"/><path d="M4.2 8.2C7.5 9.6 7.5 14.4 4.2 15.8M19.8 8.2c-3.3 1.4-3.3 6.2 0 7.6" stroke="currentColor" stroke-width=".9" fill="none" opacity=".55"/>',
  rugby:      '<ellipse cx="12" cy="12" rx="6.2" ry="9.5" fill="currentColor" transform="rotate(28 12 12)"/><g stroke="currentColor" stroke-width=".9" opacity=".55" transform="rotate(28 12 12)"><line x1="12" y1="4" x2="12" y2="20"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="10" y1="16" x2="14" y2="16"/></g>',
  combat:     '<path d="M8 21v-6.5H6a2.5 2.5 0 01-2.5-2.5v-3A2.5 2.5 0 016 6.5h1V6a2 2 0 012-2h.5a2 2 0 012 2v.3a2 2 0 013.6 1.2v.3a2 2 0 013 1.7V11a5.5 5.5 0 01-2 4.2V21z" fill="currentColor"/>',
  golf:       '<line x1="7" y1="21" x2="7" y2="4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 4l8 3.2L7 10.4z" fill="currentColor"/><ellipse cx="12" cy="21.5" rx="8" ry="1.4" fill="currentColor" opacity=".3"/>',
  cricket:    '<path d="M6 20.5L18 8.3a2 2 0 000-2.8 2 2 0 00-2.8 0L3 17.7z" fill="currentColor"/><circle cx="19.5" cy="4.5" r="2.3" fill="currentColor"/>',
  racing:     '<line x1="6" y1="21" x2="6" y2="3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><g fill="currentColor"><rect x="6" y="3" width="3.5" height="3.5"/><rect x="13" y="3" width="3.5" height="3.5"/><rect x="9.5" y="6.5" width="3.5" height="3.5"/><rect x="16.5" y="6.5" width="3.5" height="3.5"/><rect x="6" y="10" width="3.5" height="3.5"/><rect x="13" y="10" width="3.5" height="3.5"/></g>',
};
function sportIconSvg(key, size) {
  size = size || 16;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" style="vertical-align:-3px">' + (SPORT_ICON_SVG[key] || SPORT_ICON_SVG.soccer) + '</svg>';
}

const SPORTS_CATS = [
  { id:'soccer', icon:'soccer', label:'Soccer', leagues:[
    { sport:'soccer', league:'fifa.world',     label:'World Cup' },
    { sport:'soccer', league:'eng.1',          label:'Premier League' },
    { sport:'soccer', league:'esp.1',          label:'La Liga' },
    { sport:'soccer', league:'ger.1',          label:'Bundesliga' },
    { sport:'soccer', league:'ita.1',          label:'Serie A' },
    { sport:'soccer', league:'fra.1',          label:'Ligue 1' },
    { sport:'soccer', league:'usa.1',          label:'MLS' },
    { sport:'soccer', league:'rsa.1',          label:'PSL' },
    { sport:'soccer', league:'uefa.champions', label:'UCL' },
    { sport:'soccer', league:'eng.fa_cup',     label:'FA Cup' },
  ]},
  { id:'basketball', icon:'basketball', label:'Basketball', leagues:[
    { sport:'basketball', league:'nba',                     label:'NBA' },
    { sport:'basketball', league:'mens-college-basketball', label:'NCAA' },
    { sport:'basketball', league:'wnba',                    label:'WNBA' },
  ]},
  { id:'football', icon:'football', label:'Football', leagues:[
    { sport:'american-football', league:'nfl',             label:'NFL' },
    { sport:'american-football', league:'college-football', label:'College' },
  ]},
  { id:'baseball', icon:'baseball', label:'Baseball', leagues:[
    { sport:'baseball', league:'mlb', label:'MLB' },
  ]},
  { id:'hockey', icon:'hockey', label:'Hockey', leagues:[
    { sport:'hockey', league:'nhl', label:'NHL' },
  ]},
  { id:'tennis', icon:'tennis', label:'Tennis', leagues:[
    { sport:'tennis', league:'atp', label:'ATP' },
    { sport:'tennis', league:'wta', label:'WTA' },
  ]},
  { id:'rugby', icon:'rugby', label:'Rugby', leagues:[
    { sport:'rugby-union', league:'urc',           label:'URC' },
    { sport:'rugby-union', league:'international', label:'International' },
  ]},
  { id:'combat', icon:'combat', label:'Combat', leagues:[
    { sport:'mma', league:'ufc', label:'UFC' },
  ]},
  { id:'golf', icon:'golf', label:'Golf', leagues:[
    { sport:'golf', league:'pga',  label:'PGA' },
    { sport:'golf', league:'lpga', label:'LPGA' },
  ]},
  { id:'cricket', icon:'cricket', label:'Cricket', leagues:[
    { sport:'cricket', league:'icc.t20worldcup', label:'ICC T20' },
    { sport:'cricket', league:'ipl',             label:'IPL' },
  ]},
  { id:'racing', icon:'racing', label:'Racing', leagues:[
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
    `<button class="sports-cat${c.id===sportsCurCat.id?' on':''}" data-cat="${c.id}" onclick="sportsCatPick('${c.id}')">${sportIconSvg(c.icon)} ${c.label}</button>`
  ).join('');
}

function _sportsBuildLeagues() {
  const el = document.getElementById('sports-leagues'); if (!el) return;
  const ls = sportsCurCat.leagues;
  if (ls.length <= 1) { el.style.display='none'; return; }
  el.style.display='';
  el.innerHTML = ls.map(l =>
    `<button class="sports-league${l.league===sportsCurLeague.league?' on':''}" data-league="${l.league}" onclick="sportsLeaguePick('${l.league}')">${l.label}</button>`
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
    const r = await fetch(BASE_PATH + '/api/sports?sport='+encodeURIComponent(sport)+'&league='+encodeURIComponent(league)+'&device='+deviceId);
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
    const r = await fetch(`${BASE_PATH}/api/sports/event?sport=${encodeURIComponent(sport)}&league=${encodeURIComponent(league)}&event=${encodeURIComponent(sportsEventId)}&device=${deviceId}`);
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

// Small event-specific icons that don't map onto a sport-category ball --
// same drawn/filled convention as SPORT_ICON_SVG above.
const EVENT_ICON_SVG = {
  cardYellow: '<rect x="7" y="3" width="10" height="18" rx="1.5" fill="#eab308"/>',
  cardRed:    '<rect x="7" y="3" width="10" height="18" rx="1.5" fill="#ef4444"/>',
  net:        '<g stroke="currentColor" stroke-width="1.3" fill="none"><path d="M4 4h16v13a3 3 0 01-3 3H7a3 3 0 01-3-3z"/><line x1="8" y1="4" x2="8" y2="19"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="16" y1="4" x2="16" y2="19"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="14" x2="20" y2="14"/></g>',
  target:     '<g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/></g><circle cx="12" cy="12" r="1.8" fill="currentColor"/>',
  posts:      '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="3" x2="6" y2="14"/><line x1="18" y1="3" x2="18" y2="14"/><line x1="6" y1="6.5" x2="18" y2="6.5"/><line x1="12" y1="6.5" x2="12" y2="21"/></g>',
  shield:     '<path d="M12 2l8 3v6c0 5-3.4 8.7-8 11-4.6-2.3-8-6-8-11V5z" fill="currentColor"/>',
  burst:      '<path d="M12 2l2.2 5.6L20 6l-3 5.4L20 18l-5.8-1.6L12 22l-2.2-5.6L4 18l3-6.6L4 6l5.8 1.6z" fill="currentColor"/>',
  bolt:       '<path d="' + WX_BOLT_PATH + '" fill="#eab308"/>',
  ring:       '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  triDown:    '<path d="M4 6h16l-8 13z" fill="currentColor"/>',
  arrowUp:    '<path d="M12 20V6M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  swap:       '<path d="M7 7h11M15 3l3 4-3 4M17 17H6M9 21l-3-4 3-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  dot:        '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
};
function eventIconSvg(key, size) {
  size = size || 16;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" style="vertical-align:-3px">' + (EVENT_ICON_SVG[key] || EVENT_ICON_SVG.dot) + '</svg>';
}
// WX_BOLT_PATH comes from index.html's shared weather-icon module (same
// lightning-bolt path, reused here rather than redrawn).

function _eventIcon(text, sport, typeText) {
  const t = (text+' '+typeText).toLowerCase();
  let key;
  if (sport==='soccer') {
    if (t.includes('yellow')) key = 'cardYellow';
    else if (t.includes('red card')) key = 'cardRed';
    else if (t.includes('own goal')) key = 'net';
    else if (t.includes('goal')) key = 'soccer';
    else if (t.includes('substitut') || t.includes('replaces')) key = 'swap';
    else if (t.includes('penalty')) key = 'target';
    else key = 'soccer';
  } else if (sport==='basketball') {
    key = (t.includes('three') || t.includes('3-point') || t.includes('3pt')) ? 'target' : 'basketball';
  } else if (sport==='american-football') {
    if (t.includes('touchdown')) key = 'football';
    else if (t.includes('field goal')) key = 'posts';
    else if (t.includes('safety')) key = 'shield';
    else key = 'dot';
  } else if (sport==='baseball') {
    key = t.includes('home run') ? 'burst' : 'baseball';
  } else if (sport==='hockey') {
    if (t.includes('power play') || t.includes(' pp')) key = 'bolt';
    else if (t.includes('empty') || t.includes(' en ')) key = 'ring';
    else if (t.includes('shorthanded') || t.includes(' sh ')) key = 'triDown';
    else key = 'hockey';
  } else if (sport==='rugby-union' || sport==='rugby-league') {
    if (t.includes('try')) key = 'rugby';
    else if (t.includes('conversion')) key = 'arrowUp';
    else if (t.includes('penalty') || t.includes('drop')) key = 'target';
    else key = 'rugby';
  } else if (sport==='mma') { key = 'combat'; }
    else if (sport==='golf') { key = 'golf'; }
    else if (sport==='motorsports') { key = 'racing'; }
    else { key = 'dot'; }
  return (SPORT_ICON_SVG[key] ? sportIconSvg(key) : eventIconSvg(key));
}

function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
