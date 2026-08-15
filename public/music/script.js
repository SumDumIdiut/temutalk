let _credsSynced = false;

// Wall-clock anchor for progMs, so the 500ms ticker (below, and in seekTo/
// lyrSeekTo) tracks real elapsed time instead of assuming each tick fired
// exactly on schedule -- setInterval can drift/get throttled (background
// tab, loaded device), and by the time that drift is corrected by the next
// authoritative /api/player poll (every ~3s server-side) it was visible as
// the lyrics highlight running a beat ahead of or behind the actual audio.
let _progAnchorMs = 0, _progAnchorAt = 0;
function _syncProgAnchor(ms) { _progAnchorMs = ms; _progAnchorAt = Date.now(); }

// ── Spotify Web Playback SDK (browser player) ─────────────────────────────────
let browserPlayer = null;
let browserPlayerReady = false;

function _setBrowserPlayerStatus(s) {
  const el = document.getElementById('browser-player-status');
  if (el) {
    el.textContent = s;
    el.style.display = /^ready/.test(s) ? 'none' : '';
  }
  console.log('[player]', s);
}

function loadBrowserPlayer() {
  if (browserPlayer) return;
  console.log('[player] loadBrowserPlayer called, window.Spotify=', !!window.Spotify);
  if (window.Spotify) { _initBrowserPlayer(); return; }

  window.onSpotifyWebPlaybackSDKReady = _initBrowserPlayer;
  _setBrowserPlayerStatus('loading SDK…');

  // Use fetch + blob URL to bypass any script-tag blocking
  fetch(BASE_PATH + '/sp/spotify-player.js')
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
      tag.src = BASE_PATH + '/sp/spotify-player.js';
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

// ── SDK connection resilience ────────────────────────────────────────────
// The Web Playback SDK already retries dropped connections on its own.
// 'not_ready' fires routinely for entirely normal reasons — playback moved
// to another device, the tab got backgrounded and throttled, a brief
// heartbeat blip — none of which mean this device is actually broken.
// Forcing our own reconnect on every one of those (the previous version of
// this code did, plus a 45s polling watchdog) fought the SDK's own recovery
// and periodically interrupted/restarted whatever was currently playing.
//
// Now: nudge with a single reconnect only in response to a real environment
// change (tab woke up, network came back), and only escalate to a full
// teardown+rebuild if the connection has been stuck for a genuinely long
// time (5 minutes) while the user is actually looking at this tab.
let _bpNotReadySince = null;

function _rebuildBrowserPlayer() {
  _setBrowserPlayerStatus('rebuilding player…');
  try { browserPlayer && browserPlayer.disconnect(); } catch (_) {}
  browserPlayer = null;
  browserPlayerReady = false;
  _bpNotReadySince = null;
  _initBrowserPlayer();
}

function _nudgeBrowserPlayer(reason) {
  if (!browserPlayer || browserPlayerReady) return;
  _setBrowserPlayerStatus('reconnecting (' + reason + ')…');
  browserPlayer.connect().catch(() => {});
}

// Wake from sleep / network back → nudge once (not a repeating retry loop)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _nudgeBrowserPlayer('tab visible');
});
window.addEventListener('online', () => _nudgeBrowserPlayer('network back'));

// Last-resort rebuild — low frequency, and only acts after a long, real
// outage while the tab is visible (never while merely backgrounded).
setInterval(() => {
  if (!browserPlayer || browserPlayerReady || !_bpNotReadySince) return;
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - _bpNotReadySince > 5 * 60 * 1000) _rebuildBrowserPlayer();
}, 60000);

window.addEventListener('beforeunload', () => {
  localStorage.setItem('tt_was_paused', playing ? '0' : '1');
});

function _initBrowserPlayer() {
  if (browserPlayer) return;
  _setBrowserPlayerStatus('connecting…');
  const vol = (document.getElementById('fp-vol')?.value ?? 50) / 100;
  browserPlayer = new Spotify.Player({
    name: 'TemuTalk',
    getOAuthToken: cb => {
      // /api/token refreshes server-side when the token is near expiry
      fetch(BASE_PATH + '/api/token?device=' + deviceId).then(r => r.json()).then(d => {
        cb(d.token || d.access_token || '');
      }).catch(e => { console.log('[player] getOAuthToken fetch error:', e); cb(''); });
    },
    volume: vol,
  });
  let _suppressPlay = false;
  browserPlayer.addListener('player_state_changed', state => {
    if (_suppressPlay && state && !state.paused) {
      browserPlayer.pause().catch(() => {});
    }
  });
  browserPlayer.addListener('ready', ({ device_id }) => {
    browserPlayerReady = true;
    _bpNotReadySince = null;
    browserPlayer._deviceId = device_id;
    _setBrowserPlayerStatus('ready: ' + device_id.slice(0,8));
    const wasPaused = localStorage.getItem('tt_was_paused') === '1';
    localStorage.removeItem('tt_was_paused');
    if (wasPaused) _suppressPlay = true;
    api('/api/transfer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id, play: false }) })
      .then(() => {
        if (wasPaused) {
          [200, 600, 1200].forEach(d => setTimeout(() => browserPlayer.pause().catch(() => {}), d));
          setTimeout(() => { _suppressPlay = false; }, 2000);
        }
      })
      .catch(() => {});
  });
  browserPlayer.addListener('not_ready', () => {
    browserPlayerReady = false;
    _bpNotReadySince = _bpNotReadySince || Date.now();
    _nudgeBrowserPlayer('connection lost');
  });
  browserPlayer.addListener('initialization_error', ({ message }) => _setBrowserPlayerStatus('init error: ' + message));
  browserPlayer.addListener('authentication_error', ({ message }) => {
    // token was bad/expired mid-session — reconnect pulls a fresh one via getOAuthToken
    browserPlayerReady = false;
    _bpNotReadySince = _bpNotReadySince || Date.now();
    _nudgeBrowserPlayer('auth: ' + message);
  });
  browserPlayer.addListener('account_error', ({ message }) => _setBrowserPlayerStatus('account error: ' + message));
  browserPlayer.connect().then(ok => {
    console.log('[player] connect() resolved:', ok);
    if (!ok) { _bpNotReadySince = _bpNotReadySince || Date.now(); _nudgeBrowserPlayer('connect failed'); }
  });
  document.addEventListener('click', function _activate() {
    if (browserPlayer) browserPlayer.activateElement();
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
    loadArtAccent(src);
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
    _serverVolume = false;
  }
  shuffled = data.shuffle_state;
  document.getElementById('fp-shuffle')?.classList.toggle('lit', shuffled);
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

// A crossOrigin="anonymous" <img> that the album-art CDN doesn't answer with
// CORS headers for refuses to render at all (not just refuses the canvas
// read) -- that was previously set directly on the visible #fp-art element,
// so any track whose art came back without those headers just failed to
// show art entirely. Loading a separate, invisible copy for the accent-color
// read (same technique as tintMusicCard) means the visible image is never
// subject to that restriction -- worst case here is just no accent color.
function loadArtAccent(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => onArtLoad(img);
  img.src = src;
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
  const npLyrFill  = document.getElementById('np-lyrics-progress-fill');
  const homeLyrFill = document.getElementById('home-lyr-progress-fill');
  if (npLyrFill)   npLyrFill.style.width   = pct;
  if (homeLyrFill) homeLyrFill.style.width = pct;
  _renderOpenLyrViews();
}
function setPlayIcons(on) {
  const p = on ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  document.getElementById('fp-play-icon').innerHTML = p;
  document.getElementById('home-play-icon').innerHTML = p;
  const npLyrIcon = document.getElementById('np-lyr-play-icon');     if (npLyrIcon)  npLyrIcon.innerHTML  = p;
  const homeLyrIcon = document.getElementById('home-lyr-play-icon'); if (homeLyrIcon) homeLyrIcon.innerHTML = p;
}
function renderRepeat() {
  document.getElementById('fp-repeat')?.classList.toggle('lit', repeatState !== 'off');
  const icon = document.getElementById('fp-repeat-icon');
  if (icon) icon.innerHTML = repeatState === 'track'
    ? '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/>'
    : '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
}

// ── Autoplay: when whatever's playing finishes naturally and nothing is
// queued after it, fetch and play something similar instead of leaving
// silence. Always on -- there's no user-facing toggle for it. There's no
// track-end event to hook into (Spotify Connect state only reaches this app
// via the server's ~3s player-state poll), so this is detected by comparing
// each poll against the last one: playing, near the end of the track, then
// on a later poll stopped with progress back near zero on the same track --
// Spotify's own behavior when a track completes with an empty queue.
// Auto-advancing into an already-queued next track (a playlist/album
// context, or repeat) never sets is_playing:false in between, so this
// deliberately never fires for those cases. ───────────────────────────────
let _apLastTrackId = null, _apLastProgress = 0, _apLastDuration = 1, _apLastPlaying = false, _apFiring = false;

function _checkAutoplay(data) {
  if (_apFiring) { _apRecordPoll(data); return; }
  const wasNearEnd = _apLastPlaying && _apLastTrackId && _apLastProgress >= _apLastDuration - 2500;
  const stoppedNow = !data.is_playing
    && (!data.item || data.item.id === _apLastTrackId)
    && (data.progress_ms || 0) < 2000;
  console.log('[autoplay] poll:', { lastTrack: _apLastTrackId, lastPlaying: _apLastPlaying, lastProgress: _apLastProgress, lastDuration: _apLastDuration, wasNearEnd, stoppedNow, incomingPlaying: data.is_playing, incomingItem: data.item?.id, incomingProgress: data.progress_ms });
  if (wasNearEnd && stoppedNow) {
    console.log('[autoplay] FIRING -- fetching a similar track to', _apLastTrackId);
    _apFiring = true;
    const seedTrackId  = _apLastTrackId;
    const seedArtistId = lastArtistIds ? lastArtistIds.split(',')[0] : '';
    let url = '/api/similar-tracks?seedTrackId=' + encodeURIComponent(seedTrackId) + '&limit=1&exclude=' + encodeURIComponent(seedTrackId);
    if (seedArtistId) url += '&seedArtistId=' + encodeURIComponent(seedArtistId);
    api(url).then(res => {
      console.log('[autoplay] similar-tracks response:', res);
      const t = res.tracks && res.tracks[0];
      if (t && t.uri) { console.log('[autoplay] playing', t.name, t.uri); playUris([t.uri]); }
      else console.log('[autoplay] no similar track returned -- staying silent');
    }).catch(e => console.log('[autoplay] similar-tracks fetch failed:', e)).finally(() => { _apFiring = false; });
  }
  _apRecordPoll(data);
}
function _apRecordPoll(data) {
  if (data.item) { _apLastTrackId = data.item.id; _apLastDuration = data.item.duration_ms || 1; }
  _apLastProgress = data.progress_ms || 0;
  _apLastPlaying  = !!data.is_playing;
}
// ── Output device icons ─────────────────────────────────────────────────────
// Still used by the global device-picker modal (openDevicePickerModal(),
// below) even though the Music tab's own corner "Play on…" picker that
// used to share this was removed.
const SP_DEVICE_ICONS = {
  computer:  '<path d="M4 4h16v11H4zM2 19h20v2H2zm7-2h6v2H9z"/>',
  smartphone:'<path d="M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm5 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>',
  speaker:   '<path d="M12 2a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3zm0 9a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5zm0 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  tv:        '<path d="M4 4h16v11H4zm4 13h8v2H8z"/>',
};

// Shuffle / Magic Shuffle picker (playlist detail view) — same toggle +
// outside-click-closes pattern as the device picker above.
function toggleShuffleMenu(e) {
  e?.stopPropagation();
  document.getElementById('vpl-shuf-pop')?.classList.toggle('open');
}
function closeShuffleMenu() {
  document.getElementById('vpl-shuf-pop')?.classList.remove('open');
}
document.addEventListener('click', e => {
  const pop = document.getElementById('vpl-shuf-pop');
  if (pop?.classList.contains('open') && !pop.contains(e.target) && !document.getElementById('vpl-shuf-btn')?.contains(e.target))
    pop.classList.remove('open');
});

const SHUFFLE_ICON_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>';
const MAGIC_ICON_SVG    = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/></svg>';

// Picking Magic Shuffle only arms it -- the hero's actual Play button (not
// this menu) is what starts playback, same as picking a device doesn't
// play anything on its own either. Set here, read by playHeroContext()
// below, cleared by resetShuffleButton() whenever a different
// playlist/artist/album is opened so it can't leak across views.
let magicShuffleArmedFor = null;

// Picking either option closes the menu and swaps the trigger button's own
// icon to match what was picked (shuffle arrows vs. sparkle), turning it
// solid white -- same "engaged" look playContext's play button already has
// -- instead of leaving it as a plain unlabeled shuffle icon regardless of
// which mode is actually running.
function chooseShuffleMode(mode, contextUri) {
  closeShuffleMenu();
  const btn = document.getElementById('vpl-shuf-btn');
  if (mode === 'magic') {
    magicShuffleArmedFor = contextUri;
    if (btn) { btn.classList.add('engaged'); btn.innerHTML = MAGIC_ICON_SVG; }
  } else {
    // shuffleContext toggles the shared `shuffled` state itself, so the
    // button reflects whatever it actually ended up as (on or off), not
    // just "was just clicked". Native shuffle plays immediately (unlike
    // magic, above) -- it's a cheap, instant toggle, not a multi-second
    // fetch-then-play sequence, so there's nothing to defer to a Play press.
    magicShuffleArmedFor = null;
    shuffleContext(contextUri);
    if (btn) { btn.innerHTML = SHUFFLE_ICON_SVG; btn.classList.toggle('engaged', shuffled); }
  }
}
function resetShuffleButton() {
  magicShuffleArmedFor = null;
  const btn = document.getElementById('vpl-shuf-btn');
  if (btn) { btn.classList.remove('engaged'); btn.innerHTML = SHUFFLE_ICON_SVG; }
}

// The playlist hero's actual Play button -- routes to Magic Shuffle instead
// of a normal context play when it's armed for this exact playlist.
function playHeroContext(uri) {
  if (magicShuffleArmedFor === uri) { playMagicShuffle(uri); return; }
  playContext(uri);
}

// Callers that pass a specific reason (e.g. "Playlist has no playable
// tracks") keep the alert -- a device picker wouldn't fix that. The bare
// "we couldn't find/activate any device at all" case (no e.error, from
// _useOwnDevice()'s own timeout) opens the picker instead, since that one
// genuinely is solvable by picking a different device -- e.g. the real
// Spotify app the user already has open, per the modal below.
function _playErr(e) {
  if (e?.error) { alert(e.error); return; }
  openDevicePickerModal();
}

// Global "pick a device" modal (any tab, see index.html) -- shown from
// _playErr() above when this device's own in-browser Web Playback SDK
// session (needs EME/DRM support) doesn't come up in time.
function openDevicePickerModal() {
  document.getElementById('device-picker-modal')?.classList.add('open');
  loadDevicePickerModalList();
}
function closeDevicePickerModal() {
  document.getElementById('device-picker-modal')?.classList.remove('open');
}
function loadDevicePickerModalList() {
  const list = document.getElementById('dpm-list');
  if (!list) return;
  list.innerHTML = '<div class="dpm-loading">Loading…</div>';
  api('/api/devices').then(d => {
    const devices = d?.devices || [];
    if (!devices.length) { list.innerHTML = '<div class="dpm-loading">No Spotify devices found — open Spotify on this device or another one, then try again</div>'; return; }
    list.innerHTML = devices.map(dev => {
      const icon = SP_DEVICE_ICONS[dev.type?.toLowerCase()] || SP_DEVICE_ICONS.speaker;
      return `<div class="dpm-row${dev.is_active ? ' active' : ''}" data-id="${esc(dev.id)}" onclick="devicePickerModalSetDevice(this.dataset.id)">
        <svg class="dpm-row-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${icon}</svg>
        <div class="dpm-row-info"><div class="dpm-row-name">${esc(dev.name)}</div><div class="dpm-row-sub">${dev.volume_percent != null ? dev.volume_percent + '% volume' : dev.type || ''}</div></div>
        ${dev.is_active ? '<span class="dpm-row-check"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>' : ''}
      </div>`;
    }).join('');
  }).catch(() => { list.innerHTML = '<div class="dpm-loading">Could not load devices</div>'; });
}
function devicePickerModalSetDevice(id) {
  const list = document.getElementById('dpm-list');
  if (list) list.innerHTML = '<div class="dpm-loading">Switching…</div>';
  api('/api/transfer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: id, play: true }) })
    .then(() => closeDevicePickerModal())
    .catch(() => loadDevicePickerModalList());
}
function _sendPlay(body) {
  // Same reasoning as action('play'): if nothing's been active this session,
  // skip straight to this device's own player instead of waiting on the
  // server's arbitrary-device fallback (which can take 10s+).
  if (!hasTrack) { _useOwnDevice(devId => _playOnDevice(devId, body)); return; }
  api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(r => { if (r.error) _useOwnDevice(devId => _playOnDevice(devId, body)); }).catch(() => _useOwnDevice(devId => _playOnDevice(devId, body)));
}
function _playOnDevice(deviceIdSp, body) {
  api('/api/transfer', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: deviceIdSp, play: false }) })
    .then(() => api('/api/play-context', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }))
    .then(r => { if (r.error) _playErr(r); });
}
function playContext(uri, offset) {
  const body = {};
  if (uri) body.context_uri = uri;
  if (offset != null) body.offset = { position: offset };
  _sendPlay(body);
}
function playUris(uris) {
  _sendPlay({ uris });
}
// True toggle (not "only ever turn on") -- the bottom bar's own shuffle
// button (which used to be the only way to turn shuffle back off) is gone,
// so picking "Shuffle" again from the playlist dropdown while it's already
// on needs to actually turn it off, same as the removed button did.
function shuffleContext(uri) {
  shuffled = !shuffled;
  document.getElementById('fp-shuffle')?.classList.toggle('lit', shuffled);
  api('/api/player/shuffle', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: shuffled }) });
  playContext(uri);
}

// Magic shuffle: the playlist's own tracks (shuffled) with similar tracks
// woven in every third slot, played as an explicit uris list -- Spotify's
// own context_uri playback can't do this since a context hands the whole
// track sequence to Spotify's servers, and there's no way to tell Spotify
// "play these plus some of your own recommendations mixed in."
function playMagicShuffle(contextUri) {
  const playlistId = contextUri.split(':').pop();
  const btn = document.getElementById('vpl-shuf-btn');
  if (btn) btn.classList.add('lit');
  const stopLoading = () => { if (btn) btn.classList.remove('lit'); };

  api('/api/playlist/' + playlistId + '/tracks').then(data => {
    const ownTracks = (data.items || []).map(i => i.track).filter(t => t && t.uri);
    if (!ownTracks.length) { _playErr({ error: 'Playlist has no playable tracks' }); stopLoading(); return; }

    const shuffledOwn = ownTracks.slice();
    for (let i = shuffledOwn.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledOwn[i], shuffledOwn[j]] = [shuffledOwn[j], shuffledOwn[i]];
    }

    // Seed from a spread of tracks across the shuffled order (not just the
    // first one) so the recommendations pull from more than one corner of
    // the playlist's taste, roughly one seed per ~5 tracks.
    const seedCount   = Math.max(1, Math.min(5, Math.ceil(shuffledOwn.length / 5)));
    const seeds       = Array.from({ length: seedCount }, (_, i) => shuffledOwn[Math.floor(i * shuffledOwn.length / seedCount)]);
    const excludeIds  = ownTracks.map(t => t.id).join(',');
    const perSeedLimit = Math.max(1, Math.ceil(shuffledOwn.length / 2 / seedCount));

    Promise.all(seeds.map(t => {
      let url = '/api/similar-tracks?seedTrackId=' + encodeURIComponent(t.id) + '&limit=' + perSeedLimit + '&exclude=' + encodeURIComponent(excludeIds);
      if (t.artists?.[0]?.id) url += '&seedArtistId=' + encodeURIComponent(t.artists[0].id);
      return api(url).then(r => r.tracks || []).catch(() => []);
    })).then(groups => {
      const seen = new Set();
      const similar = groups.flat().filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

      const mixed = [];
      let ri = 0, si = 0;
      while (ri < shuffledOwn.length) {
        mixed.push(shuffledOwn[ri++]);
        if (ri % 2 === 0 && si < similar.length) mixed.push(similar[si++]);
      }
      while (si < similar.length) mixed.push(similar[si++]);

      const uris = mixed.map(t => t.uri).filter(Boolean);
      if (!uris.length) { _playErr({ error: 'Nothing playable found' }); return; }
      // The uris array is already shuffled and mixed with similar tracks --
      // Spotify's own native shuffle would re-shuffle this explicit queue on
      // top of that, undoing the deliberate interleaving. Turn it off.
      if (shuffled) { shuffled = false; document.getElementById('fp-shuffle')?.classList.remove('lit'); api('/api/player/shuffle', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state: false }) }); }
      playUris(uris);
    }).finally(stopLoading);
  }).catch(() => { _playErr({ error: 'Failed to load playlist' }); stopLoading(); });
}

// ── Remove a track from a playlist (playlist detail view) ─────────────────
function removeFromPlaylist(btnEl, playlistId, uri) {
  const row = btnEl.closest('.det-track');
  if (!row) return;
  btnEl.disabled = true;
  api('/api/playlist/' + playlistId + '/tracks', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }),
  }).then(r => {
    if (r.error) { btnEl.disabled = false; alert(r.error); return; }
    row.remove();
    const remaining = document.querySelectorAll('#vpl-tracks .det-track').length;
    document.querySelectorAll('#vpl-tracks .det-track-num').forEach((el, i) => { el.textContent = (i + 1); });
    const sub = document.getElementById('vpl-sub');
    if (sub) sub.textContent = sub.textContent.replace(/\d+ songs?/, remaining + (remaining === 1 ? ' song' : ' songs'));
  }).catch(() => { btnEl.disabled = false; alert('Could not remove track — check your connection.'); });
}

// ── Add the currently playing track to a playlist (player bar) ────────────
// Full centered modal — a small corner popover made "pick a playlist" too
// easy to miss/mis-tap on a touch-first hub.
let _addToPlaylistList = null;

function openAddToPlaylistModal() {
  if (!currentTrackId) { alert('Nothing is playing.'); return; }
  const modal = document.getElementById('add-playlist-modal');
  const list  = document.getElementById('apm-list');
  const sub   = document.getElementById('apm-track-sub');
  if (!modal || !list) return;
  const track  = document.getElementById('fp-track')?.textContent || '';
  const artist = document.getElementById('fp-artist')?.textContent || '';
  if (sub) sub.textContent = artist ? track + ' — ' + artist : track;
  modal.classList.add('open');
  list.innerHTML = '<div class="apm-empty">Loading playlists…</div>';
  (_addToPlaylistList ? Promise.resolve(_addToPlaylistList) : api('/api/playlists').then(d => _addToPlaylistList = d.items || []))
    .then(items => {
      if (!items.length) { list.innerHTML = '<div class="apm-empty">No playlists found.</div>'; return; }
      list.innerHTML = items.map(p => {
        const img = p.images?.at(-1)?.url || p.images?.[0]?.url || '';
        return '<button class="add-playlist-item" data-playlist="' + esc(p.id) + '" onclick="addCurrentTrackToPlaylist(this,this.dataset.playlist)">' +
          (img ? '<img class="apm-item-art" src="' + esc(img) + '" alt="">' : '<div class="apm-item-art"></div>') +
          '<div class="apm-item-info"><div class="apm-item-name">' + esc(p.name) + '</div>' +
          '<div class="apm-item-sub">' + (p.tracks?.total ?? 0) + ' songs</div></div>' +
          '<svg class="apm-item-check" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' +
          '</button>';
      }).join('');
    }).catch(() => { list.innerHTML = '<div class="apm-empty">Could not load playlists.</div>'; });
}

function closeAddToPlaylistModal() {
  document.getElementById('add-playlist-modal')?.classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAddToPlaylistModal();
});

function addCurrentTrackToPlaylist(btnEl, playlistId) {
  if (!currentTrackId) return;
  const uri = 'spotify:track:' + currentTrackId;
  btnEl.disabled = true;
  api('/api/playlist/' + playlistId + '/tracks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }),
  }).then(r => {
    if (r.error) { btnEl.disabled = false; alert(r.error); return; }
    btnEl.classList.add('apm-added');
    const sub = btnEl.querySelector('.apm-item-sub');
    if (sub) sub.textContent = 'Added';
    setTimeout(closeAddToPlaylistModal, 650);
  }).catch(() => { btnEl.disabled = false; alert('Could not add track — check your connection.'); });
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
  resetShuffleButton();
  openDetail('view-playlist');
  Promise.all([api('/api/playlist/' + id), api('/api/playlist/' + id + '/tracks')]).then(([info, data]) => {
    document.getElementById('vpl-name').textContent = info.name || '';
    if (info.images?.[0]?.url) document.getElementById('vpl-art').src = info.images[0].url;
    // Keep each item's ORIGINAL index — Spotify's offset.position refers to
    // position in the real (unfiltered) playlist, so numbering from the
    // filtered array here would send the wrong offset and play a different
    // track than the one clicked whenever an earlier row is filtered out
    // (removed/unavailable tracks show up as null entries).
    const items = (data.items || [])
      .map((item, originalIdx) => ({ item, originalIdx }))
      .filter(x => x.item?.track);
    document.getElementById('vpl-sub').textContent = (info.owner ? ownerLabel(info) + ' · ' : '') + items.length + ' songs';
    document.getElementById('vpl-tracks').innerHTML = items.map(({ item, originalIdx }, displayIdx) => {
      const t = item.track;
      return '<div class="det-track" data-uri="' + vplUri + '" data-off="' + originalIdx + '" onclick="playContext(this.dataset.uri,+this.dataset.off)">' +
        '<span class="det-track-num">' + (displayIdx+1) + '</span>' +
        '<img class="det-track-art" src="' + (t.album?.images?.at(-1)?.url || '') + '" alt="" loading="lazy">' +
        '<div class="det-track-info"><div class="det-track-name">' + esc(t.name) + '</div><div class="det-track-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div>' +
        '<span class="det-track-dur">' + fmt(t.duration_ms) + '</span>' +
        '<button class="det-track-remove" data-playlist="' + esc(id) + '" data-uri="' + esc(t.uri) + '" title="Remove from playlist" onclick="event.stopPropagation();removeFromPlaylist(this,this.dataset.playlist,this.dataset.uri)">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 7h12l-1 13.02A2 2 0 0 1 15.01 22H8.99a2 2 0 0 1-1.99-1.98L6 7zm3-4h6l1 2h4v2H4V5h4l1-2z"/></svg>' +
        '</button></div>';
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

// ── Stats tab ─────────────────────────────────────────────────────────────
let statsLoaded = false, statsRange = 'medium_term';
function setStatsRange(range) {
  statsRange = range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  const artists = document.getElementById('stats-artists');
  if (artists) artists.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Loading…</div>';
  const tracks = document.getElementById('stats-tracks');
  if (tracks) tracks.innerHTML  = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Loading…</div>';
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


// -- Lyrics (home widget karaoke view + music tab full view) ------------
let homeLyrOpen = false, tabLyrOpen = false, lyrLoadedFor = '';
let lyrLines = [], lyrTimes = [], homeLyrCurrentIdx = -1, tabLyrCurrentIdx = -1;

function parseLrc(lrc) {
  // returns [{time: ms, text: string}]
  const out = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
    if (m) out.push({ time: (parseInt(m[1]) * 60 + parseFloat(m[2])) * 1000, text: m[3].trim() });
  }
  return out;
}

const LYR_GAP_MS   = 8000; // gap between two lines long enough to count as instrumental
const LYR_SUNG_MS  = 4000; // rough time to finish a line before showing the note
const LYR_NOTE_SVG = '<svg class="lyr-note-svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

// Splices a music-note "line" into an intro before the first lyric and into
// any gap between two lines wide enough to be an instrumental break, so the
// karaoke view does not just sit on a stale line while nothing is being sung.
function _addInstrumentalGaps(times, lines) {
  if (!times.length) return { times, lines };
  const outTimes = [], outLines = [];
  if (times[0] > LYR_GAP_MS) { outTimes.push(0); outLines.push({ text: '', note: true }); }
  for (let i = 0; i < times.length; i++) {
    outTimes.push(times[i]);
    outLines.push({ text: lines[i], note: false });
    const nextTime = i + 1 < times.length ? times[i + 1] : (durMs || Infinity);
    if (nextTime - times[i] > LYR_GAP_MS) { outTimes.push(times[i] + LYR_SUNG_MS); outLines.push({ text: '', note: true }); }
  }
  return { times: outTimes, lines: outLines };
}

function _lyrLineHtml(line, cls, ms) {
  const clickAttr = ms != null ? ' onclick="lyrSeekTo(' + ms + ')"' : '';
  return line.note ? '<div class="' + cls + ' lyr-note"' + clickAttr + '>' + LYR_NOTE_SVG + '</div>'
                    : '<div class="' + cls + '"' + clickAttr + '>' + esc(line.text || ' ') + '</div>';
}

function _lyrIndexFor(ms) {
  if (lyrTimes.length) {
    let lo = 0, hi = lyrTimes.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrTimes[mid] <= ms) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  }
  return Math.min(lyrLines.length - 1, Math.floor(ms / durMs * lyrLines.length));
}

function toggleHomeLyrics() {
  const view = document.getElementById('home-lyr-overlay');
  if (!view) return;
  homeLyrOpen = !homeLyrOpen;
  view.style.display = homeLyrOpen ? 'flex' : 'none';
  if (homeLyrOpen) { homeLyrCurrentIdx = -1; loadLyrics(); }
}

function toggleTabLyrics() {
  const view = document.getElementById('np-lyrics-section');
  const btn  = document.getElementById('np-lyrics-btn');
  if (!view) return;
  tabLyrOpen = !tabLyrOpen;
  view.style.display = tabLyrOpen ? 'flex' : 'none';
  btn?.classList.toggle('lit', tabLyrOpen);
  if (tabLyrOpen) { tabLyrCurrentIdx = -1; loadLyrics(); }
}

// Keeps the lyrics overlay's own header (art/title/artist/blurred bg) in
// sync with the now-playing state -- called at the top of loadLyrics() so
// both "just opened" and "track changed while open" stay covered by one path.
function _syncLyrHeader() {
  const track  = document.getElementById('home-np-track')?.textContent  || '--';
  const artist = document.getElementById('home-np-artist')?.textContent || '';
  const art    = document.getElementById('fp-art')?.getAttribute('src') || '';
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const setSrc = (id, val) => { const el = document.getElementById(id); if (el) el.src = val; };
  set('np-lyrics-title', track);   set('np-lyrics-artist', artist);
  setSrc('np-lyrics-bg', art);     setSrc('np-lyrics-art', art);
  set('home-lyr-hdr-title', track); set('home-lyr-hdr-artist', artist);
  setSrc('home-lyr-bg', art);       setSrc('home-lyr-hdr-art', art);
}

// Lets a synced lyric line be clicked to jump playback there, same seek
// backends the progress bar itself uses (seekTo(), duplicated here since
// that one derives its ms from a click on #fp-bar's own rect).
function lyrSeekTo(ms) {
  progMs = Math.max(0, Math.min(durMs, ms));
  _syncProgAnchor(progMs);
  renderProg();
  if (activeService === 'youtube' && ytPlayer && ytPlayerReady) { ytPlayer.seekTo(progMs / 1000, true); return; }
  if (activeService === 'apple' && appleMusic) { appleMusic.seekToTime(progMs / 1000).catch(() => {}); return; }
  _spotifySeek(progMs);
}

function _setLyrStatus(msg) {
  const homeTrackEl = document.getElementById('home-lyr-track');
  if (homeTrackEl) homeTrackEl.innerHTML = '<div class="np-lyr-status">' + esc(msg) + '</div>';
  const tabBodyEl = document.getElementById('np-lyrics-body');
  if (tabBodyEl) tabBodyEl.innerHTML = '<div class="np-lyr-status">' + esc(msg) + '</div>';
}

function _buildHomeLyrTrack() {
  const trackEl = document.getElementById('home-lyr-track');
  if (trackEl) trackEl.innerHTML = lyrLines.map((l, i) => _lyrLineHtml(l, 'home-lyr-ln', lyrTimes[i])).join('');
}
function _buildTabLyrList() {
  const bodyEl = document.getElementById('np-lyrics-body');
  if (bodyEl) bodyEl.innerHTML = lyrLines.map((l, i) => _lyrLineHtml(l, 'np-lyr-line', lyrTimes[i])).join('');
}

function loadLyrics() {
  _syncLyrHeader();
  const track  = document.getElementById('home-np-track')?.textContent.trim()  || '';
  const artist = document.getElementById('home-np-artist')?.textContent.trim() || '';
  const album  = document.getElementById('home-np-album')?.textContent.trim()  || '';
  if (!track || track === String.fromCharCode(8212)) { _setLyrStatus('Nothing playing'); return; }
  const key = track + '::' + artist;
  if (key === lyrLoadedFor) { _buildHomeLyrTrack(); _buildTabLyrList(); _renderOpenLyrViews(); return; }
  lyrLoadedFor = key;
  lyrLines = []; lyrTimes = [];
  _setLyrStatus('Loading lyrics...');
  const url = BASE_PATH + '/api/lyrics?artist=' + encodeURIComponent(artist) +
              '&track=' + encodeURIComponent(track) +
              (album ? '&album=' + encodeURIComponent(album) : '');
  fetch(url).then(r => r.json()).then(d => {
    if (key !== lyrLoadedFor) return; // track changed again while this was in flight
    if (d.synced) {
      const parsed = parseLrc(d.synced);
      const gapped = _addInstrumentalGaps(parsed.map(p => p.time), parsed.map(p => p.text));
      lyrTimes = gapped.times;
      lyrLines = gapped.lines;
    } else if (d.lyrics) {
      lyrLines = d.lyrics.replace(/\r\n/g, '\n').trim().split('\n').map(t => ({ text: t, note: false }));
      lyrTimes = [];
    } else {
      _setLyrStatus('No lyrics found');
      return;
    }
    homeLyrCurrentIdx = -1; tabLyrCurrentIdx = -1;
    _buildHomeLyrTrack();
    _buildTabLyrList();
    _renderOpenLyrViews();
  }).catch(() => { if (key === lyrLoadedFor) _setLyrStatus('Could not load lyrics'); });
}

function _renderOpenLyrViews() {
  if (homeLyrOpen) renderHomeLyrics();
  if (tabLyrOpen) renderTabLyrics();
}

function renderHomeLyrics() {
  if (!homeLyrOpen || !lyrLines.length) return;
  const idx = _lyrIndexFor(progMs);
  if (idx === homeLyrCurrentIdx) return;
  homeLyrCurrentIdx = idx;
  const trackEl = document.getElementById('home-lyr-track');
  if (!trackEl) return;
  const els = trackEl.querySelectorAll('.home-lyr-ln');
  els.forEach((el, i) => { el.classList.toggle('active', i === idx); el.classList.toggle('past', i < idx); });
  const activeEl = els[idx];
  if (activeEl) {
    const offset = activeEl.offsetTop - trackEl.clientHeight / 2 + activeEl.offsetHeight / 2;
    trackEl.scrollTo({ top: offset, behavior: 'smooth' });
  }
}

function renderTabLyrics() {
  if (!tabLyrOpen || !lyrLines.length) return;
  const idx = _lyrIndexFor(progMs);
  if (idx === tabLyrCurrentIdx) return;
  tabLyrCurrentIdx = idx;
  const bodyEl = document.getElementById('np-lyrics-body');
  if (!bodyEl) return;
  const els = bodyEl.querySelectorAll('.np-lyr-line');
  els.forEach((el, i) => { el.classList.toggle('active', i === idx); el.classList.toggle('past', i < idx); });
  const activeEl = els[idx];
  if (activeEl) {
    const offset = activeEl.offsetTop - bodyEl.clientHeight / 2 + activeEl.offsetHeight / 2;
    bodyEl.scrollTo({ top: offset, behavior: 'smooth' });
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
  fetch(BASE_PATH + '/api/live?' + 'device=' + deviceId).then(r => r.json()).then(list => {
    liveChannelList = list;
    if (libTab === 'live') liveRenderSidebar();
  }).catch(() => {});
}

function liveRenderSidebar() {
  const el = document.getElementById('sidebar-list');
  if (!el) return;
  const myChannel = liveChannelList.find(c => c.id === deviceId);
  const broadcastBtn = `<div class="live-broadcast-btn ${liveBroadcasting ? 'live-active' : ''}" onclick="liveToggle()">
    ${liveBroadcasting
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg> Stop Broadcasting'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg> Start Broadcasting'}
  </div>`;
  const channels = liveChannelList.filter(c => c.id !== deviceId);
  const channelHtml = channels.length ? channels.map(c => `
    <div class="live-card ${liveActiveChannel === c.id ? 'live-card-active' : ''}" onclick="liveJoin('${c.id}')">
      ${c.avatarUrl ? `<img class="live-card-av" src="${esc(c.avatarUrl)}" alt="">` : '<div class="live-card-av live-card-av-placeholder">' + LYR_NOTE_SVG + '</div>'}
      <div class="live-card-info">
        <div class="live-card-name">${esc(c.name)}</div>
        <div class="live-card-sub"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M12 3a8 8 0 00-8 8v6a2 2 0 002 2h1a1 1 0 001-1v-5a1 1 0 00-1-1H5v-1a7 7 0 0114 0v1h-2a1 1 0 00-1 1v5a1 1 0 001 1h1a2 2 0 002-2v-6a8 8 0 00-8-8z"/></svg> ${c.listeners} listener${c.listeners !== 1 ? 's' : ''}</div>
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

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-SERVICE MUSIC (YouTube Music + Apple Music)
// ═══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let activeService = localStorage.getItem('musicService') || 'spotify';

// YouTube
let ytPlayer = null, ytPlayerReady = false;
let ytQueue = [], ytQueueIdx = 0;
let ytTicker = null;

// Apple Music
let appleMusic = null;
let appleTicker = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function _showAuthPanels() {
  ['spotify', 'youtube', 'apple'].forEach(s => {
    const el = document.getElementById('auth-' + s + '-wrap');
    if (el) el.style.display = s === activeService ? '' : 'none';
  });
}

function _updateSvcBtns() {
  document.querySelectorAll('.msvc-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.svc === activeService)
  );
}

function _updateNowPlaying(title, artist, album, artUrl) {
  document.getElementById('fp-track').textContent  = title;
  document.getElementById('fp-artist').textContent = artist;
  document.getElementById('fp-ctx').textContent    = album;
  document.getElementById('np-track').textContent  = title;
  document.getElementById('np-artist').textContent = artist;
  if (artUrl) {
    document.getElementById('fp-art').src  = artUrl;
    document.getElementById('bar-art').src = artUrl;
    tintMusicCard(artUrl);
    loadArtAccent(artUrl);
  }
  const npEmpty   = document.getElementById('np-empty');
  const npDetails = document.getElementById('np-details');
  const npDivider = document.getElementById('np-divider');
  if (npEmpty)   npEmpty.style.display = 'none';
  if (npDetails) npDetails.classList.remove('np-empty');
  if (npDivider) npDivider.style.display = '';
  document.getElementById('np-artist-section').innerHTML = '';
  document.getElementById('home-np-track').textContent  = title;
  document.getElementById('home-np-artist').textContent = artist;
  document.getElementById('home-np-album').textContent  = album;
  if (artUrl) document.getElementById('home-np-art').src = artUrl;
  const npPlaying = document.getElementById('home-np-playing');
  const npRecent  = document.getElementById('home-np-recent');
  const musicLbl  = document.getElementById('home-music-label');
  if (npPlaying) npPlaying.style.display = 'block';
  if (npRecent)  npRecent.style.display  = 'none';
  if (musicLbl)  { musicLbl.textContent = 'Now Playing'; musicLbl.style.color = ''; }
}

// ── Override showAuth ─────────────────────────────────────────────────────────
function showAuth() {
  _showAuthPanels();
  const bar = document.getElementById('music-svc-bar');
  if (bar) bar.style.display = '';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('music-app').classList.remove('ma-show');
}

// ── Override showApp ──────────────────────────────────────────────────────────
function showApp() {
  const bar = document.getElementById('music-svc-bar');
  if (bar) bar.style.display = 'none';
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('music-app').classList.add('ma-show');
  if (activeService === 'spotify' && !_credsSynced) {
    _credsSynced = true;
    const { cid, csec } = getSpotifyCreds();
    if (cid && csec) {
      api('/api/save-creds', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: cid, clientSecret: csec }) }).catch(() => {});
    }
    loadBrowserPlayer();
  }
}

// ── Override loadMusicHome ────────────────────────────────────────────────────
function loadMusicHome() {
  _updateSvcBtns();
  _showAuthPanels();
  if (activeService === 'youtube') { _ytCheck(); return; }
  if (activeService === 'apple')   { _appleCheck(); return; }
  // Spotify
  if (musicHomeLoaded) return; musicHomeLoaded = true;
  loadMe().then(() => setLibTab('playlists'));
  if (!discoverLoaded) { discoverLoaded = true; loadStats('medium_term'); loadNewReleases(); }
}

// ── Service switcher ──────────────────────────────────────────────────────────
function musicSwitchSvc(svc) {
  activeService = svc;
  localStorage.setItem('musicService', svc);
  _updateSvcBtns();
  libSidebarCache = {};
  _showAuthPanels();
  if (svc === 'spotify')  _spotifyCheck();
  else if (svc === 'youtube') _ytCheck();
  else if (svc === 'apple')   _appleCheck();
}

function _spotifyCheck() {
  fetch(BASE_PATH + '/api/status?device=' + deviceId).then(r => r.json()).then(d => {
    if (d.authenticated) {
      showApp();
      loadMe().then(() => setLibTab(libTab || 'playlists'));
      if (!discoverLoaded) { discoverLoaded = true; loadStats('medium_term'); loadNewReleases(); }
    } else { showAuth(); }
  }).catch(() => showAuth());
}

function _ytCheck() {
  fetch(BASE_PATH + '/api/yt/status?device=' + deviceId).then(r => r.json()).then(d => {
    if (d.authenticated) { showApp(); ytLoadPlayer(); _ytSetLibTab(libTab || 'playlists'); }
    else { showAuth(); }
  }).catch(() => showAuth());
}

function _appleCheck() {
  fetch(BASE_PATH + '/api/apple/status').then(r => r.json()).then(d => {
    if (d.configured) { showApp(); appleLoadKit(); _appleSetLibTab(libTab || 'playlists'); }
    else { showAuth(); }
  }).catch(() => showAuth());
}

// ── Override onPlayer (only update UI when on Spotify) ────────────────────────
function onPlayer(data) {
  if (activeService !== 'spotify') return;
  if (!data.authenticated) { showAuth(); return; }
  showApp();
  _checkAutoplay(data);
  if (!data.item) return;

  const name    = data.item.name;
  const artists = data.item.artists.map(a => a.name).join(', ');
  const album   = data.item.album?.name || '';
  const images  = data.item.album?.images || [];
  const src     = (images[1] || images[0])?.url || '';

  document.getElementById('fp-track').textContent  = name;
  document.getElementById('fp-artist').textContent = artists;
  document.getElementById('fp-ctx').textContent    = album;
  document.getElementById('np-track').textContent  = name;
  document.getElementById('np-artist').textContent = artists;
  const npEmpty   = document.getElementById('np-empty');
  const npDetails = document.getElementById('np-details');
  const npDivider = document.getElementById('np-divider');
  if (npEmpty)   npEmpty.style.display = 'none';
  if (npDetails) npDetails.classList.remove('np-empty');
  if (npDivider) npDivider.style.display = '';
  document.getElementById('home-np-track').textContent  = name;
  document.getElementById('home-np-artist').textContent = artists;
  document.getElementById('home-np-album').textContent  = album;
  if (src) document.getElementById('home-np-art').src = src;

  if (src && src !== lastArtSrc) {
    lastArtSrc = src;
    document.getElementById('fp-art').src  = src;
    document.getElementById('bar-art').src = src;
    tintMusicCard(src);
    loadArtAccent(src);
  }

  const artistIds = data.item.artists.map(a => a.id).join(',');
  if (artistIds !== lastArtistIds) {
    lastArtistIds = artistIds;
    document.getElementById('np-artist-section').innerHTML = data.item.artists.map(a =>
      '<div class="np-a-row" data-id="' + a.id + '" onclick="openArtist(this.dataset.id)">' +
      '<img class="np-a-img" id="np-ai-' + a.id + '" src="" alt="">' +
      '<div><div class="np-a-name">' + esc(a.name) + '</div><div class="np-a-sub" id="np-ag-' + a.id + '">Artist</div></div></div>'
    ).join('');
    data.item.artists.forEach(a => {
      if (artistCache[a.id]) applyArtistCache(a.id);
      else api('/api/artist/' + a.id).then(d => { artistCache[a.id] = d.artist || {}; applyArtistCache(a.id); }).catch(() => {});
    });
  }

  hasTrack = true;
  if (data.is_playing && radioStation) stopRadio();
  if (!radioStation) {
    const npPlaying = document.getElementById('home-np-playing');
    const npRecent  = document.getElementById('home-np-recent');
    const musicLbl  = document.getElementById('home-music-label');
    if (npPlaying) npPlaying.style.display = 'block';
    if (npRecent)  npRecent.style.display  = 'none';
    if (musicLbl)  { musicLbl.textContent = 'Now Playing'; musicLbl.style.color = ''; }
  }

  const trackId = data.item.id;
  if (trackId && trackId !== currentTrackId) {
    currentTrackId = trackId;
    api('/api/like-status?ids=' + trackId).then(res => { if (Array.isArray(res)) updateLikeBtn(res[0]); }).catch(() => {});
    if (homeLyrOpen || tabLyrOpen) loadLyrics();
  }

  playing = data.is_playing;
  progMs  = data.progress_ms || 0;
  durMs   = data.item.duration_ms || 1;
  clearInterval(ticker);
  _syncProgAnchor(progMs);
  if (playing) ticker = setInterval(() => { progMs = Math.min(_progAnchorMs + (Date.now() - _progAnchorAt), durMs); renderProg(); }, 500);
  renderProg();
  setPlayIcons(playing);
  if (data.device?.volume_percent != null) {
    _serverVolume = true;
    document.getElementById('fp-vol').value = data.device.volume_percent;
    _serverVolume = false;
  }
  shuffled = data.shuffle_state;
  document.getElementById('fp-shuffle')?.classList.toggle('lit', shuffled);
  if (data.repeat_state) { repeatState = data.repeat_state; renderRepeat(); }
}

// ── Override action ───────────────────────────────────────────────────────────
function action(name) {
  if (activeService === 'youtube') { ytAction(name); return; }
  if (activeService === 'apple')   { appleAction(name); return; }
  if (browserPlayer && browserPlayerReady) {
    if (name === 'play') {
      browserPlayer.activateElement();
      browserPlayer.getCurrentState().then(state => {
        if (state) browserPlayer.resume();
        else api('/api/transfer', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: browserPlayer._deviceId }) })
          .then(() => setTimeout(() => browserPlayer.resume(), 600))
          .catch(() => api('/api/player/play', { method: 'POST' }));
      });
      return;
    }
    if (name === 'pause' || name === 'next' || name === 'previous') {
      // Same "confirm this device is actually active before using the fast
      // local path" guard as _spotifySeek() -- browserPlayer being ready
      // doesn't mean it's the device that's actually playing.
      browserPlayer.getCurrentState().then(state => {
        if (state) {
          if (name === 'pause') browserPlayer.pause();
          else if (name === 'next') browserPlayer.nextTrack();
          else browserPlayer.previousTrack();
        } else {
          api('/api/player/' + name, { method: 'POST' });
        }
      });
      return;
    }
  }
  // This device's own Web Playback SDK session isn't ready yet. If nothing
  // has been active anywhere this session (hasTrack is only ever set once a
  // real player state with a track comes back), don't wait on the server's
  // arbitrary-device fallback (which can take 10s+ if it has to launch a
  // desktop Spotify client) -- go straight for this device's own player,
  // since the user is looking at (and just pressed play in) this exact tab.
  if (name === 'play' && !hasTrack) { _useOwnDevice(); return; }
  api('/api/player/' + name, { method: 'POST' }).then(res => {
    if (name === 'play' && res?.error) _useOwnDevice();
  });
}

// Waits (briefly) for this device's own Web Playback SDK session to come up,
// then calls onReady(spDeviceId) -- covers "nothing is active anywhere" so
// playback doesn't need the user to dig into the device picker manually.
// With no callback, just transfers + resumes (the transport play button's
// case, where there's no specific track to (re)send).
function _useOwnDevice(onReady, attempt) {
  attempt = attempt || 0;
  if (!browserPlayer) loadBrowserPlayer();
  if (browserPlayer && browserPlayerReady) {
    browserPlayer.activateElement();
    if (onReady) { onReady(browserPlayer._deviceId); return; }
    api('/api/transfer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: browserPlayer._deviceId, play: true }) });
    return;
  }
  if (attempt >= 20) { if (onReady) _playErr(); return; } // ~6s -- SDK isn't coming up (unsupported browser, no Premium, etc.); the device picker is still there to pick manually
  setTimeout(() => _useOwnDevice(onReady, attempt + 1), 300);
}

// ── Override togglePlay ───────────────────────────────────────────────────────
function togglePlay() {
  if (activeService === 'youtube') { _ytTogglePlay(); return; }
  if (activeService === 'apple')   { _appleTogglePlay(); return; }
  if (browserPlayer) browserPlayer.activateElement();
  playing = !playing; setPlayIcons(playing); action(playing ? 'play' : 'pause');
}

// Only takes the fast local SDK path if this device's own player is
// confirmed (via a live getCurrentState() check, not just "the SDK loaded
// ok") to actually be the one currently playing -- browserPlayer existing
// and being ready doesn't mean it's the ACTIVE device (e.g. a real phone/
// desktop Spotify app could be). Calling .seek()/.pause()/etc. on an
// inactive local SDK instance is a silent no-op on whatever's actually
// playing -- this was the cause of clicking a lyric line not moving the
// song. REST fallback has no such ambiguity: it always targets Spotify's
// own notion of the current active device.
function _spotifySeek(ms) {
  if (browserPlayer && browserPlayerReady) {
    browserPlayer.getCurrentState().then(state => {
      if (state) browserPlayer.seek(ms);
      else fetch(BASE_PATH + '/api/player/seek?device=' + deviceId + '&ms=' + ms, { method: 'POST' });
    });
    return;
  }
  fetch(BASE_PATH + '/api/player/seek?device=' + deviceId + '&ms=' + ms, { method: 'POST' });
}

// ── Override seekTo ───────────────────────────────────────────────────────────
function seekTo(e) {
  const rect = document.getElementById('fp-bar').getBoundingClientRect();
  progMs = Math.floor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durMs);
  _syncProgAnchor(progMs);
  renderProg();
  if (activeService === 'youtube' && ytPlayer && ytPlayerReady) {
    ytPlayer.seekTo(progMs / 1000, true); return;
  }
  if (activeService === 'apple' && appleMusic) {
    appleMusic.seekToTime(progMs / 1000).catch(() => {}); return;
  }
  _spotifySeek(progMs);
}

// ── Override setVolume ────────────────────────────────────────────────────────
function setVolume(val) {
  if (_serverVolume) return;
  if (activeService === 'youtube' && ytPlayer && ytPlayerReady) { ytPlayer.setVolume(val); return; }
  if (activeService === 'apple' && appleMusic) { try { appleMusic.volume = val / 100; } catch {} return; }
  if (browserPlayer) browserPlayer.setVolume(val / 100).catch(() => {});
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api('/api/player/volume', { method: 'PUT',
    headers: {'Content-Type':'application/json'}, body: JSON.stringify({ volume: val }) }), 250);
}

// ── Override doSearch ─────────────────────────────────────────────────────────
function doSearch(q) {
  if (activeService === 'youtube') { ytSearch(q); return; }
  if (activeService === 'apple')   { appleSearch(q); return; }
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
    document.getElementById('search-results').innerHTML = html ||
      '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">No results for "' + esc(q) + '"</div>';
  }).catch(() => {
    document.getElementById('search-results').innerHTML =
      '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Search failed</div>';
  });
}

// ── Override setLibTab ────────────────────────────────────────────────────────
function setLibTab(tab) {
  libTab = tab;
  ['playlists', 'artists', 'recent', 'live'].forEach(t =>
    document.getElementById('lt-' + t)?.classList.toggle('active', t === tab)
  );
  if (activeService === 'youtube') { _ytSetLibTab(tab); return; }
  if (activeService === 'apple')   { _appleSetLibTab(tab); return; }
  const el = document.getElementById('sidebar-list'); if (!el) return;
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
        '<div class="sl-item-sub">' + (a.genres?.slice(0, 1).join('') || 'Artist') + '</div></div></div>'
      ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No artists</div>';
      el.innerHTML = libSidebarCache.artists;
    }).catch(() => {});
  } else if (tab === 'live') {
    liveRenderSidebar();
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

// ═══════════════════════════════════════════════════════════════════════════════
// YOUTUBE MUSIC
// ═══════════════════════════════════════════════════════════════════════════════

function ytSaveCreds() {
  const cid    = document.getElementById('yt-client-id')?.value.trim();
  const sec    = document.getElementById('yt-client-sec')?.value.trim();
  const status = document.getElementById('yt-auth-status');
  if (!cid) { if (status) status.textContent = 'Client ID is required.'; return; }
  if (status) status.textContent = 'Saving…';
  fetch(BASE_PATH + '/api/yt/save-creds?device=' + deviceId, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: cid, clientSecret: sec || '' }),
  }).then(r => r.json()).then(() => {
    if (status) status.textContent = 'Opening Google sign-in…';
    const popup = window.open(BASE_PATH + '/auth/google?device=' + deviceId, 'yt-auth', 'width=520,height=620');
    const handler = e => {
      if (e.data?.type === 'yt-auth-done') {
        window.removeEventListener('message', handler);
        if (popup && !popup.closed) popup.close();
        _ytCheck();
      } else if (e.data?.type === 'yt-auth-error') {
        window.removeEventListener('message', handler);
        if (status) status.textContent = 'Auth failed — check credentials and try again.';
      }
    };
    window.addEventListener('message', handler);
  }).catch(() => { if (status) status.textContent = 'Failed to save credentials.'; });
}

function ytLoadPlayer() {
  if (ytPlayer || document.querySelector('#yt-player-host iframe')) return;
  if (window.YT?.Player) { _ytCreatePlayer(); return; }
  window.onYouTubeIframeAPIReady = _ytCreatePlayer;
  const s = document.createElement('script');
  s.src = BASE_PATH + '/yt/iframe-api.js';
  document.head.appendChild(s);
}

function _ytCreatePlayer() {
  if (ytPlayer) return;
  const host = document.getElementById('yt-player-host');
  if (!host) return;
  ytPlayer = new YT.Player(host, {
    height: '270', width: '480',
    playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1 },
    events: {
      onReady: () => { ytPlayerReady = true; },
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING) {
          playing = true; setPlayIcons(true);
          clearInterval(ytTicker);
          ytTicker = setInterval(() => {
            if (!ytPlayer || !ytPlayerReady || activeService !== 'youtube') return;
            try {
              progMs = Math.round((ytPlayer.getCurrentTime() || 0) * 1000);
              durMs  = Math.round((ytPlayer.getDuration()    || 0) * 1000) || 1;
              renderProg();
            } catch {}
          }, 500);
        } else if (e.data === YT.PlayerState.PAUSED) {
          playing = false; setPlayIcons(false); clearInterval(ytTicker);
        } else if (e.data === YT.PlayerState.ENDED) {
          playing = false; setPlayIcons(false); clearInterval(ytTicker); _ytAdvance();
        }
      },
    },
  });
}

function ytPlay(videoId, title, artist, thumb) {
  if (!ytPlayer || !ytPlayerReady) {
    ytLoadPlayer();
    setTimeout(() => ytPlay(videoId, title, artist, thumb), 1800);
    return;
  }
  try { ytPlayer.loadVideoById(videoId); } catch { return; }
  const artUrl = thumb || ('https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg');
  _updateNowPlaying(title, artist, 'YouTube Music', artUrl);
  playing = true; setPlayIcons(true);
}

function ytPlayQueue(items, startIdx) {
  ytQueue    = items || [];
  ytQueueIdx = startIdx || 0;
  const item = ytQueue[ytQueueIdx];
  if (item) ytPlay(item.videoId, item.title, item.artist, item.thumb);
}

function _ytAdvance() {
  if (ytQueueIdx < ytQueue.length - 1) {
    ytQueueIdx++;
    const item = ytQueue[ytQueueIdx];
    ytPlay(item.videoId, item.title, item.artist, item.thumb);
  }
}

function _ytTogglePlay() {
  if (!ytPlayer || !ytPlayerReady) return;
  if (playing) { try { ytPlayer.pauseVideo(); } catch {} playing = false; }
  else         { try { ytPlayer.playVideo();  } catch {} playing = true; }
  setPlayIcons(playing);
}

function ytAction(name) {
  if (!ytPlayer || !ytPlayerReady) return;
  if (name === 'play')     { try { ytPlayer.playVideo();  } catch {} playing = true;  setPlayIcons(true); }
  else if (name === 'pause')    { try { ytPlayer.pauseVideo(); } catch {} playing = false; setPlayIcons(false); }
  else if (name === 'next')     { _ytAdvance(); }
  else if (name === 'previous') {
    if (ytQueueIdx > 0) {
      ytQueueIdx--;
      const i = ytQueue[ytQueueIdx];
      ytPlay(i.videoId, i.title, i.artist, i.thumb);
    } else {
      try { ytPlayer.seekTo(0, true); } catch {}
    }
  }
}

function ytSearch(q) {
  const el = document.getElementById('search-results'); if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Searching…</div>';
  fetch(BASE_PATH + '/api/yt/search?q=' + encodeURIComponent(q) + '&device=' + deviceId)
    .then(r => r.json()).then(d => {
      const items = d.items || [];
      if (!items.length) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">No results</div>'; return;
      }
      window._ytSearchQueue = items.map(v => ({
        videoId: v.id?.videoId || '',
        title:   v.snippet?.title || '',
        artist:  v.snippet?.channelTitle || '',
        thumb:   v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || '',
      })).filter(v => v.videoId);
      el.innerHTML = '<div class="browse-section">YouTube Music</div><div>' +
        window._ytSearchQueue.map((v, i) =>
          '<div class="sr-row" onclick="_ytPlayFromSearch(' + i + ')">' +
          '<img class="sr-art" src="' + esc(v.thumb) + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(v.title) + '</div>' +
          '<div class="sr-sub">' + esc(v.artist) + '</div></div>' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M8 5v14l11-7z"/></svg></div>'
        ).join('') + '</div>';
    }).catch(() => {
      el.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Search failed</div>';
    });
}

function _ytPlayFromSearch(i) { ytPlayQueue(window._ytSearchQueue || [], i); }

function _ytSetLibTab(tab) {
  const el = document.getElementById('sidebar-list'); if (!el) return;
  if (tab === 'playlists') {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Loading…</div>';
    fetch(BASE_PATH + '/api/yt/playlists?device=' + deviceId).then(r => r.json()).then(d => {
      const items = d.items || [];
      if (!items.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No playlists</div>'; return; }
      el.innerHTML = items.map(p => {
        const name  = esc(p.snippet?.title || '');
        const thumb = esc(p.snippet?.thumbnails?.default?.url || '');
        const count = p.contentDetails?.itemCount ? ' · ' + p.contentDetails.itemCount + ' videos' : '';
        const id    = esc(p.id || '');
        return '<div class="sl-item" onclick="ytOpenPlaylist(\'' + id + '\',\'' + name + '\')">' +
          (thumb ? '<img src="' + thumb + '" alt="" loading="lazy">' : '') +
          '<div class="sl-item-info"><div class="sl-item-name">' + name + '</div>' +
          '<div class="sl-item-sub">Playlist' + count + '</div></div></div>';
      }).join('');
    }).catch(() => { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Failed to load</div>'; });
  } else if (tab === 'recent' || tab === 'artists') {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Loading liked videos…</div>';
    fetch(BASE_PATH + '/api/yt/liked?device=' + deviceId).then(r => r.json()).then(d => {
      const items = d.items || [];
      window._ytLikedQueue = items.map(v => ({
        videoId: v.id || '',
        title:   v.snippet?.title || '',
        artist:  v.snippet?.channelTitle || '',
        thumb:   v.snippet?.thumbnails?.default?.url || '',
      }));
      el.innerHTML = window._ytLikedQueue.map((v, i) =>
        '<div class="sl-item" onclick="ytPlayQueue(_ytLikedQueue,' + i + ')">' +
        (v.thumb ? '<img src="' + esc(v.thumb) + '" alt="" loading="lazy">' : '') +
        '<div class="sl-item-info"><div class="sl-item-name">' + esc(v.title) + '</div>' +
        '<div class="sl-item-sub">' + esc(v.artist) + '</div></div></div>'
      ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No liked videos</div>';
    }).catch(() => { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Failed to load</div>'; });
  } else if (tab === 'live') {
    liveRenderSidebar();
  }
}

function ytOpenPlaylist(id, title) {
  document.getElementById('vpl-name').textContent = title || 'Playlist';
  document.getElementById('vpl-sub').textContent  = 'Loading…';
  document.getElementById('vpl-art').src = '';
  document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;font-size:14px;">Loading…</div>';
  const detPlayBtn = document.querySelector('#view-playlist .det-play-btn');
  const detShufBtn = document.querySelector('#view-playlist .det-shuf-btn');
  if (detPlayBtn) detPlayBtn.onclick = () => ytPlayQueue(window._ytPlaylistQueue || [], 0);
  if (detShufBtn) detShufBtn.onclick = () => {
    const q = [...(window._ytPlaylistQueue || [])].sort(() => Math.random() - .5);
    ytPlayQueue(q, 0);
  };
  openDetail('view-playlist');
  fetch(BASE_PATH + '/api/yt/playlist-items?id=' + encodeURIComponent(id) + '&device=' + deviceId)
    .then(r => r.json()).then(d => {
      const items = (d.items || []).filter(i => i.snippet?.resourceId?.videoId);
      window._ytPlaylistQueue = items.map(i => ({
        videoId: i.snippet.resourceId.videoId,
        title:   i.snippet.title || '',
        artist:  i.snippet.videoOwnerChannelTitle || '',
        thumb:   i.snippet.thumbnails?.default?.url || '',
      }));
      const coverThumb = items[0]?.snippet?.thumbnails?.medium?.url || '';
      if (coverThumb) document.getElementById('vpl-art').src = coverThumb;
      document.getElementById('vpl-sub').textContent = items.length + ' videos';
      document.getElementById('vpl-tracks').innerHTML = window._ytPlaylistQueue.map((v, i) =>
        '<div class="det-track" onclick="ytPlayQueue(_ytPlaylistQueue,' + i + ')">' +
        '<span class="det-track-num">' + (i + 1) + '</span>' +
        '<img class="det-track-art" src="' + esc(v.thumb) + '" alt="" loading="lazy">' +
        '<div class="det-track-info"><div class="det-track-name">' + esc(v.title) + '</div>' +
        '<div class="det-track-sub">' + esc(v.artist) + '</div></div></div>'
      ).join('') || '<div style="color:var(--text-muted);padding:20px;font-size:14px;">No videos</div>';
    }).catch(() => {
      document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;">Failed to load</div>';
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// APPLE MUSIC
// ═══════════════════════════════════════════════════════════════════════════════

function appleSaveCreds() {
  const teamId = document.getElementById('apple-team-id')?.value.trim();
  const keyId  = document.getElementById('apple-key-id')?.value.trim();
  const pk     = document.getElementById('apple-p8')?.value.trim();
  const status = document.getElementById('apple-auth-status');
  if (!teamId || !keyId || !pk) { if (status) status.textContent = 'All fields are required.'; return; }
  if (status) status.textContent = 'Saving credentials…';
  fetch(BASE_PATH + '/api/apple/save-creds', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, keyId, privateKey: pk }),
  }).then(r => r.json()).then(d => {
    if (d.error) { if (status) status.textContent = 'Error: ' + d.error; return; }
    if (status) status.textContent = 'Saved — loading Apple Music…';
    _appleCheck();
  }).catch(() => { if (status) status.textContent = 'Failed to save.'; });
}

function appleLoadKit() {
  if (window.MusicKit) { _appleInit(); return; }
  const s = document.createElement('script');
  s.src = BASE_PATH + '/mk/musickitjs';
  s.onload  = _appleInit;
  s.onerror = () => console.error('[Apple Music] failed to load MusicKit.js');
  document.head.appendChild(s);
}

async function _appleInit() {
  try {
    const r = await fetch(BASE_PATH + '/api/apple/dev-token');
    const d = await r.json();
    if (d.error) { console.error('[Apple Music] dev-token error:', d.error); return; }
    await MusicKit.configure({
      developerToken: d.token,
      app: { name: 'TemuTalk', build: '1.0' },
    });
    appleMusic = MusicKit.getInstance();
    appleMusic.addEventListener('nowPlayingItemDidChange', _appleOnTrackChange);
    appleMusic.addEventListener('playbackStateDidChange', _appleOnStateChange);
    if (!appleMusic.isAuthorized) {
      try { await appleMusic.authorize(); } catch (e) { console.error('[Apple Music] auth:', e); return; }
    }
    _appleSetLibTab(libTab || 'playlists');
  } catch (e) { console.error('[Apple Music] init error:', e); }
}

function _appleOnTrackChange() {
  if (activeService !== 'apple' || !appleMusic) return;
  const item = appleMusic.nowPlayingItem;
  if (!item) return;
  const a      = item.attributes || {};
  const artUrl = (a.artwork?.url || '').replace('{w}x{h}', '300x300');
  durMs = a.durationInMillis || 1;
  _updateNowPlaying(a.name || 'Unknown', a.artistName || '', a.albumName || '', artUrl);
}

function _appleOnStateChange() {
  if (activeService !== 'apple' || !appleMusic) return;
  const isPlaying = appleMusic.playbackState === 2; // MusicKit.PlaybackState.playing = 2
  playing = isPlaying; setPlayIcons(isPlaying);
  clearInterval(appleTicker);
  if (isPlaying) {
    appleTicker = setInterval(() => {
      if (!appleMusic || activeService !== 'apple') return;
      progMs = Math.round((appleMusic.currentPlaybackTime || 0) * 1000);
      renderProg();
    }, 500);
  }
}

function _appleTogglePlay() {
  if (!appleMusic) return;
  if (playing) appleMusic.pause();
  else appleMusic.play().catch(() => {});
}

function appleAction(name) {
  if (!appleMusic) return;
  if (name === 'play')     { appleMusic.play().catch(() => {}); }
  else if (name === 'pause')    { appleMusic.pause(); }
  else if (name === 'next')     { appleMusic.skipToNextItem().catch(() => {}); }
  else if (name === 'previous') { appleMusic.skipToPreviousItem().catch(() => {}); }
}

async function applePlaySong(id) {
  if (!appleMusic) return;
  try { await appleMusic.setQueue({ song: id }); appleMusic.play().catch(() => {}); }
  catch (e) { console.error('[Apple Music] play:', e); }
}

async function appleSearch(q) {
  const el = document.getElementById('search-results'); if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Searching…</div>';
  try {
    const sf = (appleMusic?.storefrontId || appleMusic?.storefrontCountryCode || 'us').toLowerCase();
    const r  = await fetch(BASE_PATH + '/api/apple/search?q=' + encodeURIComponent(q) + '&storefront=' + sf);
    const d  = await r.json();
    let html = '';
    const songs = d.results?.songs?.data || [];
    if (songs.length) {
      html += '<div class="browse-section">Apple Music</div><div>';
      songs.slice(0, 8).forEach(s => {
        const a   = s.attributes || {};
        const art = (a.artwork?.url || '').replace('{w}x{h}', '60x60');
        const dur = a.durationInMillis ? fmt(a.durationInMillis) : '';
        html += '<div class="sr-row" data-id="' + esc(s.id) + '" onclick="applePlaySong(this.dataset.id)">' +
          '<img class="sr-art" src="' + esc(art) + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(a.name || '') + '</div>' +
          '<div class="sr-sub">' + esc(a.artistName || '') + ' · ' + esc(a.albumName || '') + '</div></div>' +
          '<span class="sr-dur">' + dur + '</span></div>';
      });
      html += '</div>';
    }
    const albums = d.results?.albums?.data || [];
    if (albums.length) {
      html += '<div class="browse-section">Albums</div><div>';
      albums.slice(0, 4).forEach(a => {
        const at  = a.attributes || {};
        const art = (at.artwork?.url || '').replace('{w}x{h}', '60x60');
        html += '<div class="sr-row" data-id="' + esc(a.id) + '" onclick="applePlayAlbum(this.dataset.id)">' +
          '<img class="sr-art" src="' + esc(art) + '" alt="" loading="lazy">' +
          '<div class="sr-info"><div class="sr-name">' + esc(at.name || '') + '</div>' +
          '<div class="sr-sub">' + esc(at.artistName || '') + '</div></div>' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></div>';
      });
      html += '</div>';
    }
    el.innerHTML = html || '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">No results</div>';
  } catch {
    el.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:14px;">Search failed</div>';
  }
}

async function applePlayAlbum(id) {
  if (!appleMusic) return;
  try { await appleMusic.setQueue({ album: id }); appleMusic.play().catch(() => {}); }
  catch (e) { console.error('[Apple Music] play album:', e); }
}

async function _appleSetLibTab(tab) {
  const el = document.getElementById('sidebar-list'); if (!el) return;
  if (!appleMusic?.isAuthorized) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Sign in to Apple Music to browse library</div>'; return;
  }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Loading…</div>';
  try {
    if (tab === 'playlists') {
      const r = await appleMusic.api.music('/v1/me/library/playlists', { params: { limit: 50 } });
      const items = r.data?.data || [];
      el.innerHTML = items.map(p => {
        const a = p.attributes || {};
        return '<div class="sl-item" data-id="' + esc(p.id) + '" onclick="appleOpenPlaylist(this.dataset.id,\'' + esc(a.name || '').replace(/'/g,'') + '\')">' +
          '<div class="sl-item-info"><div class="sl-item-name">' + esc(a.name || '') + '</div>' +
          '<div class="sl-item-sub">Playlist</div></div></div>';
      }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No playlists</div>';
    } else if (tab === 'artists') {
      const r = await appleMusic.api.music('/v1/me/library/artists', { params: { limit: 50 } });
      const items = r.data?.data || [];
      el.innerHTML = items.map(a => {
        const at = a.attributes || {};
        return '<div class="sl-item"><div class="sl-item-info"><div class="sl-item-name">' + esc(at.name || '') + '</div>' +
          '<div class="sl-item-sub">Artist</div></div></div>';
      }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No artists</div>';
    } else if (tab === 'recent') {
      const r = await appleMusic.api.music('/v1/me/library/songs', { params: { limit: 50 } });
      const items = r.data?.data || [];
      el.innerHTML = items.map(s => {
        const a = s.attributes || {};
        return '<div class="sl-item" data-id="' + esc(s.id) + '" onclick="applePlaySong(this.dataset.id)">' +
          '<div class="sl-item-info"><div class="sl-item-name">' + esc(a.name || '') + '</div>' +
          '<div class="sl-item-sub">' + esc(a.artistName || '') + '</div></div></div>';
      }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No songs</div>';
    } else if (tab === 'live') {
      liveRenderSidebar();
    }
  } catch {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Failed to load library</div>';
  }
}

async function appleOpenPlaylist(id, title) {
  document.getElementById('vpl-name').textContent = title || 'Playlist';
  document.getElementById('vpl-sub').textContent  = 'Loading…';
  document.getElementById('vpl-art').src = '';
  document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;font-size:14px;">Loading…</div>';
  const detPlayBtn = document.querySelector('#view-playlist .det-play-btn');
  const detShufBtn = document.querySelector('#view-playlist .det-shuf-btn');
  if (detPlayBtn) detPlayBtn.onclick = async () => {
    if (!appleMusic) return;
    try { await appleMusic.setQueue({ playlist: id }); appleMusic.play().catch(() => {}); } catch {}
  };
  if (detShufBtn) detShufBtn.onclick = async () => {
    if (!appleMusic) return;
    try { appleMusic.shuffleMode = 1; await appleMusic.setQueue({ playlist: id }); appleMusic.play().catch(() => {}); } catch {}
  };
  openDetail('view-playlist');
  try {
    const r = await appleMusic.api.music('/v1/me/library/playlists/' + id + '/tracks', { params: { limit: 100 } });
    const items = r.data?.data || [];
    document.getElementById('vpl-sub').textContent = items.length + ' songs';
    document.getElementById('vpl-tracks').innerHTML = items.map((s, i) => {
      const a   = s.attributes || {};
      const dur = a.durationInMillis ? fmt(a.durationInMillis) : '';
      return '<div class="det-track" data-id="' + esc(s.id) + '" onclick="applePlaySong(this.dataset.id)">' +
        '<span class="det-track-num">' + (i + 1) + '</span>' +
        '<div class="det-track-info" style="padding-left:4px;">' +
        '<div class="det-track-name">' + esc(a.name || '') + '</div>' +
        '<div class="det-track-sub">' + esc(a.artistName || '') + '</div></div>' +
        '<span class="det-track-dur">' + dur + '</span></div>';
    }).join('') || '<div style="color:var(--text-muted);padding:20px;font-size:14px;">No tracks</div>';
  } catch {
    document.getElementById('vpl-tracks').innerHTML = '<div style="color:var(--text-muted);padding:20px 16px;">Failed to load tracks</div>';
  }
}

