// ── Astronomy tab ──────────────────────────────────────────────────────────────
let astroLoaded = false, astroLat = null, astroLng = null;
let issTimer = null, lastSunData = null, ssZoom = 'outer';
let _ssPlanets = []; // screen positions for hover

// ── Init ───────────────────────────────────────────────────────────────────────
function astroInit() {
  if (astroLoaded) { _redrawCanvases(); return; }
  astroLoaded = true;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { astroLat = pos.coords.latitude; astroLng = pos.coords.longitude;
        document.getElementById('astro-location').textContent = astroLat.toFixed(2) + '°, ' + astroLng.toFixed(2) + '°';
        _loadAll(); },
      ()  => { astroLat = -26.2; astroLng = 28.0;
        document.getElementById('astro-location').textContent = 'Default (Johannesburg)';
        _loadAll(); }
    );
  } else {
    astroLat = -26.2; astroLng = 28.0;
    document.getElementById('astro-location').textContent = 'Geolocation unavailable';
    _loadAll();
  }
  // Solar system doesn't need location — draw immediately
  drawSolarSystem();
  _initSSHover();
  // Redraw solar system canvases on resize
  window.addEventListener('resize', () => { drawSolarSystem(); if (lastSunData) _drawSunArc(...lastSunData); drawStationMap(); });
}

function astroRefresh() { _loadAll(); drawSolarSystem(); }

function _loadAll() {
  astroLoadSun();
  astroCalcMoon();
  astroCalcPlanets();
  astroLoadISS();
  astroGenEvents();
}

function _redrawCanvases() {
  drawSolarSystem();
  if (lastSunData) _drawSunArc(...lastSunData);
  drawStationMap();
}

// ── Solar System ────────────────────────────────────────────────────────────────
const SS_PLANETS = [
  { name:'Mercury', sym:'☿', col:'#a8a8a8', sz:3,  a:0.387, e:0.206, L0:252.25, Ldot:149474.07, w0:77.46  },
  { name:'Venus',   sym:'♀', col:'#e8d48b', sz:5,  a:0.723, e:0.007, L0:181.98, Ldot:58519.21,  w0:131.56 },
  { name:'Earth',   sym:'🌍', col:'#4fa3e0', sz:5,  a:1.000, e:0.017, L0:100.46, Ldot:35999.37,  w0:102.94 },
  { name:'Mars',    sym:'♂', col:'#c1440e', sz:4,  a:1.524, e:0.093, L0:355.43, Ldot:19141.70,  w0:336.08 },
  { name:'Jupiter', sym:'♃', col:'#c88b3a', sz:9,  a:5.203, e:0.049, L0:34.40,  Ldot:3036.30,   w0:14.33  },
  { name:'Saturn',  sym:'♄', col:'#ead39c', sz:7,  a:9.537, e:0.056, L0:49.94,  Ldot:1223.51,   w0:92.86, ring:true },
  { name:'Uranus',  sym:'♅', col:'#7de8e4', sz:6,  a:19.19, e:0.047, L0:313.23, Ldot:428.48,    w0:172.43 },
  { name:'Neptune', sym:'♆', col:'#3f54ba', sz:6,  a:30.07, e:0.010, L0:304.88, Ldot:218.49,    w0:46.68  },
];

function _ssRand(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function _calcJT() {
  const n = new Date();
  return (367*n.getFullYear() - Math.floor(7*(n.getFullYear()+Math.floor((n.getMonth()+10)/12))/4)
    + Math.floor(275*(n.getMonth()+1)/9) + n.getDate() + 1721013.5
    + (n.getHours()+n.getMinutes()/60+n.getSeconds()/3600)/24 - 2451545) / 36525;
}

function _calcPlanetPos(p, T) {
  const R = d => d * Math.PI / 180;
  const L = ((p.L0 + p.Ldot * T / 100) % 360 + 360) % 360;
  let M = R(((L - p.w0) % 360 + 360) % 360);
  let E = M;
  for (let i = 0; i < 8; i++) E = M + p.e * Math.sin(E);
  const v = 2 * Math.atan2(Math.sqrt(1+p.e)*Math.sin(E/2), Math.sqrt(1-p.e)*Math.cos(E/2));
  const r = p.a * (1 - p.e * Math.cos(E));
  const lon = R(p.w0) + v;
  return { x: r*Math.cos(lon), y: r*Math.sin(lon), r, lonDeg: (lon*180/Math.PI + 360) % 360 };
}

function ssSetZoom(z) {
  ssZoom = z;
  document.getElementById('ss-btn-outer').classList.toggle('on', z === 'outer');
  document.getElementById('ss-btn-inner').classList.toggle('on', z === 'inner');
  drawSolarSystem();
}

function drawSolarSystem() {
  const canvas = document.getElementById('ss-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  if (!W) return; // not visible yet — will redraw on resize
  const H = W;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const cx = W/2, cy = H/2;
  const maxAU = ssZoom === 'inner' ? 1.85 : 32;
  const maxPx = W/2 - 28;

  const auPx = au => {
    if (ssZoom === 'inner') return maxPx * au / maxAU;
    return maxPx * Math.log(1 + au * 1.9) / Math.log(1 + maxAU * 1.9);
  };

  // Background
  ctx.fillStyle = '#040a18'; ctx.fillRect(0, 0, W, H);

  // Stars (deterministic)
  const rand = _ssRand(98765);
  for (let i = 0; i < 350; i++) {
    const x = rand()*W, y = rand()*H, a = 0.1 + rand()*0.75;
    const sz = rand() < 0.06 ? 1.5 : 0.8;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
    ctx.fillRect(x, y, sz, sz);
  }

  // Asteroid belt (outer view)
  if (ssZoom === 'outer') {
    const b1 = auPx(2.2), b2 = auPx(3.2);
    const bg = ctx.createRadialGradient(cx,cy,b1, cx,cy,b2);
    bg.addColorStop(0, 'rgba(90,70,30,0)');
    bg.addColorStop(0.5, 'rgba(90,70,30,.12)');
    bg.addColorStop(1, 'rgba(90,70,30,0)');
    ctx.beginPath(); ctx.fillStyle = bg;
    ctx.arc(cx,cy,b2,0,Math.PI*2); ctx.arc(cx,cy,b1,0,Math.PI*2,true);
    ctx.fill();
  }

  const T = _calcJT();
  const planets = ssZoom === 'inner' ? SS_PLANETS.slice(0,4) : SS_PLANETS;
  _ssPlanets = [];

  // Orbit rings
  planets.forEach(p => {
    ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=1;
    ctx.arc(cx, cy, auPx(p.a), 0, Math.PI*2); ctx.stroke();
  });

  // Planets
  planets.forEach(p => {
    const pos = _calcPlanetPos(p, T);
    const px = cx + auPx(pos.x), py = cy - auPx(pos.y);
    _ssPlanets.push({ ...p, px, py, au: pos.r });

    // Saturn rings
    if (p.ring && ssZoom !== 'inner') {
      ctx.save(); ctx.translate(px, py); ctx.scale(1, 0.28);
      ctx.beginPath(); ctx.strokeStyle = p.col + '90'; ctx.lineWidth = ssZoom==='outer' ? 4 : 2;
      ctx.arc(0, 0, p.sz + 7, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }

    // Glow + planet
    ctx.shadowColor = p.col; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.fillStyle = p.col;
    ctx.arc(px, py, p.sz, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;

    // Label
    ctx.save(); ctx.fillStyle='rgba(255,255,255,.55)';
    const fSize = ssZoom==='inner' ? 11 : 10;
    ctx.font = fSize + 'px system-ui'; ctx.textAlign='center';
    ctx.fillText(p.name, px, py - p.sz - 5); ctx.restore();
  });

  // Sun corona glow
  const sg = ctx.createRadialGradient(cx,cy,0, cx,cy,30);
  sg.addColorStop(0, 'rgba(255,250,200,1)');
  sg.addColorStop(0.25, 'rgba(255,200,0,1)');
  sg.addColorStop(0.6, 'rgba(255,120,0,.6)');
  sg.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.beginPath(); ctx.fillStyle = sg;
  ctx.shadowColor='#ffd700'; ctx.shadowBlur=40;
  ctx.arc(cx, cy, 12, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='rgba(255,255,255,.4)'; ctx.font='10px system-ui'; ctx.textAlign='center';
  ctx.fillText('Sun', cx, cy + 24);

  // Legend + date
  const leg = document.getElementById('ss-legend');
  if (leg) leg.innerHTML = _ssPlanets.map(p =>
    '<div class="ss-leg-item"><span class="ss-leg-dot" style="background:'+p.col+'"></span>'+p.name+'</div>'
  ).join('');
  const dateEl = document.getElementById('ss-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString([],{weekday:'short',year:'numeric',month:'short',day:'numeric'});
}

function _initSSHover() {
  const canvas = document.getElementById('ss-canvas');
  if (!canvas) return;
  const tip = document.getElementById('ss-tooltip');
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = _ssPlanets.find(p => Math.hypot(p.px-mx, p.py-my) < p.sz + 10);
    if (hit) {
      canvas.style.cursor = 'pointer';
      if (tip) {
        tip.style.display = '';
        tip.style.left = (mx + 14) + 'px';
        tip.style.top  = (my - 10) + 'px';
        tip.innerHTML = '<strong>' + hit.sym + ' ' + hit.name + '</strong><br>' +
          hit.au.toFixed(3) + ' AU from Sun<br>' +
          (hit.ring ? '⭕ Has rings' : '');
      }
    } else {
      canvas.style.cursor = 'crosshair';
      if (tip) tip.style.display = 'none';
    }
  });
  canvas.addEventListener('mouseleave', () => { if (tip) tip.style.display='none'; });
}

// ── Space Stations ─────────────────────────────────────────────────────────────
let _issData = null, _cssData = null;

async function astroLoadISS() {
  try {
    const r = await fetch('/api/iss?device=' + deviceId);
    const d = await r.json();
    _issData = d.iss || null;
    _cssData = d.css || null;
    _renderStation('iss', _issData);
    _renderStation('css', _cssData);
    drawStationMap();
    _checkOverhead();
    if (issTimer) clearTimeout(issTimer);
    issTimer = setTimeout(astroLoadISS, 5000);
  } catch { /* retry */ issTimer = setTimeout(astroLoadISS, 8000); }
}

function _renderStation(id, d) {
  if (!d) return;
  const fmtLat = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '°';
  const fmtLng = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '°';
  const vis = d.visibility || 'unknown';
  const badge = document.getElementById(id === 'iss' ? 'iss-vis' : 'css-vis');
  if (badge) { badge.textContent = vis; badge.className = 'station-badge ' + (vis === 'daylight' ? 'daylight' : vis === 'eclipsed' ? 'eclipsed' : vis.includes('twilight') ? 'twilight' : 'unknown'); }
  _setText(id+'-lat', fmtLat(d.latitude));
  _setText(id+'-lng', fmtLng(d.longitude));
  _setText(id+'-alt', (d.altitude ? d.altitude.toFixed(1) + ' km' : '~408 km'));
  _setText(id+'-vel', (d.velocity ? Math.round(d.velocity).toLocaleString() + ' km/h' : '~27,600 km/h'));
}

function _setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

// ── Station world map ─────────────────────────────────────────────────────────
// Simplified continental outlines [lon, lat] arrays
const CONTINENTS = [
  // Africa
  [[32,-28],[28,-34],[18,-34],[12,-17],[-1,5],[15,4],[22,4],[26,-5],[36,-5],[42,5],[44,12],[43,15],[38,22],[32,30],[25,37],[10,38],[5,35],[-3,37],[-6,34],[-14,10],[-17,5],[-17,15],[-10,25],[5,32],[15,28],[25,20],[33,12]],
  // Europe (simplified)
  [[-10,36],[-5,36],[0,39],[3,44],[8,44],[15,47],[25,46],[30,45],[32,42],[28,38],[24,38],[20,40],[16,40],[14,38],[8,38],[3,43],[-2,44],[-7,44],[-8,40],[-10,36]],
  // Asia (very simplified)
  [[32,42],[42,42],[60,44],[80,44],[100,50],[120,52],[134,48],[140,42],[140,36],[130,34],[120,26],[108,18],[104,10],[102,4],[104,2],[100,-2],[110,-8],[120,-10],[125,-8],[130,0],[135,8],[120,20],[110,20],[100,25],[90,28],[80,32],[70,26],[60,22],[52,16],[44,12],[42,12],[36,12],[36,18],[42,22],[38,30],[35,36],[32,42]],
  // North America
  [[-70,45],[-60,46],[-64,50],[-70,55],[-80,62],[-90,65],[-100,68],[-120,68],[-140,60],[-155,58],[-160,60],[-165,62],[-168,66],[-160,66],[-140,70],[-120,70],[-105,72],[-85,70],[-80,64],[-82,58],[-88,56],[-90,50],[-85,46],[-82,42],[-76,44],[-72,44],[-70,43],[-65,44],[-60,46]],
  // South America
  [[-68,-54],[-65,-50],[-60,-52],[-48,-28],[-40,-20],[-34,-8],[-36,0],[-50,0],[-60,-5],[-70,-12],[-76,-10],[-80,-2],[-78,2],[-76,6],[-70,12],[-62,12],[-58,6],[-50,-2],[-48,-6],[-38,-14],[-36,-22],[-46,-24],[-50,-30],[-52,-34],[-56,-38],[-62,-42],[-68,-46],[-68,-54]],
  // Australia
  [[114,-22],[118,-34],[122,-34],[130,-32],[138,-36],[145,-38],[148,-42],[148,-38],[152,-28],[152,-22],[145,-16],[138,-12],[132,-12],[126,-14],[118,-22],[114,-22]],
  // Greenland (mini)
  [[-22,83],[-14,82],[-10,76],[-18,72],[-28,70],[-36,65],[-42,65],[-48,68],[-54,70],[-52,76],[-44,82],[-30,84],[-22,83]],
];

function drawStationMap() {
  const canvas = document.getElementById('station-map');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 500, H = 180;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  // Background ocean
  ctx.fillStyle = '#06101e'; ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 0.5;
  for (let lon = -180; lon <= 180; lon += 30) { const x = (lon+180)/360*W; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let lat = -90; lat <= 90; lat += 30)  { const y = (90-lat)/180*H;   ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y);  ctx.stroke(); }
  // Equator highlight
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  // Tropics
  ctx.strokeStyle = 'rgba(255,200,0,.07)'; ctx.lineWidth = .5;
  [23.5, -23.5].forEach(lat => { const y=(90-lat)/180*H; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); });

  // Continents
  ctx.fillStyle = 'rgba(60,90,60,.55)';
  ctx.strokeStyle = 'rgba(80,120,80,.3)'; ctx.lineWidth = 0.5;
  CONTINENTS.forEach(poly => {
    ctx.beginPath();
    poly.forEach(([lon,lat],i) => {
      const x=(lon+180)/360*W, y=(90-lat)/180*H;
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  });

  // ISS track (ground track approx — draw trailing arc)
  if (_issData) {
    const lat = _issData.latitude, lng = _issData.longitude;
    const x = (lng+180)/360*W, y = (90-lat)/180*H;
    ctx.beginPath(); ctx.fillStyle='#a78bfa'; ctx.shadowColor='#a78bfa'; ctx.shadowBlur=8;
    ctx.arc(x,y,5,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    // Label
    ctx.fillStyle='rgba(167,139,250,.9)'; ctx.font='10px system-ui'; ctx.textAlign='left';
    ctx.fillText('ISS', Math.min(x+8, W-28), y-4);
  }

  // CSS (Tiangong)
  if (_cssData) {
    const lat = _cssData.latitude, lng = _cssData.longitude;
    const x = (lng+180)/360*W, y = (90-lat)/180*H;
    ctx.beginPath(); ctx.fillStyle='#f59e0b'; ctx.shadowColor='#f59e0b'; ctx.shadowBlur=8;
    ctx.arc(x,y,5,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    ctx.fillStyle='rgba(245,158,11,.9)'; ctx.font='10px system-ui'; ctx.textAlign='left';
    ctx.fillText('CSS', Math.min(x+8, W-28), y-4);
  }

  // User location
  if (astroLat !== null) {
    const x=(astroLng+180)/360*W, y=(90-astroLat)/180*H;
    ctx.beginPath(); ctx.fillStyle='#34d399'; ctx.shadowColor='#34d399'; ctx.shadowBlur=6;
    ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
  }
}

function _checkOverhead() {
  const el = document.getElementById('station-overhead');
  if (!el || astroLat===null) return;
  const msgs = [];
  if (_issData) {
    const d = _distKm(astroLat, astroLng, _issData.latitude, _issData.longitude);
    msgs.push('ISS is ' + _fmtDist(d) + ' from your location' + (d < 1000 ? ' 🟢' : ''));
  }
  if (_cssData) {
    const d = _distKm(astroLat, astroLng, _cssData.latitude, _cssData.longitude);
    msgs.push('Tiangong is ' + _fmtDist(d) + ' away' + (d < 1000 ? ' 🟢' : ''));
  }
  el.textContent = msgs.join('  ·  ');
}

function _distKm(la1, lo1, la2, lo2) {
  const R=6371, dLat=(la2-la1)*Math.PI/180, dLon=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function _fmtDist(km) { return km>=1000 ? Math.round(km/100)/10+'k km' : Math.round(km)+' km'; }

// ── Sun ────────────────────────────────────────────────────────────────────────
async function astroLoadSun() {
  try {
    const r = await fetch('/api/sunrise?lat='+astroLat+'&lng='+astroLng+'&device='+deviceId);
    const d = await r.json();
    const s = d.results;
    if (!s) return;
    const fmt = iso => new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const fmtLen = sec => Math.floor(sec/3600)+'h '+Math.floor((sec%3600)/60)+'m';
    _setText('sun-rise', fmt(s.sunrise));
    _setText('sun-noon', fmt(s.solar_noon));
    _setText('sun-set',  fmt(s.sunset));
    _setText('sun-len',  fmtLen(s.day_length));
    _setText('sun-dawn', fmt(s.civil_twilight_begin || s.astronomical_twilight_begin));
    _setText('sun-dusk', fmt(s.civil_twilight_end   || s.astronomical_twilight_end));
    lastSunData = [new Date(s.sunrise), new Date(s.sunset), new Date(s.solar_noon)];
    _drawSunArc(...lastSunData);
  } catch {}
}

function _drawSunArc(rise, set, noon) {
  const canvas = document.getElementById('sun-arc');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  if (!W) return;
  const H = 100;
  canvas.width = W*dpr; canvas.height = H*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const now = new Date();
  const riseMs=rise.getTime(), setMs=set.getTime(), nowMs=now.getTime();
  const frac = Math.max(0, Math.min(1, (nowMs-riseMs)/(setMs-riseMs)));

  const cx=W/2, cy=H+8, rx=W/2-18, ry=H-12;
  const angle = t => Math.PI + t*Math.PI;

  // Dusk/dawn gradient sky
  const skyG = ctx.createLinearGradient(0,0,W,0);
  skyG.addColorStop(0,'rgba(255,120,30,.06)');
  skyG.addColorStop(0.5,'rgba(100,160,255,.04)');
  skyG.addColorStop(1,'rgba(255,120,30,.06)');
  ctx.fillStyle=skyG; ctx.fillRect(0,0,W,H);

  // Background arc
  ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=3;
  ctx.ellipse(cx,cy,rx,ry,0,Math.PI,0); ctx.stroke();

  // Progress arc
  if (frac > 0) {
    const g = ctx.createLinearGradient(-rx+cx,0,rx+cx,0);
    g.addColorStop(0,'#f97316'); g.addColorStop(0.5,'#ffd700'); g.addColorStop(1,'#f97316');
    ctx.beginPath(); ctx.strokeStyle=g; ctx.lineWidth=3;
    ctx.ellipse(cx,cy,rx,ry,0,Math.PI,angle(frac)); ctx.stroke();
  }

  // Sun dot
  const sa=angle(frac), sx=cx+Math.cos(sa)*rx, sy=cy+Math.sin(sa)*ry;
  const sg=ctx.createRadialGradient(sx,sy,0,sx,sy,9);
  sg.addColorStop(0,'#fffbe0'); sg.addColorStop(0.4,'#ffd700'); sg.addColorStop(1,'rgba(255,150,0,0)');
  ctx.beginPath(); ctx.fillStyle=sg; ctx.shadowColor='#ffd700'; ctx.shadowBlur=16;
  ctx.arc(sx,sy,8,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;

  // Horizon labels
  ctx.fillStyle='rgba(255,255,255,.28)'; ctx.font='10px system-ui'; ctx.textAlign='center';
  ctx.fillText(rise.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), 18, H-2);
  ctx.fillText(set.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), W-18, H-2);
  ctx.fillText(noon.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), cx, H-2);
  // Now label above sun
  ctx.fillStyle='rgba(255,220,80,.8)'; ctx.fillText(now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), Math.max(18, Math.min(W-18, sx)), Math.max(10, sy-14));
}

// ── Moon ───────────────────────────────────────────────────────────────────────
function astroCalcMoon() {
  const now = new Date();
  const jd = _jd(now);
  const SYNODIC = 29.53058867;
  const knownNew = 2451549.5 + 0.5*SYNODIC;
  const age = ((jd - knownNew) % SYNODIC + SYNODIC) % SYNODIC;
  const illum = 0.5 * (1 - Math.cos(2*Math.PI*age/SYNODIC));

  const phases = [
    {max:1.0, n:'New Moon',        e:'🌑'},
    {max:7.4, n:'Waxing Crescent', e:'🌒'},
    {max:9.0, n:'First Quarter',   e:'🌓'},
    {max:14.8,n:'Waxing Gibbous',  e:'🌔'},
    {max:16.6,n:'Full Moon',       e:'🌕'},
    {max:22.2,n:'Waning Gibbous',  e:'🌖'},
    {max:24.0,n:'Last Quarter',    e:'🌗'},
    {max:29.5,n:'Waning Crescent', e:'🌘'},
  ];
  const ph = phases.find(p => age < p.max) || phases[phases.length-1];
  const nextFull = age < SYNODIC/2 ? SYNODIC/2 - age : SYNODIC*1.5 - age;
  const nextNew  = SYNODIC - age;

  _setText('moon-phase', ph.n);
  _setText('moon-illum', Math.round(illum*100) + '% illuminated');
  _setText('moon-age',   'Age: ' + age.toFixed(1) + ' days');
  _setText('moon-next',  'Full moon in ' + nextFull.toFixed(1) + 'd · New moon in ' + nextNew.toFixed(1) + 'd');

  _drawMoon(illum, age < SYNODIC/2);
  _buildLunarCalendar(now, SYNODIC, knownNew);
}

function _drawMoon(illum, waxing) {
  const canvas = document.getElementById('moon-canvas');
  if (!canvas) return;
  const W=110, H=110, r=50, cx=W/2, cy=H/2;
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);

  // Outer glow
  const glow=ctx.createRadialGradient(cx,cy,r-4,cx,cy,r+8);
  glow.addColorStop(0,'rgba(200,200,180,.12)'); glow.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.fillStyle=glow; ctx.arc(cx,cy,r+8,0,Math.PI*2); ctx.fill();

  // Dark side (full circle)
  ctx.beginPath(); ctx.fillStyle='#1a1a2e';
  ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();

  // Terminator: right half lit if waxing, left half if waning
  // We clip to right/left semi-circle and draw lit ellipse
  ctx.save();
  if (waxing) {
    // Right half is lit
    ctx.beginPath(); ctx.rect(cx, cy-r-1, r+1, (r+1)*2); ctx.clip();
  } else {
    ctx.beginPath(); ctx.rect(cx-r-1, cy-r-1, r+1, (r+1)*2); ctx.clip();
  }
  // Lit ellipse: x-scale goes from 0 (quarter) to r (full)
  const xScale = Math.abs(Math.cos(Math.PI * illum));
  ctx.beginPath();
  const litGrad = ctx.createRadialGradient(cx-5, cy-10, 0, cx, cy, r);
  litGrad.addColorStop(0, '#fff8e8'); litGrad.addColorStop(0.5,'#e8d8c0'); litGrad.addColorStop(1,'#b8a890');
  ctx.fillStyle = litGrad;
  ctx.ellipse(cx, cy, r * (1 - xScale), r, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();

  // Craters (subtle)
  ctx.fillStyle='rgba(0,0,0,.12)';
  [[cx+14,cy-10,6],[cx-12,cy+14,4],[cx+4,cy+6,5],[cx-8,cy-16,3]].forEach(([x,y,rr]) => {
    ctx.beginPath(); ctx.arc(x,y,rr,0,Math.PI*2); ctx.fill();
  });

  // Limb darkening ring
  const limb=ctx.createRadialGradient(cx,cy,r*0.75,cx,cy,r);
  limb.addColorStop(0,'rgba(0,0,0,0)'); limb.addColorStop(1,'rgba(0,0,0,.35)');
  ctx.beginPath(); ctx.fillStyle=limb; ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
}

function _buildLunarCalendar(today, synodic, knownNew) {
  const el = document.getElementById('moon-cal');
  if (!el) return;
  const year=today.getFullYear(), month=today.getMonth();
  const daysInMonth = new Date(year,month+1,0).getDate();
  const firstDow = new Date(year,month,1).getDay(); // 0=Sun
  const DOWS = ['S','M','T','W','T','F','S'];
  let html = DOWS.map(d => '<div class="moon-cal-dow">'+d+'</div>').join('');
  // Empty cells before 1st
  for (let i=0; i<firstDow; i++) html += '<div class="moon-cal-day other-month"></div>';
  for (let day=1; day<=daysInMonth; day++) {
    const d = new Date(year,month,day,12,0,0);
    const jd = _jd(d);
    const age = ((jd-knownNew) % synodic + synodic) % synodic;
    const illum = 0.5*(1-Math.cos(2*Math.PI*age/synodic));
    const emoji = age<1?'🌑':age<7.4?'🌒':age<9?'🌓':age<14.8?'🌔':age<16.6?'🌕':age<22.2?'🌖':age<24?'🌗':'🌘';
    const isToday = day===today.getDate();
    html += '<div class="moon-cal-day'+(isToday?' today':'')+'"><span class="mc-emoji">'+emoji+'</span><span class="mc-num">'+day+'</span></div>';
  }
  el.innerHTML = html;
}

function _jd(date) {
  const y=date.getFullYear(), m=date.getMonth()+1, d=date.getDate();
  const h=date.getHours()+date.getMinutes()/60+date.getSeconds()/3600;
  return 367*y - Math.floor(7*(y+Math.floor((m+9)/12))/4) + Math.floor(275*m/9) + d + 1721013.5 + h/24;
}

// ── Planets ────────────────────────────────────────────────────────────────────
function astroCalcPlanets() {
  const T = _calcJT();
  const toR = d => d*Math.PI/180;
  const sunLon = ((280.46646 + 36000.76983*T) % 360 + 360) % 360;

  // Calculate Earth's position for distance calculations
  const earthPos = _calcPlanetPos(SS_PLANETS[2], T);

  const results = SS_PLANETS.map(p => {
    const pos = _calcPlanetPos(p, T);
    // Distance from Earth (AU)
    const dAU = p.name==='Earth' ? 0 : Math.hypot(pos.x-earthPos.x, pos.y-earthPos.y);
    // Elongation from Sun (angular separation as seen from Earth)
    const elongDeg = ((pos.lonDeg - sunLon + 360) % 360);
    // Very rough altitude above horizon (max 90 when at best elongation from Sun)
    let alt = p.name==='Earth' ? 0 : Math.sin(toR(Math.min(elongDeg, 360-elongDeg)));
    alt = Math.round(alt * 70); // scale to degrees
    const visible = alt > 8;
    const low     = alt >= 0 && alt <= 8;
    return { ...p, dAU, alt, visible, low, elongDeg };
  }).filter(p => p.name !== 'Earth');

  const grid = document.getElementById('planets-grid');
  if (!grid) return;
  grid.innerHTML = results.map(p => {
    const badgeCls = p.visible ? 'vis' : p.low ? 'low' : 'hid';
    const badgeTxt = p.visible ? 'Visible' : p.low ? 'Low' : 'Below horizon';
    const altStr = (p.alt >= 0 ? '+' : '') + p.alt + '°';
    const distStr = p.dAU < 2 ? p.dAU.toFixed(3) + ' AU' : p.dAU.toFixed(2) + ' AU';
    return '<div class="planet-card">' +
      '<div class="planet-name">' + p.sym + ' ' + p.name +
        '<span class="planet-badge '+badgeCls+'">'+badgeTxt+'</span></div>' +
      '<div class="planet-alt">~' + altStr + ' altitude</div>' +
      '<div class="planet-dist">' + distStr + ' from Earth</div>' +
      '<div class="planet-mag">Mag ' + p.sz + '</div>' +
      '</div>';
  }).join('');
}

// ── Sky Events ─────────────────────────────────────────────────────────────────
function astroGenEvents() {
  const now = new Date(), m = now.getMonth();
  const SHOWERS = [
    {months:[0],    n:'Quadrantids',   peak:'Jan 3–4',   zhr:'~120'},
    {months:[3],    n:'Lyrids',        peak:'Apr 22',    zhr:'~18'},
    {months:[4],    n:'Eta Aquariids', peak:'May 5–6',   zhr:'~50'},
    {months:[6],    n:'Delta Aquariids',peak:'Jul 28',   zhr:'~25'},
    {months:[7],    n:'Perseids',      peak:'Aug 11–13', zhr:'~100'},
    {months:[9],    n:'Orionids',      peak:'Oct 21',    zhr:'~25'},
    {months:[10],   n:'Leonids',       peak:'Nov 17–18', zhr:'~15'},
    {months:[11],   n:'Geminids',      peak:'Dec 13–14', zhr:'~150'},
    {months:[11],   n:'Ursids',        peak:'Dec 22',    zhr:'~10'},
  ];
  const upcoming = SHOWERS.filter(s => s.months.some(sm => Math.abs(sm-m)<=1));
  const milkyWay = m>=3 && m<=9;
  const events = [
    ...upcoming.map(s => ({ icon:'🌠', title:s.n+' Meteor Shower', desc:'Peak: '+s.peak+' · Max ~'+s.zhr+'/hr. Best viewed after midnight in dark skies, away from light pollution.' })),
    { icon:'🌌', title:'Milky Way', desc: milkyWay ? 'Galactic core well-placed — best visibility 10pm–3am in a dark location.' : 'Core below horizon this time of year. Good season for deep-sky objects like Orion Nebula.' },
    { icon:'🔭', title:'ISS Passes', desc:'ISS completes ~16 orbits per day. Check Heavens-Above for precise pass times at your location.' },
    { icon:'🌍', title:'Earthshine', desc:'Look for the faint glow on the dark limb of a crescent moon — that\'s sunlight reflected off Earth illuminating the lunar surface.' },
    { icon:'🪐', title:'Saturn\'s Rings', desc:'Saturn\'s rings are tilted ~27° toward Earth in 2026 — great time for backyard telescope views.' },
  ];
  const el = document.getElementById('astro-events-list');
  if (!el) return;
  el.innerHTML = events.map(e =>
    '<div class="astro-event-item"><div class="astro-event-icon">'+e.icon+'</div>' +
    '<div class="astro-event-body"><div class="title">'+e.title+'</div><div class="desc">'+e.desc+'</div></div></div>'
  ).join('');
}
