
// ── Hub guard ─────────────────────────────────────────────────────────────
const hubId = localStorage.getItem('hub');
if (!hubId) location.replace('/hub-select.html?ret=/');
document.getElementById('auth-link').href = '/auth/spotify/' + hubId;

// ── Navigation ────────────────────────────────────────────────────────────
const TAB_IDX = { home: 0, music: 1, timer: 2, finance: 3, system: 4, news: 5, radio: 6, weather: 7 };
let curTab = 'home';

function navigate(tab) {
  if (tab === curTab) return;
  const dir = TAB_IDX[tab] > TAB_IDX[curTab] ? 1 : -1;
  const $old = document.getElementById('view-' + curTab);
  const $new = document.getElementById('view-' + tab);

  // Set new view off-screen without transition
  $new.style.transition = 'none';
  $new.style.opacity = '0';
  $new.style.transform = 'translateX(' + (dir * 28) + 'px)';
  $new.classList.add('v-on');

  // Force reflow, then animate both
  $new.offsetHeight;
  $new.style.transition = '';
  $new.style.opacity = '1';
  $new.style.transform = '';
  $old.style.opacity = '0';
  $old.style.transform = 'translateX(' + (-dir * 28) + 'px)';

  const leaving = curTab;
  curTab = tab;

  setTimeout(() => {
    const $leaving = document.getElementById('view-' + leaving);
    $leaving.classList.remove('v-on');
    $leaving.style.opacity = '';
    $leaving.style.transform = '';
  }, 280);

  // Nav active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });

  // Lazy-load tabs on first visit
  if (tab === 'weather' && !wxLoaded) {
    wxLoaded = true;
    if (wxCity) loadWx(wxCity);
    else fetch('/api/hub/' + hubId).then(r => r.json()).then(h => { if (h.weatherCity) loadWx(h.weatherCity); else showWxError('No city configured'); }).catch(() => showWxError('Could not load hub config'));
  }
  if (tab === 'timer')   initTimerView();
  if (tab === 'finance' && !financeLoaded) { financeLoaded = true; loadCrypto(); }
  if (tab === 'system')  loadSystem();
  if (tab === 'news'  && !newsLoaded)  { newsLoaded = true; loadNews('worldnews'); }
  if (tab === 'radio') initRadioMap();

  // Update URL
  const u = new URL(location.href);
  tab === 'home' ? u.searchParams.delete('tab') : u.searchParams.set('tab', tab);
  history.replaceState(null, '', u);
}

// Handle deep-link on load
const _initTab = new URLSearchParams(location.search).get('tab');
if (['music','timer','finance','system','news','radio','weather'].includes(_initTab)) navigate(_initTab);


// ── Clock ─────────────────────────────────────────────────────────────────
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function tick() {
  const n = new Date();
  const h = n.getHours();
  const greetEl = document.getElementById('home-greeting');
  if (greetEl) greetEl.textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('clock').textContent =
    h.toString().padStart(2,'0') + ':' + n.getMinutes().toString().padStart(2,'0');
  document.getElementById('dateline').textContent =
    DAYS[n.getDay()] + ', ' + MONTHS[n.getMonth()] + ' ' + n.getDate();
}
tick(); setInterval(tick, 15000);

// ── Weather code map ──────────────────────────────────────────────────────
const WX_MAP = {113:'☀️',116:'⛅',119:'☁️',122:'☁️',143:'🌫️',176:'🌦️',185:'🌨️',200:'⛈️',227:'🌨️',230:'❄️',248:'🌫️',260:'🌫️',263:'🌦️',266:'🌦️',281:'🌧️',284:'🌧️',293:'🌦️',296:'🌦️',299:'🌧️',302:'🌧️',305:'🌧️',308:'🌧️',311:'🌨️',314:'🌨️',317:'🌨️',320:'🌨️',323:'❄️',326:'❄️',329:'❄️',332:'❄️',335:'❄️',338:'❄️',350:'🌨️',353:'🌦️',356:'🌧️',359:'🌧️',362:'🌨️',365:'🌨️',368:'❄️',371:'❄️',374:'🌨️',377:'🌨️',386:'⛈️',389:'⛈️',392:'⛈️',395:'⛈️'};
function wxEmoji(code) { return WX_MAP[+code] || '🌤️'; }

// ── Home weather widget ───────────────────────────────────────────────────
let wxCity = '';
fetch('/api/hub/' + hubId)
  .then(r => r.json())
  .then(hub => {
    wxCity = hub.weatherCity || '';
    if (!wxCity) { document.getElementById('w-desc').textContent = 'No city configured'; return; }
    fetch('/api/weather?city=' + encodeURIComponent(wxCity))
      .then(r => r.json()).then(d => {
        if (!d.current_condition) return;
        const c = d.current_condition[0];
        document.getElementById('w-temp').textContent = c.temp_C + '°';
        document.getElementById('w-desc').textContent = c.weatherDesc[0].value;
        document.getElementById('w-city').textContent = d.nearest_area?.[0]?.areaName?.[0]?.value || wxCity;
        document.getElementById('w-icon').textContent = wxEmoji(c.weatherCode);
        const wxCard = document.getElementById('home-wx-card');
        if (wxCard) {
          const code = +c.weatherCode;
          wxCard.classList.remove('wx-sunny','wx-cloudy','wx-rain','wx-storm','wx-snow');
          if ([113,116].includes(code)) wxCard.classList.add('wx-sunny');
          else if ([119,122,143,248,260].includes(code)) wxCard.classList.add('wx-cloudy');
          else if ([200,386,389,392,395].includes(code)) wxCard.classList.add('wx-storm');
          else if ([227,230,323,326,329,332,335,338,368,371,395].includes(code)) wxCard.classList.add('wx-snow');
          else wxCard.classList.add('wx-rain');
        }
      }).catch(() => { document.getElementById('w-desc').textContent = 'Unavailable'; });
  })
  .catch(() => { document.getElementById('w-desc').textContent = 'Unavailable'; });

// ── Home snippets ─────────────────────────────────────────────────────────
function loadHomeSnippets() {
  // Markets — 6 coins
  fetch('/api/crypto?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano&hub=' + hubId)
    .then(r => r.json()).then(data => {
      const el = document.getElementById('home-coins');
      if (!el || !Array.isArray(data)) return;
      const coins = data.slice(0, 6);
      el.innerHTML = coins.map(c => {
        const chg = c.price_change_percentage_24h || 0;
        const up  = chg >= 0;
        const p   = c.current_price >= 1000
          ? '$' + c.current_price.toLocaleString(undefined, {maximumFractionDigits: 0})
          : '$' + c.current_price.toLocaleString(undefined, {maximumFractionDigits: 4});
        return '<div class="home-coin-row">' +
          '<span class="home-coin-sym">' + esc(c.symbol.toUpperCase()) + '</span>' +
          '<span class="home-coin-price">' + p + '</span>' +
          '<span class="home-coin-chg ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') + chg.toFixed(2) + '%</span>' +
          '</div>';
      }).join('');
      const mktCard = document.getElementById('home-markets-card');
      if (mktCard && coins.length) {
        const avgChg = coins.reduce((s, c) => s + (c.price_change_percentage_24h || 0), 0) / coins.length;
        mktCard.classList.remove('mkt-up','mkt-down');
        mktCard.classList.add(avgChg >= 0 ? 'mkt-up' : 'mkt-down');
      }
    }).catch(() => { const el = document.getElementById('home-coins'); if (el) el.innerHTML = '<div class="home-snip-dim">Unavailable</div>'; });

  // News — 5 headlines
  fetch('/api/news?sub=worldnews&hub=' + hubId)
    .then(r => r.json()).then(data => {
      const el = document.getElementById('home-headlines');
      if (!el || !Array.isArray(data)) return;
      el.innerHTML = data.slice(0, 5).map((p, i) =>
        '<div class="home-headline">' +
        '<span class="home-headline-n">' + (i + 1) + '</span>' +
        '<span class="home-headline-t">' + esc(p.title) + '</span>' +
        '</div>'
      ).join('');
    }).catch(() => { const el = document.getElementById('home-headlines'); if (el) el.innerHTML = '<div class="home-snip-dim">Unavailable</div>'; });

  // Recently played music
  fetch('/api/recently-played?hub=' + hubId)
    .then(r => r.json()).then(data => {
      const el = document.getElementById('home-recent-tracks');
      if (!el) return;
      const items = (data.items || [])
        .filter((v, i, a) => a.findIndex(x => x.track?.id === v.track?.id) === i)
        .slice(0, 4);
      if (!items.length) { el.innerHTML = '<div class="home-snip-dim">Nothing played recently</div>'; return; }
      el.innerHTML = items.map(item => {
        const t = item.track || {};
        const name   = t.name || '—';
        const artist = (t.artists || []).map(a => a.name).join(', ') || '—';
        const img    = (t.album?.images?.[2] || t.album?.images?.[1] || t.album?.images?.[0])?.url || '';
        return '<div class="home-recent-row">' +
          '<img class="home-recent-art" src="' + esc(img) + '" alt="">' +
          '<div><div class="home-recent-name">' + esc(name) + '</div>' +
          '<div class="home-recent-sub">' + esc(artist) + '</div></div>' +
          '</div>';
      }).join('');
    }).catch(() => {});
}
loadHomeSnippets();

// ── Music card art tinting ────────────────────────────────────────────────
function tintMusicCard(src) {
  const card = document.getElementById('np-card');
  if (!card) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 8;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; count++; }
      r = Math.round(r / count * 0.35);
      g = Math.round(g / count * 0.35);
      b = Math.round(b / count * 0.35);
      card.style.background = 'linear-gradient(140deg,rgb(' + r + ',' + g + ',' + b + ') 0%,var(--surface) 60%)';
    } catch(_) {}
  };
  img.src = src;
}

// Update active timers on home snippet
function updateHomeTimers() {
  const el = document.getElementById('home-active-timers');
  if (!el || typeof timers === 'undefined') return;
  const running = timers.filter(t => t.running && !t.done);
  if (!running.length) { el.innerHTML = '<div class="home-snip-dim">No active timers</div>'; return; }
  el.innerHTML = running.map(t => {
    const m = Math.floor(t.remaining / 60), s = t.remaining % 60;
    return '<div class="home-active-timer">' +
      '<span class="home-active-timer-name">' + esc(t.label || 'Timer') + '</span>' +
      '<span class="home-active-timer-val">' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + '</span>' +
      '</div>';
  }).join('');
}

// ── Spotify WebSocket ─────────────────────────────────────────────────────
const chip = document.getElementById('spotify-chip');
function setChip(ok) {
  chip.className = 'chip ' + (ok ? 'ok' : 'err');
  chip.innerHTML = '<span class="dot"></span> Spotify ' + (ok ? 'connected' : 'disconnected');
}
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(wsProto + '//' + location.host);
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', hubId }));
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'status') { setChip(m.authenticated); if (m.authenticated) { showApp(); loadMusicHome(); api('/api/player').then(onPlayer).catch(() => {}); } else showAuth(); }
  if (m.type === 'player') { setChip(m.authenticated); if (m.authenticated) { showApp(); onPlayer(m); } else showAuth(); }
};
ws.onerror = ws.onclose = () => { setChip(false); setInterval(() => api('/api/player').then(onPlayer).catch(() => {}), 5000); };

// ── Player state ──────────────────────────────────────────────────────────
let playing = false, shuffled = false, repeatState = 'off';
let progMs = 0, durMs = 1, ticker = null, volTimer = null, searchTimer = null;
let lastArtSrc = '', lastArtistIds = '', musicHomeLoaded = false;
const artistCache = {};
let viewStack = [], vplUri = '', varUri = '', valbUri = '', allPlaylists = [];

function api(path, opts = {}) {
  return fetch(path + (path.includes('?') ? '&' : '?') + 'hub=' + hubId, opts).then(r => r.json());
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(ms) { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); }

function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('music-app').classList.remove('ma-show');
}
function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('music-app').classList.add('ma-show');
}

function onPlayer(data) {
  if (!data.authenticated) { showAuth(); return; }
  showApp();
  if (!data.item) return;

  const name    = data.item.name;
  const artists = data.item.artists.map(a => a.name).join(', ');
  const album   = data.item.album?.name || '';
  const images  = data.item.album?.images || [];
  const src     = (images[1] || images[0])?.url || '';

  // Music tab — bottom bar
  document.getElementById('fp-track').textContent  = name;
  document.getElementById('fp-artist').textContent = artists;
  // Music tab — right sidebar
  document.getElementById('fp-ctx').textContent    = album;
  document.getElementById('np-track').textContent  = name;
  document.getElementById('np-artist').textContent = artists;
  // Home now-playing card
  document.getElementById('home-np-track').textContent  = name;
  document.getElementById('home-np-artist').textContent = artists;
  document.getElementById('home-np-album').textContent  = album;
  if (src) document.getElementById('home-np-art').src = src;

  if (src && src !== lastArtSrc) {
    lastArtSrc = src;
    document.getElementById('fp-art').src  = src;
    document.getElementById('bar-art').src = src;
    updateArtBg(src);
    tintMusicCard(src);
  }

  // Artist section
  const artistIds = data.item.artists.map(a => a.id).join(',');
  if (artistIds !== lastArtistIds) {
    lastArtistIds = artistIds;
    document.getElementById('np-artist-section').innerHTML = data.item.artists.map(a =>
      '<div class="np-a-row" data-id="' + a.id + '" onclick="openArtist(this.dataset.id)">' +
      '<img class="np-a-img" id="np-ai-' + a.id + '" src="" alt="">' +
      '<div><div class="np-a-name">' + esc(a.name) + '</div><div class="np-a-sub" id="np-ag-' + a.id + '">Artist</div></div></div>'
    ).join('');
    data.item.artists.forEach(a => {
      if (artistCache[a.id]) {
        applyArtistCache(a.id);
      } else {
        api('/api/artist/' + a.id).then(d => {
          artistCache[a.id] = d.artist || {};
          applyArtistCache(a.id);
        }).catch(() => {});
      }
    });
  }

  const npPlaying = document.getElementById('home-np-playing');
  const npRecent  = document.getElementById('home-np-recent');
  const musicLbl  = document.getElementById('home-music-label');
  if (npPlaying) npPlaying.style.display = 'block';
  if (npRecent)  npRecent.style.display  = 'none';
  if (musicLbl)  musicLbl.textContent    = 'Now Playing';

  // Like status + lyrics reset on track change
  const trackId = data.item.id;
  if (trackId && trackId !== currentTrackId) {
    currentTrackId = trackId;
    lyricsLoaded = false;
    if (centerTab === 'lyrics') loadLyrics();
    api('/api/like-status?ids=' + trackId).then(res => { if (Array.isArray(res)) updateLikeBtn(res[0]); }).catch(() => {});
  }

  playing = data.is_playing;
  progMs  = data.progress_ms || 0;
  durMs   = data.item.duration_ms || 1;
  clearInterval(ticker);
  if (playing) ticker = setInterval(() => { progMs = Math.min(progMs + 500, durMs); renderProg(); }, 500);
  renderProg();
  setPlayIcons(playing);
  if (data.device?.volume_percent != null) {
    document.getElementById('fp-vol').value = data.device.volume_percent;
    document.getElementById('home-np-vol').value = data.device.volume_percent;
  }
  shuffled = data.shuffle_state;
  document.getElementById('fp-shuffle').classList.toggle('lit', shuffled);
  if (data.repeat_state) { repeatState = data.repeat_state; renderRepeat(); }
}

function applyArtistCache(id) {
  const a = artistCache[id];
  if (!a) return;
  const img = document.getElementById('np-ai-' + id);
  const lbl = document.getElementById('np-ag-' + id);
  if (img && a.images?.[0]?.url) img.src = a.images[0].url;
  if (lbl && a.genres?.length) lbl.textContent = a.genres.slice(0, 2).join(', ');
}

function updateArtBg(src) {
  const img = document.getElementById('art-bg-img');
  img.classList.remove('vis');
  img.onload = () => img.classList.add('vis');
  img.src = src;
}
function onArtLoad(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 10;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 10, 10);
    const d = ctx.getImageData(0, 0, 10, 10).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; }
    const n = d.length / 4, f = 0.28;
    document.getElementById('art-bg').style.background =
      'rgb(' + ~~(17+(r/n-17)*f) + ',' + ~~(19+(g/n-19)*f) + ',' + ~~(24+(b/n-24)*f) + ')';
  } catch (_) {}
}

function renderProg() {
  const pct = Math.min(100, progMs / durMs * 100) + '%';
  document.getElementById('fp-fill').style.width      = pct;
  document.getElementById('home-np-bar').style.width  = pct;
  document.getElementById('fp-cur').textContent       = fmt(progMs);
  document.getElementById('fp-tot').textContent       = fmt(durMs);
  document.getElementById('home-np-cur').textContent  = fmt(progMs);
  document.getElementById('home-np-tot').textContent  = fmt(durMs);
}
function setPlayIcons(on) {
  const p = on ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  document.getElementById('fp-play-icon').innerHTML = p;
  document.getElementById('home-play-icon').innerHTML = p;
}
function renderRepeat() {
  document.getElementById('fp-repeat').classList.toggle('lit', repeatState !== 'off');
  document.getElementById('fp-repeat-icon').innerHTML = repeatState === 'track'
    ? '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/>'
    : '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
}

function action(name) { api('/api/player/' + name, { method: 'POST' }); }
function togglePlay() {
  playing = !playing; setPlayIcons(playing); action(playing ? 'play' : 'pause');
}
function toggleShuffle() {
  shuffled = !shuffled;
  document.getElementById('fp-shuffle').classList.toggle('lit', shuffled);
  api('/api/player/shuffle', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: shuffled }) });
}
function cycleRepeat() {
  repeatState = repeatState === 'off' ? 'context' : repeatState === 'context' ? 'track' : 'off';
  renderRepeat();
  api('/api/player/repeat', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: repeatState }) });
}
function seekTo(e) {
  const rect = document.getElementById('fp-bar').getBoundingClientRect();
  progMs = Math.floor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durMs);
  renderProg();
  fetch('/api/player/seek?hub=' + hubId + '&ms=' + progMs, { method: 'POST' });
}
function setVolume(val) {
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api('/api/player/volume', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ volume: val }) }), 250);
}
function playContext(uri, offset) {
  const body = {};
  if (uri) body.context_uri = uri;
  if (offset != null) body.offset = { position: offset };
  api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
}
function playUris(uris) {
  api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ uris }) });
}
function shuffleContext(uri) {
  if (!shuffled) { shuffled = true; document.getElementById('fp-shuffle').classList.add('lit'); api('/api/player/shuffle', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: true }) }); }
  playContext(uri);
}

function loadMusicHome() {
  if (musicHomeLoaded) return; musicHomeLoaded = true;
  setLibTab('playlists');
}

function onSearchInput() {
  const val = document.getElementById('search-input').value;
  document.getElementById('search-clear').style.display = val ? 'block' : 'none';
  clearTimeout(searchTimer);
  if (!val.trim()) {
    document.getElementById('search-content').style.display = 'none';
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  document.getElementById('search-content').style.display = 'block';
  document.getElementById('search-results').innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Searching…</div>';
  searchTimer = setTimeout(() => doSearch(val.trim()), 380);
}
function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  onSearchInput();
}
function doSearch(q) {
  api('/api/search?q=' + encodeURIComponent(q)).then(data => {
    let html = '';
    const tracks = data.tracks?.items?.filter(Boolean) || [];
    if (tracks.length) {
      html += '<div class="browse-section">Songs</div><div>';
      tracks.slice(0, 5).forEach(t => {
        html += '<div class="sr-row" data-uri="' + t.uri + '" onclick="playUris([this.dataset.uri])">' +
          '<img class="sr-art" src="' + (t.album?.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(t.name) + '</div><div class="sr-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div>' +
          '<span class="sr-dur">' + fmt(t.duration_ms) + '</span></div>';
      });
      html += '</div>';
    }
    const artists = data.artists?.items?.filter(Boolean) || [];
    if (artists.length) {
      html += '<div class="browse-section">Artists</div><div>';
      artists.slice(0, 4).forEach(a => {
        html += '<div class="sr-row" data-id="' + a.id + '" onclick="openArtist(this.dataset.id)">' +
          '<img class="sr-art round" src="' + (a.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(a.name) + '</div><div class="sr-sub">' + ((a.genres || []).slice(0, 1).join(', ') || 'Artist') + '</div></div>' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></div>';
      });
      html += '</div>';
    }
    const albums = data.albums?.items?.filter(Boolean) || [];
    if (albums.length) {
      html += '<div class="browse-section">Albums</div><div>';
      albums.slice(0, 4).forEach(a => {
        html += '<div class="sr-row" data-id="' + a.id + '" onclick="openAlbum(this.dataset.id)">' +
          '<img class="sr-art" src="' + (a.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(a.name) + '</div><div class="sr-sub">' + esc(a.artists[0]?.name || '') + ' · ' + (a.release_date?.slice(0, 4) || '') + '</div></div>' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></div>';
      });
      html += '</div>';
    }
    const playlists = data.playlists?.items?.filter(Boolean) || [];
    if (playlists.length) {
      html += '<div class="browse-section">Playlists</div><div>';
      playlists.slice(0, 4).forEach(p => {
        html += '<div class="sr-row" data-id="' + p.id + '" onclick="openPlaylist(this.dataset.id)">' +
          '<img class="sr-art" src="' + (p.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(p.name) + '</div><div class="sr-sub">' + (p.tracks?.total || '') + ' songs</div></div>' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></div>';
      });
      html += '</div>';
    }
    document.getElementById('search-results').innerHTML = html || '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">No results for "' + esc(q) + '"</div>';
  }).catch(() => { document.getElementById('search-results').innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Search failed</div>'; });
}

function openDetail(id) {
  viewStack.push({ id });
  const overlay = document.getElementById('view-overlay');
  ['view-all-playlists','view-playlist','view-artist','view-album'].forEach(v =>
    document.getElementById(v).style.display = v === id ? 'block' : 'none'
  );
  overlay.style.display = 'block'; overlay.scrollTop = 0;
}
function goBack() {
  viewStack.pop();
  const overlay = document.getElementById('view-overlay');
  if (viewStack.length) {
    const prev = viewStack[viewStack.length - 1];
    ['view-all-playlists','view-playlist','view-artist','view-album'].forEach(v =>
      document.getElementById(v).style.display = v === prev.id ? 'block' : 'none'
    );
    overlay.scrollTop = 0;
  } else { overlay.style.display = 'none'; }
}

function openPlaylist(id) {
  vplUri = 'spotify:playlist:' + id;
  document.getElementById('vpl-name').textContent = 'Loading…';
  document.getElementById('vpl-sub').textContent  = '';
  document.getElementById('vpl-art').src = '';
  document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;font-size:14px;">Loading…</div>';
  openDetail('view-playlist');
  Promise.all([api('/api/playlist/' + id), api('/api/playlist/' + id + '/tracks')]).then(([info, data]) => {
    document.getElementById('vpl-name').textContent = info.name || '';
    if (info.images?.[0]?.url) document.getElementById('vpl-art').src = info.images[0].url;
    const items = (data.items || []).filter(i => i?.track);
    document.getElementById('vpl-sub').textContent = (info.owner?.display_name ? info.owner.display_name + ' · ' : '') + items.length + ' songs';
    document.getElementById('vpl-tracks').innerHTML = items.map((item, idx) => {
      const t = item.track;
      return '<div class="det-track" data-uri="' + vplUri + '" data-off="' + idx + '" onclick="playContext(this.dataset.uri,+this.dataset.off)">' +
        '<span class="det-track-num">' + (idx+1) + '</span>' +
        '<img class="det-track-art" src="' + (t.album?.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
        '<div class="det-track-info"><div class="det-track-name">' + esc(t.name) + '</div><div class="det-track-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div>' +
        '<span class="det-track-dur">' + fmt(t.duration_ms) + '</span></div>';
    }).join('');
  }).catch(() => { document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;">Failed to load</div>'; });
}

function openArtist(id) {
  varUri = 'spotify:artist:' + id;
  document.getElementById('var-name').textContent = 'Loading…';
  document.getElementById('var-sub').textContent  = '';
  document.getElementById('var-art').src = '';
  document.getElementById('var-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;font-size:14px;">Loading…</div>';
  document.getElementById('var-albums').innerHTML = '';
  openDetail('view-artist');
  api('/api/artist/' + id).then(data => {
    const a = data.artist;
    document.getElementById('var-name').textContent = a.name;
    document.getElementById('var-sub').textContent  = (a.genres || []).slice(0, 2).join(', ');
    if (a.images?.[0]?.url) document.getElementById('var-art').src = a.images[0].url;
    document.getElementById('var-tracks').innerHTML = (data.topTracks || []).slice(0, 10).map((t, i) =>
      '<div class="det-track" data-uri="' + t.uri + '" onclick="playUris([this.dataset.uri])">' +
      '<span class="det-track-num">' + (i+1) + '</span>' +
      '<img class="det-track-art" src="' + (t.album?.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
      '<div class="det-track-info"><div class="det-track-name">' + esc(t.name) + '</div><div class="det-track-sub">' + esc(t.album?.name || '') + '</div></div>' +
      '<span class="det-track-dur">' + fmt(t.duration_ms) + '</span></div>'
    ).join('');
    document.getElementById('var-albums').innerHTML = (data.albums || []).map(alb =>
      '<div class="det-alb-card" data-id="' + alb.id + '" onclick="openAlbum(this.dataset.id)">' +
      '<img src="' + (alb.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
      '<div class="det-alb-info"><div class="det-alb-name">' + esc(alb.name) + '</div><div class="det-alb-sub">' + (alb.release_date?.slice(0,4) || '') + ' · ' + esc(alb.album_type) + '</div></div></div>'
    ).join('');
  });
}

function openAlbum(id) {
  valbUri = 'spotify:album:' + id;
  document.getElementById('valb-name').textContent = 'Loading…';
  document.getElementById('valb-sub').textContent  = '';
  document.getElementById('valb-art').src = '';
  document.getElementById('valb-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;font-size:14px;">Loading…</div>';
  openDetail('view-album');
  api('/api/album/' + id).then(data => {
    document.getElementById('valb-name').textContent = data.name;
    document.getElementById('valb-sub').textContent  = (data.artists || []).map(a => a.name).join(', ') + (data.release_date ? ' · ' + data.release_date.slice(0,4) : '');
    if (data.images?.[0]?.url) document.getElementById('valb-art').src = data.images[0].url;
    document.getElementById('valb-tracks').innerHTML = (data.tracks?.items || []).map((t, i) =>
      '<div class="det-track" data-uri="' + valbUri + '" data-off="' + i + '" onclick="playContext(this.dataset.uri,+this.dataset.off)">' +
      '<span class="det-track-num">' + (i+1) + '</span>' +
      '<div class="det-track-info" style="padding-left:4px;"><div class="det-track-name">' + esc(t.name) + '</div><div class="det-track-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div>' +
      '<span class="det-track-dur">' + fmt(t.duration_ms) + '</span></div>'
    ).join('');
  });
}

// ── Weather (full tab) ────────────────────────────────────────────────────
let wxLoaded = false;
const SHORT_DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function heroGradient(code, hour) {
  const c = +code;
  if (c === 200 || (c >= 386 && c <= 395)) return 'linear-gradient(160deg,#131c2b 0%,#111318 100%)';
  if (c >= 299 && c <= 359) return 'linear-gradient(160deg,#162435 0%,#111318 100%)';
  if ([119,122,143,248,260].includes(c)) return 'linear-gradient(160deg,#1e2730 0%,#111318 100%)';
  if ([227,230,323,326,329,332,335,338].includes(c)) return 'linear-gradient(160deg,#1b2b38 0%,#111318 100%)';
  if (hour >= 21 || hour < 5)  return 'linear-gradient(160deg,#0d1b2a 0%,#111318 100%)';
  if (hour < 8)                return 'linear-gradient(160deg,#2c1a4e 0%,#b05530 100%)';
  if (hour < 12)               return 'linear-gradient(160deg,#0e3a60 0%,#1a6ea8 100%)';
  if (hour < 17)               return 'linear-gradient(160deg,#0e3a72 0%,#1a5fa3 100%)';
  if (hour < 20)               return 'linear-gradient(160deg,#7d3066 0%,#b05530 100%)';
  return 'linear-gradient(160deg,#1a2540 0%,#111318 100%)';
}
function hourLabel(t) {
  const h = +t / 100;
  if (h === 0) return '12am'; if (h < 12) return h + 'am';
  if (h === 12) return '12pm'; return (h - 12) + 'pm';
}
function fmtTime(str) { return str ? str.replace(/^0/, '') : ''; }
function showWxError(msg) {
  document.getElementById('hero-wrap').innerHTML = '<div class="card mt-12" style="text-align:center;padding:40px 20px;color:var(--text-muted);">' + msg + '</div>';
}

function loadWx(city) {
  fetch('/api/weather?city=' + encodeURIComponent(city))
    .then(r => r.json()).then(renderWx).catch(() => showWxError('Weather unavailable.'));
}

function renderWx(data) {
  if (data.error) { showWxError(data.error); return; }
  const c    = data.current_condition[0];
  const area = data.nearest_area?.[0];
  const loc  = [area?.areaName?.[0]?.value, area?.region?.[0]?.value].filter(Boolean).join(', ');
  const today = data.weather?.[0];
  const hour  = new Date().getHours();
  const code  = c.weatherCode;

  document.getElementById('hero-wrap').innerHTML =
    '<div class="wx-hero" style="background:' + heroGradient(code, hour) + ';">' +
    '<div class="wx-hero-loc"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="opacity:.6"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>' + loc + '</div>' +
    '<div class="wx-hero-body"><div>' +
    '<div class="wx-temp">' + c.temp_C + '<sup>°</sup></div>' +
    '<div class="wx-desc">' + c.weatherDesc[0].value + '</div>' +
    '<div class="wx-sub">Feels like ' + c.FeelsLikeC + '°' + (today ? ' &nbsp;·&nbsp; H:' + today.maxtempC + '° &nbsp;L:' + today.mintempC + '°' : '') + '</div>' +
    '</div><div class="wx-icon-big">' + wxEmoji(code) + '</div></div></div>';

  const wind  = c.windspeedKmph + ' km/h ' + (c.winddir16Point || '');
  const uv    = +c.uvIndex;
  const uvLbl = uv <= 2 ? 'Low' : uv <= 5 ? 'Moderate' : uv <= 7 ? 'High' : uv <= 10 ? 'Very High' : 'Extreme';
  const stats = [
    { icon:'💧', val: c.humidity + '%',          lbl:'Humidity' },
    { icon:'💨', val: wind.trim(),                lbl:'Wind' },
    { icon:'🌡️', val: c.FeelsLikeC + '°C',      lbl:'Feels Like' },
    { icon:'☀️', val: uv + ' — ' + uvLbl,        lbl:'UV Index' },
    { icon:'👁️', val: c.visibility + ' km',      lbl:'Visibility' },
    { icon:'📊', val: c.pressure + ' mb',         lbl:'Pressure' },
  ];
  document.getElementById('stats-grid').innerHTML = stats.map(s =>
    '<div class="wx-stat"><div class="wx-stat-icon">' + s.icon + '</div><div class="wx-stat-val">' + s.val + '</div><div class="wx-stat-lbl">' + s.lbl + '</div></div>'
  ).join('');
  document.getElementById('stats-wrap').style.display = 'block';

  const astro = today?.astronomy?.[0];
  if (astro?.sunrise) {
    document.getElementById('sun-row').innerHTML =
      '<div class="wx-sun-card"><div class="wx-sun-emoji">🌅</div><div><div class="wx-sun-val">' + fmtTime(astro.sunrise) + '</div><div class="wx-sun-lbl">Sunrise</div></div></div>' +
      '<div class="wx-sun-card"><div class="wx-sun-emoji">🌇</div><div><div class="wx-sun-val">' + fmtTime(astro.sunset) + '</div><div class="wx-sun-lbl">Sunset</div></div></div>';
    document.getElementById('sun-wrap').style.display = 'block';
  }

  if (today?.hourly?.length) {
    const nowSlot = Math.round(hour / 3) * 3 * 100;
    let slots = today.hourly.map(h => ({ ...h, _day: 0 }));
    if (data.weather?.[1]) slots = slots.concat(data.weather[1].hourly.map(h => ({ ...h, _day: 1 })));
    const display = [...slots.filter(h => h._day === 0 && +h.time >= nowSlot - 300), ...slots.filter(h => h._day > 0)].slice(0, 10);
    document.getElementById('hourly-row').innerHTML = display.map(h => {
      const isNow = h._day === 0 && +h.time === nowSlot;
      const rain  = +h.chanceofrain;
      return '<div class="wx-hour' + (isNow ? ' now' : '') + '">' +
        '<div class="wx-hour-time">' + (isNow ? 'Now' : hourLabel(h.time)) + '</div>' +
        '<div class="wx-hour-icon">' + wxEmoji(h.weatherCode) + '</div>' +
        '<div class="wx-hour-temp">' + h.tempC + '°</div>' +
        '<div class="wx-hour-rain">' + (rain > 10 ? rain + '%' : '') + '</div></div>';
    }).join('');
    document.getElementById('hourly-wrap').style.display = 'block';
  }

  if (data.weather?.length) {
    const weekMin = Math.min(...data.weather.map(d => +d.mintempC));
    const weekMax = Math.max(...data.weather.map(d => +d.maxtempC));
    const range   = weekMax - weekMin || 1;
    document.getElementById('daily-list').innerHTML = data.weather.map((day, i) => {
      const d    = new Date(day.date);
      const lbl  = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : SHORT_DAY[d.getDay()];
      const icon = wxEmoji(day.hourly?.[4]?.weatherCode ?? 113);
      const lo   = +day.mintempC, hi = +day.maxtempC;
      const left  = Math.round((lo - weekMin) / range * 100);
      const width = Math.max(6, Math.round((hi - lo) / range * 100));
      return '<div class="wx-day"><div class="wx-day-name">' + lbl + '</div><div class="wx-day-icon">' + icon + '</div>' +
        '<div class="wx-day-lo">' + lo + '°</div>' +
        '<div class="wx-day-bar-wrap"><div class="wx-day-bar" style="left:' + left + '%;width:' + width + '%;"></div></div>' +
        '<div class="wx-day-hi">' + hi + '°</div></div>';
    }).join('');
    document.getElementById('daily-wrap').style.display = 'block';
  }
}

// ── Like button ───────────────────────────────────────────────────────────
let currentTrackId = '', trackLiked = false;
function updateLikeBtn(liked) {
  trackLiked = liked;
  const btn = document.getElementById('like-btn');
  const ico = document.getElementById('like-icon');
  btn.classList.toggle('liked', liked);
  ico.innerHTML = liked
    ? '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>'
    : '<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>';
}
function toggleLike() {
  if (!currentTrackId) return;
  const newLiked = !trackLiked;
  updateLikeBtn(newLiked);
  api('/api/like', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: currentTrackId, liked: newLiked }) })
    .catch(() => updateLikeBtn(!newLiked));
}

// ── Music center sub-tabs ─────────────────────────────────────────────────
let centerTab = 'search', libTab = 'playlists';
let discoverLoaded = false, libArtistsCache = null;
const CENTER_TABS = ['search','lyrics','discover'];

function setCenterTab(tab) {
  centerTab = tab;
  CENTER_TABS.forEach(t => {
    const sec = document.getElementById('ct-' + t + '-section');
    const btn = document.getElementById('ct-' + t);
    if (sec) sec.style.display = t === tab ? 'flex' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'lyrics')                    loadLyrics();
  if (tab === 'discover' && !discoverLoaded) { discoverLoaded = true; loadStats('medium_term'); loadNewReleases(); }
}

let libSidebarCache = {};
function setLibTab(tab) {
  libTab = tab;
  ['playlists','artists','recent'].forEach(t =>
    document.getElementById('lt-' + t)?.classList.toggle('active', t === tab)
  );
  const el = document.getElementById('sidebar-list');
  if (!el) return;
  if (tab === 'playlists') {
    if (libSidebarCache.playlists) { el.innerHTML = libSidebarCache.playlists; return; }
    api('/api/playlists').then(d => {
      allPlaylists = d.items || [];
      libSidebarCache.playlists = allPlaylists.map(p =>
        '<div class="sl-item" data-id="' + p.id + '" onclick="openPlaylist(this.dataset.id)">' +
        '<img src="' + (p.images?.[0]?.url || '') + '" alt="" loading="lazy">' +
        '<div class="sl-item-info"><div class="sl-item-name">' + esc(p.name) + '</div>' +
        '<div class="sl-item-sub">Playlist · ' + esc(p.owner?.display_name || '') + '</div></div></div>'
      ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No playlists</div>';
      el.innerHTML = libSidebarCache.playlists;
    }).catch(() => {});
  } else if (tab === 'artists') {
    if (libSidebarCache.artists) { el.innerHTML = libSidebarCache.artists; return; }
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Loading…</div>';
    api('/api/top-artists?range=medium_term').then(d => {
      libSidebarCache.artists = (d.items || []).map(a =>
        '<div class="sl-item" data-id="' + a.id + '" onclick="openArtist(this.dataset.id)">' +
        '<img src="' + (a.images?.at(-1)?.url || '') + '" alt="" loading="lazy" style="border-radius:50%;">' +
        '<div class="sl-item-info"><div class="sl-item-name">' + esc(a.name) + '</div>' +
        '<div class="sl-item-sub">' + (a.genres?.slice(0,1).join('') || 'Artist') + '</div></div></div>'
      ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No artists</div>';
      el.innerHTML = libSidebarCache.artists;
    }).catch(() => {});
  } else if (tab === 'recent') {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Loading…</div>';
    api('/api/recently-played').then(d => {
      const seen = new Set();
      const items = (d.items || []).filter(i => { if (seen.has(i.track?.id)) return false; seen.add(i.track?.id); return true; }).slice(0, 30);
      el.innerHTML = items.map(i => {
        const t = i.track;
        return '<div class="sl-item" data-uri="' + t.uri + '" onclick="playUris([this.dataset.uri])">' +
          '<img src="' + (t.album?.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
          '<div class="sl-item-info"><div class="sl-item-name">' + esc(t.name) + '</div>' +
          '<div class="sl-item-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div></div>';
      }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No history</div>';
    }).catch(() => {});
  }
}

// ── Stats tab ─────────────────────────────────────────────────────────────
let statsLoaded = false, statsRange = 'medium_term';
function setStatsRange(range) {
  statsRange = range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  document.getElementById('stats-artists').innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Loading…</div>';
  document.getElementById('stats-tracks').innerHTML  = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Loading…</div>';
  loadStats(range);
}
function loadStats(range) {
  api('/api/top-artists?range=' + range).then(d => {
    const el = document.getElementById('stats-artists');
    el.innerHTML = (d.items || []).map((a, i) =>
      '<div class="stat-artist-row" data-id="' + a.id + '" onclick="openArtist(this.dataset.id)">' +
      '<span class="stat-artist-rank">' + (i+1) + '</span>' +
      '<img class="stat-artist-img" src="' + (a.images?.at(-1)?.url||'') + '" alt="" loading="lazy">' +
      '<div><div class="stat-artist-name">' + esc(a.name) + '</div><div class="stat-artist-sub">' + (a.genres?.slice(0,2).join(', ')||'Artist') + '</div></div></div>'
    ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No data</div>';
  }).catch(() => {});
  api('/api/top-tracks?range=' + range).then(d => {
    const el = document.getElementById('stats-tracks');
    el.innerHTML = (d.items || []).map((t, i) =>
      '<div class="stat-track-row" data-uri="' + t.uri + '" onclick="playUris([this.dataset.uri])">' +
      '<span class="stat-track-rank">' + (i+1) + '</span>' +
      '<img class="stat-track-art" src="' + (t.album?.images?.at(-1)?.url||'') + '" alt="" loading="lazy">' +
      '<div class="q-info"><div class="stat-track-name">' + esc(t.name) + '</div><div class="stat-track-sub">' + esc(t.artists.map(a=>a.name).join(', ')) + '</div></div>' +
      '<span class="stat-track-dur">' + fmt(t.duration_ms) + '</span></div>'
    ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No data</div>';
  }).catch(() => {});
}
function loadNewReleases() {
  api('/api/new-releases').then(d => {
    document.getElementById('new-releases').innerHTML = (d.albums || []).map(a =>
      '<div class="new-rel-card" data-id="' + a.id + '" onclick="navigate(\'music\');openAlbum(this.dataset.id)">' +
      '<img src="' + (a.images?.at(-1)?.url||'') + '" alt="" loading="lazy">' +
      '<div class="new-rel-info"><div class="new-rel-name">' + esc(a.name) + '</div>' +
      '<div class="new-rel-sub">' + esc(a.artists[0]?.name||'') + '</div></div></div>'
    ).join('');
  }).catch(() => {});
}

// ── Timer / Stopwatch ─────────────────────────────────────────────────────
let swRunning = false, swStart = 0, swElapsed = 0, swRaf = null, swLaps = [];
let timers = [], timerInterval = null;
let timerViewInited = false;

function swFmt(ms) {
  const t = Math.floor(ms / 100);
  const d = t % 10, s = Math.floor(t/10) % 60, m = Math.floor(t/600) % 60, h = Math.floor(t/36000);
  return (h ? h + ':' + String(m).padStart(2,'0') : String(m).padStart(2,'0')) + ':' + String(s).padStart(2,'0') + '.' + d;
}
function swRender() {
  const el = document.getElementById('sw-display');
  if (!el) return;
  const t = swRunning ? swElapsed + Date.now() - swStart : swElapsed;
  const d = t % 100, s = Math.floor(t/1000) % 60, m = Math.floor(t/60000) % 60, h = Math.floor(t/3600000);
  const str = (h ? h + ':' + String(m).padStart(2,'0') : String(m).padStart(2,'0')) + ':' + String(s).padStart(2,'0');
  el.innerHTML = str + '<span style="font-size:32px;letter-spacing:0;">.' + String(Math.floor(d/10)) + '</span>';
  const hEl = document.getElementById('home-sw-display');
  const hLbl = document.getElementById('home-sw-label');
  if (hEl) hEl.textContent = str;
  if (hLbl) hLbl.textContent = swRunning ? 'Running' : (swElapsed > 0 ? 'Paused' : 'Stopwatch ready');
  if (swRunning) swRaf = requestAnimationFrame(swRender);
}
function swToggle() {
  const btn = document.getElementById('sw-start-btn');
  if (!swRunning) { swRunning = true; swStart = Date.now(); swRaf = requestAnimationFrame(swRender); btn.textContent = 'Stop'; btn.classList.remove('go'); btn.style.background='var(--red-bg)'; btn.style.color='var(--red)'; }
  else { swRunning = false; swElapsed += Date.now() - swStart; cancelAnimationFrame(swRaf); btn.textContent = 'Start'; btn.classList.add('go'); btn.style.background=''; btn.style.color=''; }
}
function swReset() {
  swRunning = false; cancelAnimationFrame(swRaf); swElapsed = 0; swLaps = [];
  const btn = document.getElementById('sw-start-btn');
  btn.textContent = 'Start'; btn.classList.add('go'); btn.style.background=''; btn.style.color='';
  document.getElementById('sw-display').innerHTML = '00:00<span style="font-size:32px;letter-spacing:0;">.0</span>';
  document.getElementById('sw-laps').innerHTML = '';
  const hEl = document.getElementById('home-sw-display'); if (hEl) hEl.textContent = '00:00';
  const hLbl = document.getElementById('home-sw-label'); if (hLbl) hLbl.textContent = 'Stopwatch ready';
}
function swLap() {
  if (!swRunning) return;
  const t = swElapsed + Date.now() - swStart;
  swLaps.unshift(t);
  document.getElementById('sw-laps').innerHTML = swLaps.map((ms, i) =>
    '<div class="sw-lap"><span>Lap ' + (swLaps.length - i) + '</span><span>' + swFmt(ms) + '</span></div>'
  ).join('');
}

function timerFmt(s) {
  const h = Math.floor(s/3600), m = Math.floor(s/60)%60, sec = s%60;
  return (h ? h + ':' + String(m).padStart(2,'0') : String(m).padStart(2,'0')) + ':' + String(sec).padStart(2,'0');
}
function addTimer(totalSecs, label) {
  const id = Date.now();
  timers.push({ id, total: totalSecs, remaining: totalSecs, label, running: false, done: false });
  renderTimers();
  if (!timerInterval) timerInterval = setInterval(tickTimers, 1000);
}
function promptTimer() {
  const val = prompt('Duration (e.g. 90 for 90 seconds, or mm:ss):');
  if (!val) return;
  let secs = 0;
  if (val.includes(':')) { const [m,s] = val.split(':'); secs = (+m)*60 + (+s); }
  else secs = +val;
  if (secs > 0) addTimer(Math.round(secs), timerFmt(Math.round(secs)));
}
function tickTimers() {
  let changed = false;
  timers.forEach(t => {
    if (t.running && t.remaining > 0) { t.remaining--; changed = true; if (t.remaining === 0) { t.done = true; t.running = false; notifyTimer(t); } }
  });
  if (changed) { renderTimers(); updateHomeTimers(); }
}
function notifyTimer(t) {
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification('Timer done!', { body: t.label, icon: '/favicon.ico' });
  try { const ctx = new AudioContext(); const o = ctx.createOscillator(); o.connect(ctx.destination); o.frequency.value = 880; o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 300); } catch(_) {}
}
function removeTimer(id) { timers = timers.filter(t => t.id !== id); renderTimers(); if (!timers.some(t=>t.running)) { clearInterval(timerInterval); timerInterval = null; } }
function toggleTimer(id) {
  const t = timers.find(t => t.id === id);
  if (!t || t.done) return;
  t.running = !t.running;
  if (t.running && !timerInterval) timerInterval = setInterval(tickTimers, 1000);
  renderTimers();
}
function resetTimer(id) {
  const t = timers.find(t => t.id === id);
  if (!t) return;
  t.remaining = t.total; t.running = false; t.done = false;
  renderTimers();
}
function renderTimers() {
  const el = document.getElementById('timers-list');
  if (!el) return;
  const r = 24, circ = 2 * Math.PI * r;
  el.innerHTML = timers.map(t => {
    const pct = t.total > 0 ? t.remaining / t.total : 0;
    const dash = circ * pct;
    return '<div class="timer-card' + (t.done ? ' timer-done' : '') + '">' +
      '<div class="timer-circle-wrap"><svg class="timer-circle" viewBox="0 0 56 56">' +
      '<circle class="timer-track" cx="28" cy="28" r="' + r + '"/>' +
      '<circle class="timer-prog" cx="28" cy="28" r="' + r + '" stroke-dasharray="' + circ + '" stroke-dashoffset="' + (circ - dash) + '"/>' +
      '</svg></div>' +
      '<div class="timer-info"><div class="timer-time">' + timerFmt(t.remaining) + '</div><div class="timer-label">' + esc(t.label) + (t.done ? ' — Done!' : '') + '</div></div>' +
      '<div class="timer-btns">' +
      '<button class="timer-btn' + (t.running ? ' active' : '') + '" onclick="toggleTimer(' + t.id + ')">' +
      (t.done ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>' :
       t.running ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>' :
                   '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>') +
      '</button>' +
      '<button class="timer-btn" onclick="resetTimer(' + t.id + ')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>' +
      '<button class="timer-btn" onclick="removeTimer(' + t.id + ')"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
      '</div></div>';
  }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Add a timer above</div>';
}
function initTimerView() {
  if (!timerViewInited) { timerViewInited = true; if ('Notification' in window) Notification.requestPermission(); }
  renderTimers();
}

// ── Lyrics (music center sub-tab) ─────────────────────────────────────────
let lyricsTrack = '', lyricsArtist = '', lyricsLoaded = false;

function loadLyrics() {
  const trackEl  = document.getElementById('fp-track');
  const artistEl = document.getElementById('fp-artist');
  const track    = trackEl?.textContent.trim()  || '';
  const artist   = artistEl?.textContent.trim() || '';
  const statusEl = document.getElementById('lyrics-status');
  const bodyEl   = document.getElementById('lyrics-body');
  const nameEl   = document.getElementById('lyrics-track-name');
  const artEl    = document.getElementById('lyrics-track-artist');
  if (!track || track === '--') {
    if (statusEl) statusEl.textContent = 'No track playing';
    return;
  }
  if (track === lyricsTrack && artist === lyricsArtist && lyricsLoaded) return;
  lyricsTrack = track; lyricsArtist = artist; lyricsLoaded = false;
  if (nameEl)   nameEl.textContent   = track;
  if (artEl)    artEl.textContent    = artist;
  if (statusEl) statusEl.textContent = 'Loading lyrics…';
  if (bodyEl)   bodyEl.textContent   = '';
  fetch('/api/lyrics?artist=' + encodeURIComponent(artist) + '&track=' + encodeURIComponent(track) + '&hub=' + hubId)
    .then(r => r.json()).then(d => {
      lyricsLoaded = true;
      if (d.lyrics) {
        if (statusEl) statusEl.style.display = 'none';
        if (bodyEl)   bodyEl.textContent = d.lyrics.replace(/\r\n/g,'\n').trim();
      } else {
        if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'No lyrics found for this track'; }
        if (bodyEl)   bodyEl.textContent = '';
      }
    }).catch(() => {
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Could not load lyrics'; }
    });
}

// ── Finance / Crypto ──────────────────────────────────────────────────────
let financeLoaded = false, cryptoData = null;

function loadCrypto(force) {
  const el = document.getElementById('crypto-list');
  if (!el) return;
  if (cryptoData && !force) { renderCrypto(cryptoData); return; }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px 0;text-align:center;">Loading…</div>';
  fetch('/api/crypto?hub=' + hubId)
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

// ── System ────────────────────────────────────────────────────────────────
let sysAutoInterval = null;

function toggleSysAuto(on) {
  clearInterval(sysAutoInterval);
  if (on) { loadSystem(); sysAutoInterval = setInterval(loadSystem, 5000); }
}

function loadSystem() {
  fetch('/api/system?hub=' + hubId).then(r => r.json()).then(d => {
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

// ── News ──────────────────────────────────────────────────────────────────
let newsLoaded = false, newsSub = 'worldnews';

function setNewsSub(sub) {
  newsSub = sub;
  document.querySelectorAll('.news-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  loadNews(sub);
}
function loadNews(sub) {
  const el = document.getElementById('news-list');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">Loading…</div>';
  fetch('/api/news?sub=' + encodeURIComponent(sub) + '&hub=' + hubId)
    .then(r => r.json()).then(posts => {
      if (!Array.isArray(posts) || !posts.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">No posts found</div>'; return; }
      el.innerHTML = posts.map(p => {
        const imgSrc = p.preview || p.thumb || '';
        const thumb = imgSrc ? '<img class="news-thumb" src="' + esc(imgSrc) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '';
        const age = p.created ? Math.round((Date.now()/1000 - p.created) / 3600) : '?';
        return '<div class="news-card" onclick="window.open(' + JSON.stringify(p.url) + ',\'_blank\')">' +
          (thumb || '') +
          '<div class="news-body"><div class="news-title">' + esc(p.title) + '</div>' +
          '<div class="news-meta"><span>r/' + esc(p.sub || '') + '</span>' +
          '<span class="news-score">▲ ' + (p.score > 999 ? (p.score/1000).toFixed(1) + 'k' : p.score) + '</span>' +
          '<span>' + age + 'h ago</span></div></div></div>';
      }).join('');
    }).catch(() => { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">Could not load feed</div>'; });
}

// ── Radio map (Leaflet) ───────────────────────────────────────────────────
let radioMap = null, radioMarkers = [], radioAudio = null, radioStation = null;
let radioGenre = '', radioStations = [], radioMapInited = false;

function initRadioMap() {
  if (radioMapInited) { setTimeout(() => radioMap && radioMap.invalidateSize(), 60); return; }
  radioMapInited = true;
  setRadioLoading(true);
  if (window.L) { setupRadioMap(); return; }
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(css);
  const js = document.createElement('script');
  js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  js.onload = setupRadioMap;
  document.head.appendChild(js);
}

function setupRadioMap() {
  radioMap = L.map('radio-map', {
    center: [30, 10], zoom: 2, minZoom: 2, maxZoom: 10,
    zoomControl: true, attributionControl: true,
    worldCopyJump: false,
    maxBounds: [[-85.05, -180], [85.05, 180]],
    maxBoundsViscosity: 1.0,
  });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri',
    maxZoom: 16, noWrap: true,
  }).addTo(radioMap);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    attribution: '',
    maxZoom: 16, noWrap: true,
  }).addTo(radioMap);
  loadRadioStations('');
}

function setRadioLoading(vis) {
  document.getElementById('rmap-loading')?.classList.toggle('vis', vis);
}

function switchRadioGenre(genre) {
  radioGenre = genre;
  document.querySelectorAll('.rmap-genre').forEach(b => b.classList.toggle('active', b.dataset.genre === genre));
  if (radioMapInited) loadRadioStations(genre);
}

function loadRadioStations(genre) {
  setRadioLoading(true);
  fetch('/api/radio?tag=' + encodeURIComponent(genre) + '&limit=500&hub=' + hubId)
    .then(r => r.json()).then(stations => {
      setRadioLoading(false);
      if (!Array.isArray(stations)) return;
      radioStations = stations;
      placeRadioMarkers();
      renderRadioList('');
    }).catch(() => setRadioLoading(false));
}

function placeRadioMarkers() {
  radioMarkers.forEach(m => m.remove());
  radioMarkers = [];
  radioStations.forEach(s => {
    if (!s.geo_lat || !s.geo_long) return;
    const playing = radioStation?.stationuuid === s.stationuuid;
    const votes = s.votes || 0;
    const sz = Math.min(18, Math.max(7, 5 + Math.log2(votes + 1) * 1.5)) | 0;
    const icon = L.divIcon({
      className: '',
      html: '<div class="rmap-dot' + (playing ? ' playing' : '') + '" style="width:' + sz + 'px;height:' + sz + 'px;"></div>',
      iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    });
    const marker = L.marker([s.geo_lat, s.geo_long], { icon }).addTo(radioMap);
    marker.bindPopup(buildRadioPopup(s), { maxWidth: 280, minWidth: 200, className: 'rmap-popup-wrap' });
    marker.on('click', () => setTimeout(() => wirePopupBtn(s), 50));
    radioMarkers.push(marker);
  });
}

let radioListFilter = '';
function filterRadioList(q) {
  radioListFilter = q.toLowerCase();
  renderRadioList(radioListFilter);
}
function renderRadioList(q) {
  const el = document.getElementById('rmap-list');
  if (!el) return;
  const list = q
    ? radioStations.filter(s => s.name?.toLowerCase().includes(q) || s.country?.toLowerCase().includes(q) || s.tags?.toLowerCase().includes(q))
    : radioStations;
  if (!list.length) { el.innerHTML = '<div class="rmap-list-dim">No stations found</div>'; return; }
  const rows = list.slice(0, 200);
  el.innerHTML = rows.map((s, i) => {
    const playing = radioStation?.stationuuid === s.stationuuid;
    const meta = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
    return '<div class="rmap-station-row' + (playing ? ' playing' : '') + '" data-idx="' + i + '" onclick="playStationByIdx(this)">' +
      '<img class="rmap-station-fav" src="' + esc(s.favicon || '') + '" alt="" onerror="this.style.opacity=0">' +
      '<div class="rmap-station-info">' +
        '<div class="rmap-station-name">' + esc(s.name) + '</div>' +
        '<div class="rmap-station-meta">' + esc(meta) + '</div>' +
      '</div>' +
      '<span class="rmap-station-play">' + (playing ? '▶' : '▷') + '</span>' +
    '</div>';
  }).join('');
  el._rows = rows;
}

function playStationByIdx(el) {
  const list = document.getElementById('rmap-list');
  const s = list?._rows?.[+el.dataset.idx];
  if (s) playStation(s);
}
function setRadioVolume(val) {
  if (radioAudio) radioAudio.volume = val / 100;
}

function buildRadioPopup(s) {
  const playing = radioStation?.stationuuid === s.stationuuid;
  const tags = (s.tags || '').split(',').slice(0, 4).filter(Boolean).join(' · ');
  const meta = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
  return '<div class="rmap-popup">' +
    '<div class="rmap-popup-top">' +
      (s.favicon ? '<img class="rmap-popup-favicon" src="' + esc(s.favicon) + '" alt="" onerror="this.style.opacity=0">' : '<div class="rmap-popup-favicon" style="display:flex;align-items:center;justify-content:center;font-size:20px;">📻</div>') +
      '<div><div class="rmap-popup-name">' + esc(s.name) + '</div><div class="rmap-popup-country">' + esc(s.country || '') + '</div></div>' +
    '</div>' +
    (tags ? '<div class="rmap-popup-tags">' + esc(tags) + '</div>' : '') +
    (meta ? '<div class="rmap-popup-meta">' + esc(meta) + '</div>' : '') +
    '<button class="rmap-popup-play' + (playing ? ' stop' : '') + '" id="rmap-popup-btn">' +
      (playing ? '■ Stop' : '▶ Play') +
    '</button>' +
  '</div>';
}

function wirePopupBtn(s) {
  const btn = document.getElementById('rmap-popup-btn');
  if (!btn) return;
  btn.onclick = () => {
    if (radioStation?.stationuuid === s.stationuuid) { stopRadio(); radioMap.closePopup(); }
    else { playStation(s); radioMap.closePopup(); }
  };
}

function playStation(s) {
  if (radioAudio) { radioAudio.pause(); radioAudio = null; }
  radioStation = s;
  radioAudio = new Audio(s.url_resolved);
  const vol = document.getElementById('rmap-vol');
  radioAudio.volume = vol ? vol.value / 100 : 0.8;
  radioAudio.play().catch(() => {});
  const np = document.getElementById('rmap-np');
  if (np) {
    np.classList.add('vis');
    const fav = document.getElementById('rmap-np-favicon');
    if (fav) { fav.src = s.favicon || ''; fav.onerror = () => { fav.style.opacity = '0'; }; fav.style.opacity = '1'; }
    document.getElementById('rmap-np-name').textContent = s.name;
    document.getElementById('rmap-np-meta').textContent = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
  }
  placeRadioMarkers();
  renderRadioList(radioListFilter);
}

function stopRadio() {
  if (radioAudio) { radioAudio.pause(); radioAudio = null; }
  radioStation = null;
  document.getElementById('rmap-np')?.classList.remove('vis');
  placeRadioMarkers();
  renderRadioList(radioListFilter);
}

// ── Fullscreen ────────────────────────────────────────────────────────────
const FS_EXPAND = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const FS_SHRINK = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  document.getElementById('fs-path').setAttribute('d', document.fullscreenElement ? FS_SHRINK : FS_EXPAND);
});
