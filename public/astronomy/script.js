// ── Astronomy tab ──────────────────────────────────────────────────────────────
let astroLoaded = false, astroLat = null, astroLng = null, issTimer = null;

function astroInit() {
  if (astroLoaded) { astroDrawSunArc(); return; }
  astroLoaded = true;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      astroLat = pos.coords.latitude;
      astroLng = pos.coords.longitude;
      document.getElementById('astro-location').textContent =
        astroLat.toFixed(2) + '°, ' + astroLng.toFixed(2) + '°';
      astroLoadAll();
    }, () => {
      astroLat = -26.2; astroLng = 28.0;
      document.getElementById('astro-location').textContent = 'Default (Johannesburg)';
      astroLoadAll();
    });
  } else {
    astroLat = -26.2; astroLng = 28.0;
    document.getElementById('astro-location').textContent = 'Geolocation N/A';
    astroLoadAll();
  }
}

function astroRefresh() { astroLoadAll(); }

function astroLoadAll() {
  astroLoadSun();
  astroCalcMoon();
  astroCalcPlanets();
  astroLoadISS();
  astroGenEvents();
}

// ── Sun ────────────────────────────────────────────────────────────────────────
async function astroLoadSun() {
  try {
    const r = await fetch('/api/sunrise?lat=' + astroLat + '&lng=' + astroLng + '&device=' + deviceId);
    const d = await r.json();
    const s = d.results;
    if (!s) return;
    const fmt = iso => new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const fmtLen = secs => {
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
      return h + 'h ' + m + 'm';
    };
    document.getElementById('sun-rise').textContent   = fmt(s.sunrise);
    document.getElementById('sun-noon').textContent   = fmt(s.solar_noon);
    document.getElementById('sun-set').textContent    = fmt(s.sunset);
    document.getElementById('sun-len').textContent    = fmtLen(s.day_length);
    document.getElementById('sun-dawn').textContent   = fmt(s.civil_twilight_begin || s.astronomical_twilight_begin);
    document.getElementById('sun-dusk').textContent   = fmt(s.civil_twilight_end   || s.astronomical_twilight_end);
    astroDrawSunArc(new Date(s.sunrise), new Date(s.sunset), new Date(s.solar_noon));
  } catch (e) { console.error('sun:', e); }
}

function astroDrawSunArc(rise, set, noon) {
  const canvas = document.getElementById('sun-arc');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 300, H = 90;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const now = new Date();
  if (!rise || !set) {
    // No data yet — just draw placeholder arc
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 2;
    ctx.arc(W/2, H + 10, W/2 - 20, Math.PI, 0); ctx.stroke();
    return;
  }

  const riseMs = rise.getTime(), setMs = set.getTime(), nowMs = now.getTime();
  const dayFrac = (nowMs - riseMs) / (setMs - riseMs);
  const clamped = Math.max(0, Math.min(1, dayFrac));

  const cx = W/2, cy = H + 10, rx = W/2 - 16, ry = H - 14;
  const angle = (t) => Math.PI + (t * Math.PI);

  // Background arc
  ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 3;
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0); ctx.stroke();

  // Progress arc
  if (dayFrac > 0) {
    ctx.beginPath();
    const grad = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    grad.addColorStop(0, '#f97316'); grad.addColorStop(0.5, '#fbbf24'); grad.addColorStop(1, '#f97316');
    ctx.strokeStyle = grad; ctx.lineWidth = 3;
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, angle(clamped)); ctx.stroke();
  }

  // Sun dot
  const sunAngle = angle(clamped);
  const sx = cx + Math.cos(sunAngle) * rx;
  const sy = cy + Math.sin(sunAngle) * ry;
  ctx.beginPath(); ctx.fillStyle = '#fbbf24'; ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 12;
  ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // Horizon labels
  ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(rise.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), 16, H - 2);
  ctx.fillText(set.toLocaleTimeString([],  {hour:'2-digit',minute:'2-digit'}), W - 16, H - 2);
  ctx.fillText('Noon', cx, H - 2);

  // "Now" label tracks sun
  const nowLabel = document.getElementById('sun-arc-now');
  if (nowLabel) {
    const pct = (sx / W * 100);
    nowLabel.style.left = pct + '%';
    nowLabel.textContent = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }
}

// ── Moon ───────────────────────────────────────────────────────────────────────
function astroCalcMoon() {
  const now = new Date();
  const jd = 367 * now.getFullYear()
    - Math.floor(7 * (now.getFullYear() + Math.floor((now.getMonth() + 1 + 9) / 12)) / 4)
    + Math.floor(275 * (now.getMonth() + 1) / 9)
    + now.getDate() + 1721013.5
    + (now.getHours() + now.getMinutes() / 60) / 24;

  const SYNODIC = 29.53058867;
  const newMoonJD = 2451549.5 + 0.5 * SYNODIC; // known new moon (Jan 6 2000)
  let age = ((jd - newMoonJD) % SYNODIC + SYNODIC) % SYNODIC;
  const illum = 0.5 * (1 - Math.cos(2 * Math.PI * age / SYNODIC));

  const phases = [
    { max: 1.85,  name: 'New Moon',        emoji: '🌑' },
    { max: 7.38,  name: 'Waxing Crescent', emoji: '🌒' },
    { max: 9.22,  name: 'First Quarter',   emoji: '🌓' },
    { max: 14.77, name: 'Waxing Gibbous',  emoji: '🌔' },
    { max: 16.61, name: 'Full Moon',       emoji: '🌕' },
    { max: 22.15, name: 'Waning Gibbous',  emoji: '🌖' },
    { max: 23.99, name: 'Last Quarter',    emoji: '🌗' },
    { max: 29.53, name: 'Waning Crescent', emoji: '🌘' },
  ];
  const phase = phases.find(p => age < p.max) || phases[phases.length - 1];
  const nextNew = SYNODIC - age;

  document.getElementById('moon-emoji').textContent  = phase.emoji;
  document.getElementById('moon-phase').textContent  = phase.name;
  document.getElementById('moon-illum').textContent  = Math.round(illum * 100) + '% illuminated';
  document.getElementById('moon-age').textContent    = 'Age: ' + age.toFixed(1) + ' days';
  document.getElementById('moon-rise-set').textContent = 'Next new moon in ' + nextNew.toFixed(1) + ' days';

  // Draw shaded moon
  drawMoon(illum, age < SYNODIC / 2);
}

function drawMoon(illum, waxing) {
  const canvas = document.getElementById('moon-canvas');
  if (!canvas) return;
  const W = 100, H = 100, r = 45, cx = W/2, cy = H/2;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Dark side
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
  // Lit side crescent/gibbous
  const xScale = Math.cos(Math.PI * illum);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI/2, -Math.PI/2); // right half
  ctx.closePath(); ctx.clip();
  if (waxing) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,200,.08)'; ctx.fill();
  }
  ctx.restore();
}

// ── ISS ────────────────────────────────────────────────────────────────────────
async function astroLoadISS() {
  try {
    const r = await fetch('/api/iss?device=' + deviceId);
    const d = await r.json();
    if (d.message !== 'success') return;
    const lat = parseFloat(d.iss_position.latitude);
    const lng = parseFloat(d.iss_position.longitude);
    document.getElementById('iss-lat').textContent = lat.toFixed(2) + '°';
    document.getElementById('iss-lng').textContent = lng.toFixed(2) + '°';
    drawISSMap(lat, lng);
    checkISSOverhead(lat, lng);
    // Poll every 5s
    if (issTimer) clearTimeout(issTimer);
    issTimer = setTimeout(astroLoadISS, 5000);
  } catch {}
}

function drawISSMap(lat, lng) {
  const canvas = document.getElementById('iss-map');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 300, H = 120;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  // Simple equirectangular background
  ctx.fillStyle = 'rgba(10,20,60,.6)'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = .5;
  for (let i = 0; i <= 6; i++) { const x = i * W/6; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let i = 0; i <= 3; i++) { const y = i * H/3; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Equator
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  // ISS position
  const x = (lng + 180) / 360 * W;
  const y = (90 - lat) / 180 * H;
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#a78bfa'; ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = 10; ctx.fill();
  ctx.shadowBlur = 0;

  // User position
  if (astroLat != null) {
    const ux = (astroLng + 180) / 360 * W;
    const uy = (90 - astroLat) / 180 * H;
    ctx.beginPath(); ctx.arc(ux, uy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#34d399'; ctx.fill();
  }
}

function checkISSOverhead(lat, lng) {
  const note = document.getElementById('iss-overhead');
  if (!note || astroLat == null) return;
  const dlat = Math.abs(lat - astroLat), dlng = Math.abs(lng - astroLng);
  const dist = Math.sqrt(dlat*dlat + dlng*dlng) * 111;
  if (dist < 1000) {
    note.textContent = '🟢 ISS is ~' + Math.round(dist) + ' km from your location!';
    note.style.color = '#34d399';
  } else {
    note.textContent = 'ISS is ' + Math.round(dist) + ' km from your location';
    note.style.color = '';
  }
}

// ── Planets ────────────────────────────────────────────────────────────────────
function astroCalcPlanets() {
  const now = new Date();
  const jd = 367 * now.getFullYear()
    - Math.floor(7 * (now.getFullYear() + Math.floor((now.getMonth() + 1 + 9) / 12)) / 4)
    + Math.floor(275 * (now.getMonth() + 1) / 9)
    + now.getDate() + 1721013.5
    + (now.getHours() + now.getMinutes() / 60) / 24;
  const T = (jd - 2451545.0) / 36525;

  // Simplified orbital elements (J2000)
  const planets = [
    { name:'Mercury', emoji:'☿', a:0.387, e:0.206, i:7.0, L0:252.25, Ldot:149474.07, w0:77.46, wdot:0.387, mag:-1.9 },
    { name:'Venus',   emoji:'♀', a:0.723, e:0.007, i:3.4, L0:181.98, Ldot:58519.21, w0:131.56, wdot:0.056, mag:-4.6 },
    { name:'Mars',    emoji:'♂', a:1.524, e:0.093, i:1.9, L0:355.43, Ldot:19141.70, w0:336.08, wdot:0.184, mag:1.8 },
    { name:'Jupiter', emoji:'♃', a:5.203, e:0.049, i:1.3, L0:34.40,  Ldot:3036.30,  w0:14.33,  wdot:0.083, mag:-2.9 },
    { name:'Saturn',  emoji:'♄', a:9.537, e:0.056, i:2.5, L0:49.94,  Ldot:1223.51,  w0:92.86,  wdot:0.064, mag:1.2 },
    { name:'Uranus',  emoji:'♅', a:19.19, e:0.047, i:0.8, L0:313.23, Ldot:428.48,   w0:172.43, wdot:0.030, mag:5.7 },
    { name:'Neptune', emoji:'♆', a:30.07, e:0.010, i:1.8, L0:304.88, Ldot:218.49,   w0:46.68,  wdot:0.012, mag:7.9 },
  ];

  const toRad = d => d * Math.PI / 180;
  const sunLon = (280.46646 + 36000.76983 * T) % 360;

  const cards = planets.map(p => {
    const L = (p.L0 + p.Ldot * T / 100) % 360;
    const lonRel = ((L - sunLon) % 360 + 360) % 360;
    // Very rough altitude estimate: 0° = opposition, 180° = conjunction
    const roughAlt = 45 - Math.abs(lonRel - 180) / 4;
    const visible  = roughAlt > 5;
    return { ...p, lonRel, roughAlt: Math.max(-90, roughAlt), visible };
  });

  const grid = document.getElementById('planets-grid');
  if (!grid) return;
  grid.innerHTML = cards.map(p => {
    const altStr = p.roughAlt > 0 ? '+' + Math.round(p.roughAlt) + '°' : Math.round(p.roughAlt) + '°';
    return '<div class="planet-card">' +
      '<div class="planet-name">' + p.emoji + ' ' + p.name +
        '<span class="planet-visible ' + (p.visible?'up':'down') + '">' + (p.visible?'Visible':'Below') + '</span></div>' +
      '<div class="planet-alt">' + altStr + ' altitude</div>' +
      '<div class="planet-mag">Mag ' + p.mag + '</div>' +
      '</div>';
  }).join('');
}

// ── Sky Events ─────────────────────────────────────────────────────────────────
function astroGenEvents() {
  const now = new Date();
  const month = now.getMonth();
  const SHOWERS = [
    { month:0, name:'Quadrantids',    peak:'Jan 3-4',  icon:'🌠' },
    { month:3, name:'Lyrids',         peak:'Apr 22',   icon:'🌠' },
    { month:4, name:'Eta Aquariids',  peak:'May 6',    icon:'🌠' },
    { month:7, name:'Perseids',       peak:'Aug 11-13',icon:'🌠' },
    { month:9, name:'Orionids',       peak:'Oct 21',   icon:'🌠' },
    { month:10,name:'Leonids',        peak:'Nov 17-18',icon:'🌠' },
    { month:11,name:'Geminids',       peak:'Dec 13-14',icon:'🌠' },
    { month:11,name:'Ursids',         peak:'Dec 22',   icon:'🌠' },
  ];
  const relevant = SHOWERS.filter(s => Math.abs(s.month - month) <= 1);
  const events = [
    ...relevant.map(s => ({ icon: s.icon, title: s.name + ' Meteor Shower', desc: 'Active period with peak around ' + s.peak + '. Best viewed after midnight in dark skies.' })),
    { icon:'🌌', title:'Milky Way Core', desc: month >= 3 && month <= 9 ? 'Milky Way core is well-placed tonight — best visibility after midnight.' : 'Milky Way core below horizon. Good time for deep-sky objects.' },
    { icon:'🔭', title:'ISS Passes', desc: 'The ISS makes multiple visible passes each night. Check heavens-above.com for precise times at your location.' },
  ];
  const el = document.getElementById('astro-events-list');
  if (!el) return;
  el.innerHTML = events.map(e =>
    '<div class="astro-event-item"><div class="astro-event-icon">' + e.icon + '</div>' +
    '<div><div class="astro-event-title">' + e.title + '</div>' +
    '<div class="astro-event-desc">' + e.desc + '</div></div></div>'
  ).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No major events this month</div>';
}
