// ── Sports tab ─────────────────────────────────────────────────────────────────
const SPORTS_CATS = [
  { id:'soccer',   icon:'⚽', label:'Soccer', leagues:[
    { sport:'soccer', league:'eng.1',          label:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { sport:'soccer', league:'esp.1',          label:'La Liga',        flag:'🇪🇸' },
    { sport:'soccer', league:'ger.1',          label:'Bundesliga',     flag:'🇩🇪' },
    { sport:'soccer', league:'ita.1',          label:'Serie A',        flag:'🇮🇹' },
    { sport:'soccer', league:'fra.1',          label:'Ligue 1',        flag:'🇫🇷' },
    { sport:'soccer', league:'rsa.1',          label:'PSL',            flag:'🇿🇦' },
    { sport:'soccer', league:'uefa.champions', label:'Champions Lg',   flag:'🏆' },
  ]},
  { id:'basketball', icon:'🏀', label:'Basketball', leagues:[
    { sport:'basketball', league:'nba', label:'NBA' },
  ]},
  { id:'football', icon:'🏈', label:'Football', leagues:[
    { sport:'american-football', league:'nfl', label:'NFL' },
  ]},
  { id:'baseball', icon:'⚾', label:'Baseball', leagues:[
    { sport:'baseball', league:'mlb', label:'MLB' },
  ]},
  { id:'hockey', icon:'🏒', label:'Hockey', leagues:[
    { sport:'hockey', league:'nhl', label:'NHL' },
  ]},
  { id:'tennis', icon:'🎾', label:'Tennis', leagues:[
    { sport:'tennis', league:'atp', label:'ATP Tour' },
  ]},
  { id:'rugby', icon:'🏉', label:'Rugby', leagues:[
    { sport:'rugby-union', league:'urc',           label:'URC' },
    { sport:'rugby-union', league:'international', label:'International' },
  ]},
  { id:'combat', icon:'🥊', label:'Combat', leagues:[
    { sport:'mma', league:'ufc', label:'UFC' },
  ]},
  { id:'golf', icon:'⛳', label:'Golf', leagues:[
    { sport:'golf', league:'pga', label:'PGA Tour' },
  ]},
  { id:'cricket', icon:'🏏', label:'Cricket', leagues:[
    { sport:'cricket', league:'icc.t20worldcup', label:'ICC T20' },
  ]},
];

let sportsCurCat    = SPORTS_CATS[0];
let sportsCurLeague = SPORTS_CATS[0].leagues[0];
let sportsLoaded    = false;
let sportsRefreshTimer = null;

function sportsInit() {
  if (sportsLoaded) return;
  sportsLoaded = true;
  _sportsBuildCats();
  _sportsBuildLeagues();
  sportsLoad();
}

function _sportsBuildCats() {
  const el = document.getElementById('sports-cats'); if (!el) return;
  el.innerHTML = SPORTS_CATS.map(c =>
    `<button class="sports-cat${c.id===sportsCurCat.id?' on':''}" onclick="sportsCatPick('${c.id}')">${c.icon} ${c.label}</button>`
  ).join('');
}

function _sportsBuildLeagues() {
  const el = document.getElementById('sports-leagues'); if (!el) return;
  const ls = sportsCurCat.leagues;
  if (ls.length <= 1) { el.style.display='none'; return; }
  el.style.display='';
  el.innerHTML = ls.map(l =>
    `<button class="sports-league${l.league===sportsCurLeague.league?' on':''}" onclick="sportsLeaguePick('${l.league}')">${l.flag||''} ${l.label}</button>`
  ).join('');
}

function sportsCatPick(id) {
  sportsCurCat = SPORTS_CATS.find(c => c.id===id) || SPORTS_CATS[0];
  sportsCurLeague = sportsCurCat.leagues[0];
  document.querySelectorAll('.sports-cat').forEach(b => b.classList.toggle('on', b.textContent.trim().startsWith(sportsCurCat.icon)));
  _sportsBuildLeagues();
  sportsLoad();
}

function sportsLeaguePick(leagueId) {
  sportsCurLeague = sportsCurCat.leagues.find(l => l.league===leagueId) || sportsCurCat.leagues[0];
  document.querySelectorAll('.sports-league').forEach(b => b.classList.toggle('on', b.onclick?.toString().includes(`'${leagueId}'`)));
  _sportsBuildLeagues(); // re-render to reflect new selection
  sportsLoad();
}

function sportsRefresh() { sportsLoad(true); }

async function sportsLoad() {
  const el = document.getElementById('sports-scoreboard'); if (!el) return;
  el.innerHTML = '<div class="sports-loading">Loading…</div>';
  if (sportsRefreshTimer) { clearTimeout(sportsRefreshTimer); sportsRefreshTimer=null; }
  try {
    const { sport, league } = sportsCurLeague;
    const r = await fetch('/api/sports?sport='+encodeURIComponent(sport)+'&league='+encodeURIComponent(league)+'&device='+deviceId);
    const d = await r.json();
    const events = d.events || [];
    const lu = document.getElementById('sports-last-update');
    if (lu) lu.textContent = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if (!events.length) {
      el.innerHTML = '<div class="sports-empty">No games scheduled right now.</div>';
      return;
    }
    // Group by date
    const byDate = {};
    events.forEach(ev => {
      const key = new Date(ev.date).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
      (byDate[key] = byDate[key]||[]).push(ev);
    });
    let html = '';
    for (const [date, evs] of Object.entries(byDate)) {
      html += '<div class="sports-section-hdr">'+_escS(date)+'</div>';
      html += evs.map(ev => _renderCard(ev)).join('');
    }
    el.innerHTML = html;
    const hasLive = events.some(e => e.status?.type?.state==='in');
    if (hasLive) sportsRefreshTimer = setTimeout(sportsLoad, 60000);
  } catch (e) {
    el.innerHTML = '<div class="sports-empty">Could not load scores.</div>';
  }
}

function _renderCard(ev) {
  const comp   = ev.competitions?.[0] || {};
  const teams  = comp.competitors || [];
  const status = ev.status || {};
  const state  = status.type?.state || 'pre';
  const detail = status.type?.shortDetail || status.type?.description || '';
  const home   = teams.find(t => t.homeAway==='home') || teams[0] || {};
  const away   = teams.find(t => t.homeAway==='away') || teams[1] || {};
  const isPost = state === 'post';
  const isLive = state === 'in';
  const homeW  = isPost && +home.score > +away.score;
  const awayW  = isPost && +away.score > +home.score;

  const teamRow = (t, win) => {
    const logo  = t.team?.logo;
    const abbr  = (t.team?.abbreviation||t.team?.displayName||'?').slice(0,3);
    const name  = t.team?.displayName || abbr;
    const score = state!=='pre' && t.score!=null ? String(t.score) : '';
    return '<div class="game-team">' +
      (logo ? `<img class="team-logo" src="${_escS(logo)}" alt="" loading="lazy" onerror="this.style.opacity='.2'">`
             : `<div class="team-logo-ph">${_escS(abbr)}</div>`) +
      `<span class="team-name${win?' w':''}">${_escS(name)}</span>` +
      (score ? `<span class="team-score${win?' w':''}">${_escS(score)}</span>` : '') +
      '</div>';
  };

  const timeBadge = isLive
    ? `<span class="game-badge-live"><span class="live-dot"></span>${_escS(detail)||'LIVE'}</span>`
    : isPost
    ? `<span class="game-badge-final">Final</span>`
    : `<span class="game-badge-pre">${_escS(new Date(ev.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</span>`;

  const venue = comp.venue?.shortName || comp.venue?.fullName || '';

  return `<div class="game-card${isLive?' live':''}">` +
    `<div class="game-teams">${teamRow(away,awayW)}${teamRow(home,homeW)}</div>` +
    `<div class="game-foot">${timeBadge}${venue?`<span class="game-venue">${_escS(venue)}</span>`:''}</div>` +
    '</div>';
}

function _escS(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
