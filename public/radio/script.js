// ── Radio map (Leaflet) ───────────────────────────────────────────────────
const RADIO_FALLBACK_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(232,121,249,0.55)" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="13" r="2.2"/><path d="M16.5 8.5a6.5 6.5 0 0 1 0 9.2M7.5 17.7a6.5 6.5 0 0 1 0-9.2"/><path d="M19.8 5.2a11 11 0 0 1 0 15.6M4.2 20.8a11 11 0 0 1 0-15.6"/></svg>');
let radioMap = null, radioCluster = null, radioMarkers = [], radioAudio = null, radioStation = null;
let radioStations = [], radioMapInited = false;

function toggleRadioPanel() {
  document.getElementById('rmap-panel').classList.toggle('open');
}

function initRadioMap() {
  if (radioMapInited) {
    setTimeout(() => { if (radioMap) { radioMap.invalidateSize(); fitMapWidth(); } }, 60);
    setTimeout(() => { if (radioMap) fitMapWidth(); }, 400); // after the view slide-in
    if (radioSSE || radioStations.length) return;
    loadRadioStations();
    return;
  }
  radioMapInited = true;

  // Start fetching stations immediately — don't wait for Leaflet CDN
  loadRadioStations();

  function loadLeafletScripts(cb) {
    if (window.L && window.L.markerClusterGroup) { cb(); return; }
    const js1 = document.createElement('script');
    js1.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js1.onerror = () => console.warn('[radio] Leaflet failed to load — map unavailable, station list still works');
    js1.onload = () => {
      const js2 = document.createElement('script');
      js2.src = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js';
      js2.onerror = () => console.warn('[radio] MarkerCluster failed to load');
      js2.onload = cb;
      document.head.appendChild(js2);
    };
    document.head.appendChild(js1);
  }
  loadLeafletScripts(setupRadioMap);
}


function setupRadioMap() {
  radioMap = L.map('radio-map', {
    center: [30, 10], zoom: 2, minZoom: 2, maxZoom: 14,
    zoomControl: true, attributionControl: true,
    worldCopyJump: false,
    maxBounds: [[-85.05, -180], [85.05, 180]],
    maxBoundsViscosity: 1.0,
    zoomSnap: 0.25, zoomDelta: 0.5,
  });
  L.tileLayer(BASE_PATH + '/api/tiles/dark_nolabels/{z}/{x}/{y}', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 19, noWrap: true, opacity: 0.35,
  }).addTo(radioMap);
  L.tileLayer(BASE_PATH + '/api/tiles/dark_only_labels/{z}/{x}/{y}', {
    maxZoom: 19, noWrap: true, opacity: 0.5,
  }).addTo(radioMap);
  radioCluster = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: cluster => {
      const n = cluster.getChildCount();
      const cls = n < 20 ? 'sm' : n < 100 ? 'md' : 'lg';
      const sz = cls === 'sm' ? 32 : cls === 'md' ? 42 : 54;
      return L.divIcon({
        html: '<div class="rmap-cluster-wrap ' + cls + '"><div class="rmap-cluster-inner">' + n + '</div></div>',
        className: '', iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
      });
    },
  });
  radioMap.addLayer(radioCluster);
  // Ensure map fills the container after the view becomes visible,
  // then raise minZoom so the world fills the viewport WIDTH — no
  // letterbox bars on wide (16:9) screens; the poles crop instead.
  setTimeout(() => { radioMap.invalidateSize(); fitMapWidth(); }, 100);
  setTimeout(() => { radioMap.invalidateSize(); fitMapWidth(); }, 500); // view transition done
  radioMap.on('resize', () => fitMapWidth());
  window.addEventListener('resize', () => setTimeout(fitMapWidth, 150));
  // Add any stations that loaded while Leaflet was initialising
  if (radioStations.length) addRadioMarkers(radioStations);
}

function fitMapWidth() {
  if (!radioMap) return;
  const w = radioMap.getSize().x;
  if (!w) return;
  // Zoom at which the 256px world tile spans the container width
  const z = Math.max(2, Math.log2(w / 256));
  radioMap.setMinZoom(z);
  if (radioMap.getZoom() < z) radioMap.setView([24, 10], z);
}

function setRadioLoading(vis) {
  document.getElementById('rmap-loading')?.classList.toggle('vis', vis);
}

let radioSSE = null;
let radioListRenderTimer = null;

function loadRadioStations() {
  if (radioSSE) { radioSSE.close(); radioSSE = null; }
  radioStations = [];
  radioMarkers  = [];
  if (radioCluster) radioCluster.clearLayers();
  setRadioLoading(true);

  // Fast map population: single JSON request for geolocated stations only
  fetch(BASE_PATH + '/api/radio/geo')
    .then(r => r.json())
    .then(geo => {
      if (Array.isArray(geo) && geo.length) {
        radioStations.push(...geo);
        addRadioMarkers(geo);
        renderRadioList(radioListFilter);
      }
    })
    .catch(() => {});

  // Full list: stream via SSE, deduplicate against already-loaded stations
  const seenIds = new Set();
  const src = new EventSource(BASE_PATH + '/api/radio?device=' + deviceId);
  radioSSE = src;
  src.onmessage = e => {
    let batch;
    try { batch = JSON.parse(e.data); } catch { return; }
    if (!Array.isArray(batch) || !batch.length) return;
    // Seed seenIds from radioStations on first message (catches geo stations)
    if (!seenIds.size) radioStations.forEach(s => seenIds.add(s.stationuuid));
    const novel = batch.filter(s => {
      if (seenIds.has(s.stationuuid)) return false;
      seenIds.add(s.stationuuid);
      return true;
    });
    if (novel.length) {
      radioStations.push(...novel);
      // Debounce list re-renders during streaming
      clearTimeout(radioListRenderTimer);
      radioListRenderTimer = setTimeout(() => renderRadioList(radioListFilter), 300);
    }
  };
  src.addEventListener('done', () => {
    src.close(); radioSSE = null;
    setRadioLoading(false);
    renderRadioList(radioListFilter);
  });
  src.onerror = () => {
    src.close(); radioSSE = null;
    setRadioLoading(false);
  };
}

function addRadioMarkers(batch) {
  if (!radioCluster) return;
  const layers = [];
  batch.forEach(s => {
    if (!s.geo_lat || !s.geo_long) return;
    const playing = radioStation?.stationuuid === s.stationuuid;
    const icon = L.divIcon({
      className: '',
      html: '<div class="rmap-dot' + (playing ? ' playing' : '') + '" style="width:9px;height:9px;"></div>',
      iconSize: [9, 9], iconAnchor: [4.5, 4.5],
    });
    const marker = L.marker([s.geo_lat, s.geo_long], { icon });
    // Bind popup lazily on first click instead of pre-building HTML for every marker
    let popupBound = false;
    marker.on('click', () => {
      if (!popupBound) {
        popupBound = true;
        marker.bindPopup(buildRadioPopup(s), { maxWidth: 280, minWidth: 200, className: 'rmap-popup-wrap' });
        marker.openPopup();
      }
      setTimeout(() => wirePopupBtn(s), 50);
    });
    radioMarkers.push(marker);
    layers.push(marker);
  });
  if (layers.length) radioCluster.addLayers(layers);
}

function placeRadioMarkers() {
  if (!radioCluster) return;
  radioCluster.clearLayers();
  radioMarkers = [];
  const layers = [];
  radioStations.forEach(s => {
    if (!s.geo_lat || !s.geo_long) return;
    const playing = radioStation?.stationuuid === s.stationuuid;
    const icon = L.divIcon({
      className: '',
      html: '<div class="rmap-dot' + (playing ? ' playing' : '') + '" style="width:9px;height:9px;"></div>',
      iconSize: [9, 9], iconAnchor: [4.5, 4.5],
    });
    const marker = L.marker([s.geo_lat, s.geo_long], { icon });
    marker.bindPopup(buildRadioPopup(s), { maxWidth: 280, minWidth: 200, className: 'rmap-popup-wrap' });
    marker.on('click', () => setTimeout(() => wirePopupBtn(s), 50));
    radioMarkers.push(marker);
    layers.push(marker);
  });
  radioCluster.addLayers(layers);
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
  const rows = list.slice(0, 500);
  el.innerHTML = rows.map((s, i) => {
    const playing = radioStation?.stationuuid === s.stationuuid;
    const meta = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
    return '<div class="rmap-station-row' + (playing ? ' playing' : '') + '" data-idx="' + i + '" onclick="playStationByIdx(this)">' +
      '<img class="rmap-station-fav" src="' + esc(s.favicon || '') + '" alt="" onerror="this.onerror=null;this.src=RADIO_FALLBACK_IMG">' +
      '<div class="rmap-station-info">' +
        '<div class="rmap-station-name">' + esc(s.name) + '</div>' +
        '<div class="rmap-station-meta">' + esc(meta) + '</div>' +
      '</div>' +
      '<span class="rmap-station-play">' +
      (playing
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="#e879f9" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e879f9" stroke-width="2" stroke-linejoin="round"><polygon points="6,3 20,12 6,21"/></svg>'
      ) +
      '</span>' +
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
  // keep both sliders in sync
  document.getElementById('rmap-vol')?.setAttribute('value', val);
  const hv = document.getElementById('home-radio-vol');
  if (hv) hv.value = val;
}

function buildRadioPopup(s) {
  const playing = radioStation?.stationuuid === s.stationuuid;
  const tags = (s.tags || '').split(',').slice(0, 4).filter(Boolean).join(' · ');
  const meta = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
  return '<div class="rmap-popup">' +
    '<div class="rmap-popup-top">' +
      '<img class="rmap-popup-favicon" src="' + esc(s.favicon || '') + '" alt="" onerror="this.onerror=null;this.src=RADIO_FALLBACK_IMG">' +
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
  if (playing) action('pause');
  radioStation = s;
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'radio-now-playing', name: s.name, url: s.url_resolved }));
  let streamUrl = s.url_resolved || '';
  // Proxy HTTP streams through server to avoid mixed-content block on HTTPS
  if (streamUrl.startsWith('http:') && location.protocol === 'https:')
    streamUrl = '/api/radio/proxy?url=' + encodeURIComponent(streamUrl);
  radioAudio = new Audio(streamUrl);
  const vol = document.getElementById('rmap-vol');
  radioAudio.volume = vol ? vol.value / 100 : 0.8;
  radioAudio.play().catch(() => {});
  const np = document.getElementById('rmap-np');
  if (np) {
    np.classList.add('vis');
    const fav = document.getElementById('rmap-np-favicon');
    if (fav) { fav.src = s.favicon || RADIO_FALLBACK_IMG; fav.onerror = () => { fav.src = RADIO_FALLBACK_IMG; }; fav.style.opacity = '1'; }
    document.getElementById('rmap-np-name').textContent = s.name;
    document.getElementById('rmap-np-meta').textContent = [s.country, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
  }
  updateHomeRadio();
  placeRadioMarkers();
  renderRadioList(radioListFilter);
}

function stopRadio() {
  if (radioAudio) { radioAudio.pause(); radioAudio = null; }
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'radio-stopped' }));
  radioStation = null;
  document.getElementById('rmap-np')?.classList.remove('vis');
  updateHomeRadio();
  placeRadioMarkers();
  renderRadioList(radioListFilter);
}

function homeAudioHdrClick() {
  navigate(radioStation ? 'radio' : 'music');
}

function updateHomeRadio() {
  const radioSection = document.getElementById('home-radio-playing-state');
  const npPlaying    = document.getElementById('home-np-playing');
  const npRecent     = document.getElementById('home-np-recent');
  const lbl          = document.getElementById('home-music-label');
  const card         = document.getElementById('np-card');
  if (!radioSection) return;

  const active = !!radioStation;
  card?.classList.toggle('radio-active', active);

  if (active) {
    radioSection.style.cssText = 'flex:1;display:flex;flex-direction:column;justify-content:space-between;';
    if (npPlaying) npPlaying.style.display = 'none';
    if (npRecent)  npRecent.style.display  = 'none';
    if (lbl) { lbl.textContent = 'Radio'; lbl.style.color = '#e879f9'; }
    const fav = document.getElementById('home-radio-fav');
    if (fav) { fav.src = radioStation.favicon || RADIO_FALLBACK_IMG; fav.onerror = () => { fav.src = RADIO_FALLBACK_IMG; }; fav.style.opacity = '1'; }
    document.getElementById('home-radio-name').textContent = radioStation.name;
    document.getElementById('home-radio-meta').textContent =
      [radioStation.country, radioStation.bitrate ? radioStation.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
    const homeVol = document.getElementById('home-radio-vol');
    const mapVol  = document.getElementById('rmap-vol');
    if (homeVol && mapVol) homeVol.value = mapVol.value;
  } else {
    radioSection.style.cssText = 'display:none;';
    if (lbl) { lbl.textContent = hasTrack ? 'Now Playing' : 'Music'; lbl.style.color = ''; }
    if (npPlaying) npPlaying.style.display = hasTrack ? 'block' : 'none';
    if (npRecent)  npRecent.style.display  = hasTrack ? 'none'  : '';
  }
}
