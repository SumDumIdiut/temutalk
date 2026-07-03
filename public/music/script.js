function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('music-app').classList.remove('ma-show');
}
let _credsSynced = false;
function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('music-app').classList.add('ma-show');
  if (!_credsSynced) {
    _credsSynced = true;
    const { cid, csec } = getSpotifyCreds();
    if (cid && csec) {
      api('/api/save-creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: cid, clientSecret: csec }) }).catch(() => {});
    }
    loadBrowserPlayer();
  }
}

// ── Spotify Web Playback SDK (browser player) ─────────────────────────────────
let browserPlayer = null;
let browserPlayerReady = false;

function _setBrowserPlayerStatus(s) {
  const el = document.getElementById('browser-player-status');
  if (el) el.textContent = s;
  console.log('[player]', s);
}

function loadBrowserPlayer() {
  if (browserPlayer) return;
  console.log('[player] loadBrowserPlayer called, window.Spotify=', !!window.Spotify);
  if (window.Spotify) { _initBrowserPlayer(); return; }

  window.onSpotifyWebPlaybackSDKReady = _initBrowserPlayer;
  _setBrowserPlayerStatus('loading SDK…');

  // Use fetch + blob URL to bypass any script-tag blocking
  fetch('/sp/spotify-player.js')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const tag = document.createElement('script');
      tag.src = url;
      tag.addEventListener('load',  () => { URL.revokeObjectURL(url); console.log('[player] SDK blob loaded'); });
      tag.addEventListener('error', e => _setBrowserPlayerStatus('blob exec failed'));
      document.head.appendChild(tag);
    })
    .catch(e => {
      _setBrowserPlayerStatus('fetch failed: ' + e.message);
      const tag = document.createElement('script');
      tag.src = '/sp/spotify-player.js';
      document.head.appendChild(tag);
    });

  // Poll for window.Spotify in case callback fires before we're ready
  let polls = 0;
  const poll = setInterval(() => {
    polls++;
    if (window.Spotify && !browserPlayer) { clearInterval(poll); _initBrowserPlayer(); return; }
    if (polls > 120) { clearInterval(poll); _setBrowserPlayerStatus('SDK load timed out after 60s'); }
  }, 500);
}

function _initBrowserPlayer() {
  if (browserPlayer) return;
  _setBrowserPlayerStatus('connecting…');
  const vol = (document.getElementById('fp-vol')?.value ?? 50) / 100;
  browserPlayer = new Spotify.Player({
    name: 'TemuTalk',
    getOAuthToken: cb => {
      fetch('/api/token?device=' + deviceId).then(r => r.json()).then(d => {
        const tok = d.token || d.access_token || '';
        console.log('[player] getOAuthToken returning:', tok ? tok.slice(0,20)+'…' : '(empty)', 'd=', JSON.stringify(d).slice(0,80));
        cb(tok);
      }).catch(e => { console.log('[player] getOAuthToken fetch error:', e); cb(''); });
    },
    volume: vol,
  });
  browserPlayer.addListener('ready', ({ device_id }) => {
    browserPlayerReady = true;
    browserPlayer._deviceId = device_id;
    _setBrowserPlayerStatus('ready ✓ ' + device_id.slice(0,8));
    api('/api/transfer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id, play: false }) }).catch(() => {});
  });
  browserPlayer.addListener('not_ready', ({ device_id }) => { browserPlayerReady = false; _setBrowserPlayerStatus('not ready'); });
  browserPlayer.addListener('initialization_error', ({ message }) => _setBrowserPlayerStatus('init error: ' + message));
  browserPlayer.addListener('authentication_error', ({ message }) => _setBrowserPlayerStatus('auth error: ' + message));
  browserPlayer.addListener('account_error',        ({ message }) => _setBrowserPlayerStatus('account error: ' + message));
  browserPlayer.connect().then(ok => console.log('[player] connect() resolved:', ok));
  setTimeout(() => {
    const iframe = document.querySelector('iframe[allow*="encrypted-media"]');
    console.log('[player] iframe in DOM:', !!iframe, iframe?.src);
  }, 2000);
  document.addEventListener('click', function _activate() {
    browserPlayer.activateElement();
    document.removeEventListener('click', _activate);
  }, { once: true });
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
  const npEmpty = document.getElementById('np-empty');
  const npDetails = document.getElementById('np-details');
  const npDivider = document.getElementById('np-divider');
  if (npEmpty)   npEmpty.style.display = 'none';
  if (npDetails) npDetails.classList.remove('np-empty');
  if (npDivider) npDivider.style.display = '';
  // Home now-playing card
  document.getElementById('home-np-track').textContent  = name;
  document.getElementById('home-np-artist').textContent = artists;
  document.getElementById('home-np-album').textContent  = album;
  if (src) document.getElementById('home-np-art').src = src;

  if (src && src !== lastArtSrc) {
    lastArtSrc = src;
    document.getElementById('fp-art').src  = src;
    document.getElementById('bar-art').src = src;
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

  hasTrack = true;
  // Stop radio if Spotify starts playing (only one audio source at a time)
  if (data.is_playing && radioStation) stopRadio();
  // Only show Spotify NP if radio isn't taking the card
  if (!radioStation) {
    const npPlaying = document.getElementById('home-np-playing');
    const npRecent  = document.getElementById('home-np-recent');
    const musicLbl  = document.getElementById('home-music-label');
    if (npPlaying) npPlaying.style.display = 'block';
    if (npRecent)  npRecent.style.display  = 'none';
    if (musicLbl)  { musicLbl.textContent = 'Now Playing'; musicLbl.style.color = ''; }
  }

  // Like status + lyrics reset on track change
  const trackId = data.item.id;
  if (trackId && trackId !== currentTrackId) {
    currentTrackId = trackId;
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
    _serverVolume = true;
    document.getElementById('fp-vol').value = data.device.volume_percent;
    document.getElementById('home-np-vol').value = data.device.volume_percent;
    _serverVolume = false;
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

function onArtLoad(img) {
  try {
    const SZ = 24;
    const c = document.createElement('canvas'); c.width = c.height = SZ;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, SZ, SZ);
    const d = cx.getImageData(0, 0, SZ, SZ).data;
    const n = d.length / 4;

    // Extract most vibrant accent color
    let bH = 262, bS = 72, best = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]/255, g = d[i+1]/255, b = d[i+2]/255;
      const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max - min;
      if (delta < 0.08) continue;
      const l = (max + min) / 2;
      if (l < 0.10 || l > 0.90) continue;
      const s = delta / (1 - Math.abs(2*l - 1));
      const score = s * 0.7 + (1 - Math.abs(l - 0.5)) * 0.3;
      if (score > best) {
        best = score;
        let h;
        if (max === r)      h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / delta + 2) / 6;
        else                h = ((r - g) / delta + 4) / 6;
        bH = Math.round(h * 360);
        bS = Math.round(Math.min(s, 1) * 100);
      }
    }

    // Apply accent only when auto-colour is on
    if (themeAutoAccent) {
      const R = document.documentElement;
      R.style.setProperty('--primary',      `hsl(${bH},${bS}%,73%)`);
      R.style.setProperty('--primary-dim',  `hsla(${bH},${bS}%,73%,.16)`);
      R.style.setProperty('--primary-dark', `hsla(${bH},${bS}%,73%,.12)`);
      R.style.setProperty('--primary-glow', `hsla(${bH},${bS}%,73%,.4)`);
    }
  } catch (_) {}
}

function renderProg() {
  const delay = typeof getCastDelay === 'function' ? getCastDelay() : 0;
  const disp  = Math.max(0, progMs - delay);
  const pct   = Math.min(100, disp / durMs * 100) + '%';
  document.getElementById('fp-fill').style.width      = pct;
  document.getElementById('home-np-bar').style.width  = pct;
  document.getElementById('fp-cur').textContent       = fmt(disp);
  document.getElementById('fp-tot').textContent       = fmt(durMs);
  document.getElementById('home-np-cur').textContent  = fmt(disp);
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

function action(name) {
  if (browserPlayer && browserPlayerReady) {
    if (name === 'play') {
      browserPlayer.activateElement();
      browserPlayer.getCurrentState().then(state => {
        if (state) {
          browserPlayer.resume();
        } else {
          // Nothing queued on browser player — transfer playback to it first
          api('/api/transfer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: browserPlayer._deviceId }) })
            .then(() => setTimeout(() => browserPlayer.resume(), 600))
            .catch(() => api('/api/player/play', { method: 'POST' }));
        }
      });
      return;
    }
    if (name === 'pause')    { browserPlayer.pause(); return; }
    if (name === 'next')     { browserPlayer.nextTrack(); return; }
    if (name === 'previous') { browserPlayer.previousTrack(); return; }
  }
  api('/api/player/' + name, { method: 'POST' });
}
function togglePlay() {
  if (browserPlayer) browserPlayer.activateElement();
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
  if (browserPlayer && browserPlayerReady) browserPlayer.seek(progMs);
  else fetch('/api/player/seek?device=' + deviceId + '&ms=' + progMs, { method: 'POST' });
}
function setVolume(val) {
  if (_serverVolume) return;
  if (browserPlayer) browserPlayer.setVolume(val / 100).catch(() => {});
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api('/api/player/volume', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ volume: val }) }), 250);
}
function _playErr(e) {
  const msg = e?.error || 'Playback failed — make sure Spotify is open on a device';
  alert(msg);
}
function playContext(uri, offset) {
  const body = {};
  if (uri) body.context_uri = uri;
  if (offset != null) body.offset = { position: offset };
  api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(r => { if (r.error) _playErr(r); }).catch(() => _playErr());
}
function playUris(uris) {
  api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ uris }) })
    .then(r => { if (r.error) _playErr(r); }).catch(() => _playErr());
}
function shuffleContext(uri) {
  if (!shuffled) { shuffled = true; document.getElementById('fp-shuffle').classList.add('lit'); api('/api/player/shuffle', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: true }) }); }
  playContext(uri);
}

let _meId = null, _meName = null;
function loadMe() {
  if (_meId) return Promise.resolve();
  return api('/api/me').then(d => { _meId = d.id; _meName = d.display_name || d.id; }).catch(() => {});
}
function ownerLabel(p) {
  if (!p.owner) return '';
  const id = p.owner.id, name = p.owner.display_name;
  if (id && _meId && id === _meId) return _meName || 'You';
  // hide raw spotify IDs (22-char alphanumeric) and fall back to "Spotify"
  if (!name || /^[a-z0-9]{15,}$/.test(name)) return id === 'spotify' ? 'Spotify' : (name || '');
  return name;
}

function loadMusicHome() {
  if (musicHomeLoaded) return; musicHomeLoaded = true;
  loadMe().then(() => setLibTab('playlists'));
  if (!discoverLoaded) { discoverLoaded = true; loadStats('medium_term'); loadNewReleases(); }
  if (document.documentElement.classList.contains('mobile')) setMobileTab('library');
}

function setMobileTab(tab) {
  ['library','browse','nowplaying'].forEach(t =>
    document.getElementById('mmt-' + t)?.classList.toggle('active', t === tab)
  );
  const ls = document.getElementById('left-sidebar');
  const cp = document.getElementById('center-panel');
  const rs = document.getElementById('right-sidebar');
  if (!document.documentElement.classList.contains('mobile')) {
    // Desktop: ensure all panels are visible (clear any stale inline styles)
    if (ls) ls.style.display = '';
    if (cp) cp.style.display = '';
    if (rs) rs.style.display = '';
    return;
  }
  if (ls) ls.style.display = tab === 'library'    ? 'flex' : 'none';
  if (cp) cp.style.display = tab === 'browse'     ? 'flex' : 'none';
  if (rs) rs.style.display = tab === 'nowplaying' ? 'flex' : 'none';
  document.documentElement.classList.toggle('mob-nowplaying', tab === 'nowplaying');
}
window.setMobileTab = setMobileTab;
function onSearchInput() {
  const val = document.getElementById('search-input').value;
  document.getElementById('search-clear').style.display = val ? 'block' : 'none';
  clearTimeout(searchTimer);
  if (!val.trim()) {
    document.getElementById('search-content').style.display = 'none';
    document.getElementById('discover-section').style.display = '';
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  document.getElementById('discover-section').style.display = 'none';
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
    document.getElementById('vpl-sub').textContent = (info.owner ? ownerLabel(info) + ' · ' : '') + items.length + ' songs';
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

// ── Library sidebar tabs ───────────────────────────────────────────────────
let libTab = 'playlists';
let discoverLoaded = false, libArtistsCache = null;

let libSidebarCache = {};
function setLibTab(tab) {
  libTab = tab;
  ['playlists','artists','recent','live'].forEach(t =>
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
        '<div class="sl-item-sub">Playlist · ' + esc(ownerLabel(p)) + '</div></div></div>'
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
  } else if (tab === 'live') {
    liveRenderSidebar();
    return;
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
    el.innerHTML = (d.items || []).filter(t => t && t.name).map((t, i) =>
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


// ── Lyrics (music center sub-tab) ─────────────────────────────────────────
let lyricsTrack = '', lyricsArtist = '', lyricsLoaded = false;
let lyricsLines = [], lyricsTimes = [], lyricsCurrentIdx = -1;

function parseLrc(lrc) {
  // returns [{time: ms, text: string}]
  const out = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
    if (m) out.push({ time: (parseInt(m[1]) * 60 + parseFloat(m[2])) * 1000, text: m[3].trim() });
  }
  return out;
}

function loadLyrics() {
  const trackEl  = document.getElementById('fp-track');
  const artistEl = document.getElementById('fp-artist');
  const albumEl  = document.getElementById('fp-artist'); // album stored in np-album hidden el
  const track    = trackEl?.textContent.trim()  || '';
  const artist   = artistEl?.textContent.trim() || '';
  const album    = document.getElementById('home-np-album')?.textContent.trim() || '';
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
  lyricsLines = []; lyricsTimes = []; lyricsCurrentIdx = -1;
  if (nameEl)   nameEl.textContent = track;
  if (artEl)    artEl.textContent  = artist;
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Loading lyrics…'; }
  if (bodyEl)   bodyEl.innerHTML   = '';
  const url = '/api/lyrics?artist=' + encodeURIComponent(artist) +
              '&track=' + encodeURIComponent(track) +
              (album ? '&album=' + encodeURIComponent(album) : '') +
              '&device=' + deviceId;
  fetch(url).then(r => r.json()).then(d => {
    lyricsLoaded = true;
    if (d.synced) {
      const parsed = parseLrc(d.synced);
      lyricsTimes = parsed.map(p => p.time);
      lyricsLines = parsed.map(p => p.text);
    } else if (d.lyrics) {
      lyricsLines = d.lyrics.replace(/\r\n/g, '\n').trim().split('\n');
      lyricsTimes = [];
    } else {
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'No lyrics found'; }
      return;
    }
    if (statusEl) statusEl.style.display = 'none';
    lyricsCurrentIdx = -1;
    if (bodyEl) {
      bodyEl.innerHTML = lyricsLines
        .map((l, i) => `<div class="lyric-line" data-idx="${i}">${l ? esc(l) : '&nbsp;'}</div>`)
        .join('');
    }
    updateLyricsHighlight();
  }).catch(() => {
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Could not load lyrics'; }
  });
}

function updateLyricsHighlight() {
  if (!lyricsLines.length || !lyricsLoaded) return;
  let idx;
  if (lyricsTimes.length) {
    // binary search for last timestamp <= progMs
    let lo = 0, hi = lyricsTimes.length - 1;
    idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyricsTimes[mid] <= progMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
  } else {
    idx = Math.min(lyricsLines.length - 1, Math.floor(progMs / durMs * lyricsLines.length));
  }
  if (idx === lyricsCurrentIdx) return;
  lyricsCurrentIdx = idx;
  const bodyEl = document.getElementById('lyrics-body');
  if (!bodyEl) return;
  const lines = bodyEl.querySelectorAll('.lyric-line');
  lines.forEach((el, i) => {
    el.classList.toggle('lyr-active', i === idx);
    el.classList.toggle('lyr-past',   i < idx);
  });
  const activeEl = lines[idx];
  if (activeEl) {
    const section = document.getElementById('ct-lyrics-section');
    if (section) {
      const offset = activeEl.offsetTop - section.clientHeight / 2 + activeEl.offsetHeight / 2;
      section.scrollTo({ top: offset, behavior: 'smooth' });
    }
  }
}

// ── Live multi-channel streaming ──────────────────────────────────────────────
let liveChannelList = [];  // populated by WS live-list messages
let liveActiveChannel = null; // channelId we are listening to
let liveMse = null;        // { ms: MediaSource, sb: SourceBuffer, audio: HTMLAudioElement }
let liveBroadcasting = false;
let liveRecorder = null;
let liveSpotifyPlayer = null;
let liveWs = null; // reference to main WS (set by liveInit)

function liveInit(ws) {
  liveWs = ws;
  // Fetch initial list
  fetch('/api/live?' + 'device=' + deviceId).then(r => r.json()).then(list => {
    liveChannelList = list;
    if (libTab === 'live') liveRenderSidebar();
  }).catch(() => {});
}

function liveRenderSidebar() {
  const el = document.getElementById('sidebar-list');
  if (!el) return;
  const myChannel = liveChannelList.find(c => c.id === deviceId);
  const broadcastBtn = `<div class="live-broadcast-btn ${liveBroadcasting ? 'live-active' : ''}" onclick="liveToggle()">
    ${liveBroadcasting ? '⏹ Stop Broadcasting' : '🎙 Start Broadcasting'}
  </div>`;
  const channels = liveChannelList.filter(c => c.id !== deviceId);
  const channelHtml = channels.length ? channels.map(c => `
    <div class="live-card ${liveActiveChannel === c.id ? 'live-card-active' : ''}" onclick="liveJoin('${c.id}')">
      ${c.avatarUrl ? `<img class="live-card-av" src="${esc(c.avatarUrl)}" alt="">` : '<div class="live-card-av live-card-av-placeholder">🎵</div>'}
      <div class="live-card-info">
        <div class="live-card-name">${esc(c.name)}</div>
        <div class="live-card-sub">🎧 ${c.listeners} listener${c.listeners !== 1 ? 's' : ''}</div>
      </div>
      ${liveActiveChannel === c.id ? '<div class="live-card-badge">Listening</div>' : ''}
    </div>`).join('') : '<div class="live-empty">No one is broadcasting right now.</div>';
  el.innerHTML = broadcastBtn + channelHtml;
}

// ── Broadcaster ───────────────────────────────────────────────────────────────
function liveToggle() {
  if (liveBroadcasting) liveStop(); else liveStart();
}

function liveStart() {
  if (liveBroadcasting) return;
  liveBroadcasting = true;
  liveRenderSidebar();
  _liveTapAudio();
}

function _liveTapAudio() {
  // Monkey-patch AudioNode.connect to intercept the browser player's graph
  let tapped = false;
  const _origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(target, ...rest) {
    const result = _origConnect.apply(this, [target, ...rest]);
    if (!tapped && target instanceof AudioDestinationNode) {
      tapped = true;
      const msDest = this.context.createMediaStreamDestination();
      _origConnect.call(this, msDest);
      _liveRecord(msDest.stream);
    }
    return result;
  };
  // If the player is already connected, force a reconnect to re-trigger connect calls
  if (browserPlayer) {
    browserPlayer.disconnect();
    setTimeout(() => browserPlayer.connect(), 100);
  } else {
    loadBrowserPlayer();
  }
}

function _liveRecord(stream) {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) { console.error('[live] ws not ready'); liveStop(); return; }
  liveWs.send(JSON.stringify({ type: 'live-start', mimeType }));

  liveRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });
  liveRecorder.ondataavailable = e => {
    if (e.data.size && liveWs?.readyState === WebSocket.OPEN) liveWs.send(e.data);
  };
  liveRecorder.onstop = () => {
    if (liveWs?.readyState === WebSocket.OPEN) liveWs.send(JSON.stringify({ type: 'live-stop' }));
  };
  liveRecorder.start(200); // 200ms chunks
}

function liveStop() {
  liveBroadcasting = false;
  if (liveRecorder) { try { liveRecorder.stop(); } catch (_) {} liveRecorder = null; }
  liveRenderSidebar();
}

// ── Listener ──────────────────────────────────────────────────────────────────
function liveJoin(channelId) {
  if (liveActiveChannel === channelId) { liveLeave(); return; }
  liveLeave();
  const ch = liveChannelList.find(c => c.id === channelId);
  if (!ch) return;
  liveActiveChannel = channelId;
  liveRenderSidebar();

  const audio = new Audio();
  audio.autoplay = true;
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  let sb = null;
  const queue = [];
  let ready = false;

  ms.addEventListener('sourceopen', () => {
    sb = ms.addSourceBuffer(ch.mimeType || 'audio/webm;codecs=opus');
    sb.mode = 'sequence';
    sb.addEventListener('updateend', () => {
      if (queue.length) sb.appendBuffer(queue.shift());
    });
    ready = true;
    // flush anything queued before sourceopen
    if (queue.length && !sb.updating) sb.appendBuffer(queue.shift());
  });

  liveMse = { ms, sb, audio, queue: () => queue, push(buf) {
    if (ready && sb && !sb.updating) sb.appendBuffer(buf);
    else queue.push(buf);
  }};

  if (liveWs?.readyState === WebSocket.OPEN) liveWs.send(JSON.stringify({ type: 'live-join', channelId }));
}

function liveLeave() {
  if (!liveActiveChannel) return;
  if (liveWs?.readyState === WebSocket.OPEN) liveWs.send(JSON.stringify({ type: 'live-leave' }));
  if (liveMse?.audio) { liveMse.audio.pause(); liveMse.audio.src = ''; }
  liveMse = null;
  liveActiveChannel = null;
  liveRenderSidebar();
}

// ── WS handler (called from index.html) ──────────────────────────────────────
window.liveOnMessage = function(msg) {
  if (msg.type === 'live-list') {
    liveChannelList = msg.channels || [];
    if (libTab === 'live') liveRenderSidebar();
  } else if (msg.type === 'live-channel-ended') {
    if (liveActiveChannel === msg.channelId) liveLeave();
    liveChannelList = liveChannelList.filter(c => c.id !== msg.channelId);
    if (libTab === 'live') liveRenderSidebar();
  } else if (msg._binary) {
    if (liveMse) liveMse.push(msg._binary);
  }
};
