// ── Astronomy tab ──────────────────────────────────────────────────────────────
let astroLoaded = false, astroLat = null, astroLng = null;
let issTimer = null, lastSunData = null;
let _issData = null, _cssData = null;

// ── Init ───────────────────────────────────────────────────────────────────────
function astroInit() {
  if (astroLoaded) { _redrawStatic(); return; }
  astroLoaded = true;

  astroCalcMoon();
  astroCalcPlanets();
  astroLoadISS();
  astroGenEvents();

  let geoSettled = false;
  const _onGeo = (lat, lng, label) => {
    if (geoSettled) return; geoSettled = true;
    astroLat = lat; astroLng = lng;
    _setText('astro-location', label);
    astroLoadSun();
    drawStationMap();
  };
  if (navigator.geolocation) {
    const timer = setTimeout(() => _onGeo(-26.2, 28.0, 'Default (Johannesburg)'), 8000);
    navigator.geolocation.getCurrentPosition(
      p => { clearTimeout(timer); _onGeo(p.coords.latitude, p.coords.longitude, p.coords.latitude.toFixed(2)+'°, '+p.coords.longitude.toFixed(2)+'°'); },
      ()  => { clearTimeout(timer); _onGeo(-26.2, 28.0, 'Default (Johannesburg)'); }
    );
  } else { _onGeo(-26.2, 28.0, 'No geolocation'); }

  _ss3dStart();
  window.addEventListener('resize', () => { _redrawStatic(); });
}

function astroRefresh() {
  astroCalcMoon(); astroCalcPlanets(); astroLoadISS(); astroGenEvents();
  if (astroLat !== null) { astroLoadSun(); drawStationMap(); }
}
function _redrawStatic() { if (lastSunData) _drawSunArc(...lastSunData); drawStationMap(); }
function _setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

// ══════════════════════════════════════════════════════════════════════════════
// SOLAR SYSTEM DATA
// ══════════════════════════════════════════════════════════════════════════════
const SS_PLANETS = [
  { n:'Mercury', col:'#a8a8a8', sz:.18, a:.387,  e:.206, L0:252.25, Ld:149474.07, w0:77.46  },
  { n:'Venus',   col:'#e8d48b', sz:.32, a:.723,  e:.007, L0:181.98, Ld:58519.21,  w0:131.56 },
  { n:'Earth',   col:'#4fa3e0', sz:.36, a:1.000, e:.017, L0:100.46, Ld:35999.37,  w0:102.94 },
  { n:'Mars',    col:'#c1440e', sz:.22, a:1.524, e:.093, L0:355.43, Ld:19141.70,  w0:336.08 },
  { n:'Jupiter', col:'#c88b3a', sz:.85, a:5.203, e:.049, L0:34.40,  Ld:3036.30,   w0:14.33  },
  { n:'Saturn',  col:'#ead39c', sz:.70, a:9.537, e:.056, L0:49.94,  Ld:1223.51,   w0:92.86, ring:true },
  { n:'Uranus',  col:'#7de8e4', sz:.52, a:19.19, e:.047, L0:313.23, Ld:428.48,    w0:172.43 },
  { n:'Neptune', col:'#3f54ba', sz:.48, a:30.07, e:.010, L0:304.88, Ld:218.49,    w0:46.68  },
];
const VOYAGERS = [
  { n:'Voyager 1', col:'#ff88cc', au:166, u:[-0.184,-0.793, 0.579] },
  { n:'Voyager 2', col:'#88ffcc', au:139, u:[ 0.359,-0.736,-0.573] },
];

function _auTo3D(au) { return 55 * Math.log(1+au) / Math.log(201); }
function _rng(seed) { let s=seed; return () => { s=(s*16807)%2147483647; return (s-1)/2147483646; }; }

function _calcT(extraDays=0) {
  const n = new Date(Date.now()+extraDays*86400000);
  return (367*n.getFullYear()-Math.floor(7*(n.getFullYear()+Math.floor((n.getMonth()+10)/12))/4)
    +Math.floor(275*(n.getMonth()+1)/9)+n.getDate()+1721013.5
    +(n.getHours()+n.getMinutes()/60+n.getSeconds()/3600)/24-2451545)/36525;
}

function _planetXYZ(p, T) {
  const R = d => d*Math.PI/180;
  const L = ((p.L0+p.Ld*T/100)%360+360)%360;
  let M = R(((L-p.w0)%360+360)%360), E = M;
  for (let i=0; i<8; i++) E = M+p.e*Math.sin(E);
  const v = 2*Math.atan2(Math.sqrt(1+p.e)*Math.sin(E/2), Math.sqrt(1-p.e)*Math.cos(E/2));
  const r = p.a*(1-p.e*Math.cos(E)), lon = R(p.w0)+v, d = _auTo3D(r);
  return [d*Math.cos(lon), 0, -d*Math.sin(lon)];
}

// ══════════════════════════════════════════════════════════════════════════════
// PURE CANVAS 2D 3D SOLAR SYSTEM (no CDN dependencies)
// ══════════════════════════════════════════════════════════════════════════════
let _cam = { theta:-0.5, phi:0.82, r:90 };
let _ssSimDays = 0, _ssSimSpeed = 10, _ssLastMs = 0, _ssRaf = null;
let _ssShowOrbits = true, _ssShowLabels = true;
let _ssPickObjs = [];
let _ssBeltPts = null, _ssKuiperPts = null; // pre-computed random point clouds
let _ssDragging = false, _ssDragLast = { x:0, y:0 };
let _ssW = 0, _ssH = 420;

function _proj(x, y, z) {
  const ct=Math.cos(_cam.theta), st=Math.sin(_cam.theta);
  const cp=Math.cos(_cam.phi),   sp=Math.sin(_cam.phi);
  const x1=x*ct-z*st, z1=x*st+z*ct;
  const y2=y*cp-z1*sp, z2=y*sp+z1*cp;
  const depth=z2+_cam.r;
  if (depth<0.5) return null;
  const sc=(_ssW*0.40)/depth;
  return { sx:_ssW/2+x1*sc, sy:_ssH/2-y2*sc, z:z2, sc };
}

function _hexShift(hex, d) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  const c=v=>Math.max(0,Math.min(255,v+d));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function _ss3dStart() {
  const canvas = document.getElementById('ss3d-canvas');
  if (!canvas) return;
  if (canvas.offsetWidth === 0) { requestAnimationFrame(_ss3dStart); return; }
  if (_ssRaf) return;

  // Pre-compute random point clouds once
  const br = _rng(999);
  _ssBeltPts = [];
  for (let i=0; i<600; i++) {
    const r=_auTo3D(2.2+br()*(3.2-2.2)), a=br()*Math.PI*2, y=(br()-.5)*.5;
    _ssBeltPts.push([r*Math.cos(a), y, r*Math.sin(a)]);
  }
  const kr = _rng(1234);
  _ssKuiperPts = [];
  for (let i=0; i<300; i++) {
    const r=_auTo3D(30+kr()*18), a=kr()*Math.PI*2, y=(kr()-.5)*2;
    _ssKuiperPts.push([r*Math.cos(a), y, r*Math.sin(a)]);
  }

  const loading = document.getElementById('ss3d-loading');
  if (loading) loading.style.display = 'none';

  _initSSControls(canvas);
  _ssLastMs = performance.now();
  _ssRaf = requestAnimationFrame(_ssFrame);
}

function _ssFrame(ts) {
  _ssRaf = requestAnimationFrame(_ssFrame);
  const dt = Math.min((ts-_ssLastMs)/1000, .1); _ssLastMs = ts;
  _ssSimDays += _ssSimSpeed*dt;
  _renderSS();
}

function _renderSS() {
  const canvas = document.getElementById('ss3d-canvas');
  if (!canvas) return;
  const dpr = Math.min(devicePixelRatio||1, 2), W = canvas.offsetWidth, H = 420;
  if (!W) return;
  _ssW = W; _ssH = H;
  if (canvas.width !== Math.round(W*dpr) || canvas.height !== Math.round(H*dpr)) {
    canvas.width = Math.round(W*dpr); canvas.height = Math.round(H*dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background
  ctx.fillStyle = '#020810'; ctx.fillRect(0, 0, W, H);

  // Stars (rotated with camera)
  const sr = _rng(54321);
  for (let i=0; i<700; i++) {
    const r=90+sr()*160, phi=Math.acos(1-2*sr()), th=sr()*Math.PI*2;
    const p = _proj(r*Math.sin(phi)*Math.cos(th), r*Math.cos(phi), r*Math.sin(phi)*Math.sin(th));
    if (!p || p.sx<0 || p.sx>W || p.sy<0 || p.sy>H) continue;
    const a = (0.15+sr()*0.75).toFixed(2);
    ctx.fillStyle = 'rgba(255,255,255,'+a+')';
    ctx.fillRect(p.sx, p.sy, sr()<.04?1.8:.9, sr()<.04?1.8:.9);
  }

  const T = _calcT(_ssSimDays);
  _ssPickObjs = [];

  // ── Orbit rings (always behind) ──────────────────────────────────────────
  if (_ssShowOrbits) {
    SS_PLANETS.forEach(p => {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = .8;
      let first = true;
      for (let i=0; i<=80; i++) {
        const a=i/80*Math.PI*2, d=_auTo3D(p.a);
        const pt = _proj(d*Math.cos(a), 0, -d*Math.sin(a));
        if (!pt) { first=true; continue; }
        first ? (ctx.moveTo(pt.sx,pt.sy), first=false) : ctx.lineTo(pt.sx, pt.sy);
      }
      ctx.stroke();
    });
    // Heliosphere boundary
    ctx.beginPath(); ctx.strokeStyle = 'rgba(40,80,200,.1)'; ctx.lineWidth = .7;
    for (let i=0; i<=60; i++) {
      const a=i/60*Math.PI*2;
      const pt = _proj(53*Math.cos(a), 0, -53*Math.sin(a));
      if (!pt) continue;
      i===0 ? ctx.moveTo(pt.sx,pt.sy) : ctx.lineTo(pt.sx, pt.sy);
    }
    ctx.stroke();
  }

  // ── Asteroid belt ─────────────────────────────────────────────────────────
  if (_ssBeltPts) {
    _ssBeltPts.forEach(([x,y,z]) => {
      const p = _proj(x,y,z); if(!p||p.sx<0||p.sx>W||p.sy<0||p.sy>H) return;
      ctx.fillStyle='rgba(136,119,85,.45)'; ctx.fillRect(p.sx,p.sy,.9,.9);
    });
  }

  // ── Kuiper belt ──────────────────────────────────────────────────────────
  if (_ssKuiperPts) {
    _ssKuiperPts.forEach(([x,y,z]) => {
      const p = _proj(x,y,z); if(!p||p.sx<0||p.sx>W||p.sy<0||p.sy>H) return;
      ctx.fillStyle='rgba(68,102,170,.3)'; ctx.fillRect(p.sx,p.sy,.8,.8);
    });
  }

  // ── Collect sun + planets + voyagers, sort back-to-front ────────────────
  const objs = [];

  // Sun goes in the sort too — so inner planets can appear in front of it
  const sunPt0 = _proj(0, 0, 0);
  if (sunPt0) objs.push({ type:'sun', pt:sunPt0 });

  SS_PLANETS.forEach(p => {
    const [px,py,pz] = _planetXYZ(p, T);
    const pt = _proj(px, py, pz); if (!pt) return;
    objs.push({ type:'planet', p, px, py, pz, pt });
  });
  VOYAGERS.forEach(v => {
    const d=_auTo3D(v.au);
    const [px,py,pz] = [v.u[0]*d, v.u[2]*d, -v.u[1]*d];
    const pt = _proj(px, py, pz); if (!pt) return;
    objs.push({ type:'voyager', v, px, py, pz, pt });
  });
  objs.sort((a,b) => b.pt.z - a.pt.z);

  // ── Draw all objects ──────────────────────────────────────────────────────
  objs.forEach(obj => {
    const { pt } = obj;
    const { sx, sy, sc } = pt;

    if (obj.type === 'sun') {
      // Small, tight sun so inner planets are visible around it
      const r = Math.max(4, Math.min(9, 3.5*sc));
      const gg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r*2.2);
      gg.addColorStop(0,'rgba(255,220,0,.45)'); gg.addColorStop(.5,'rgba(255,130,0,.06)'); gg.addColorStop(1,'rgba(255,80,0,0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sx, sy, r*2.2, 0, Math.PI*2); ctx.fill();
      const ds = ctx.createRadialGradient(sx-r*.3, sy-r*.3, 0, sx, sy, r);
      ds.addColorStop(0,'#fffbe0'); ds.addColorStop(.5,'#ffd700'); ds.addColorStop(1,'#ff8800');
      ctx.shadowColor='#ffd700'; ctx.shadowBlur=14;
      ctx.fillStyle=ds; ctx.beginPath(); ctx.arc(sx,sy,r,0,Math.PI*2); ctx.fill();
      ctx.shadowBlur=0;
      if (_ssShowLabels) {
        ctx.font='10px system-ui'; ctx.textAlign='center'; ctx.textBaseline='bottom';
        ctx.fillStyle='rgba(255,255,255,.4)'; ctx.fillText('Sun',sx,sy-r-4);
      }
      _ssPickObjs.push({ name:'Sun', au:'0 AU', sx, sy, sr:r+8 });

    } else if (obj.type === 'planet') {
      const { p } = obj;
      const r = Math.max(2.5, p.sz*7*sc);

      // Saturn rings (behind planet sphere)
      if (p.ring) {
        const rr = p.sz*19*sc, rw = Math.max(.8, p.sz*5*sc);
        const yF = Math.abs(Math.sin(_cam.phi));
        ctx.strokeStyle = 'rgba(200,175,90,.45)'; ctx.lineWidth = rw;
        ctx.beginPath(); ctx.ellipse(sx, sy, rr, rr*yF, 0, 0, Math.PI*2); ctx.stroke();
      }

      // ISS + CSS rings around Earth
      if (p.n === 'Earth') {
        const yF = Math.abs(Math.sin(_cam.phi));
        ctx.strokeStyle = 'rgba(167,139,250,.75)'; ctx.lineWidth = Math.max(.6, p.sz*2*sc);
        ctx.beginPath(); ctx.ellipse(sx, sy, p.sz*14*sc, p.sz*14*sc*yF, 0, 0, Math.PI*2); ctx.stroke();
        ctx.strokeStyle = 'rgba(245,158,11,.75)'; ctx.lineWidth = Math.max(.6, p.sz*1.8*sc);
        ctx.beginPath(); ctx.ellipse(sx, sy, p.sz*12.5*sc, p.sz*12.5*sc*yF, 0, 0, Math.PI*2); ctx.stroke();
      }

      // Planet sphere
      const sg = ctx.createRadialGradient(sx-r*.3, sy-r*.35, 0, sx, sy, r);
      sg.addColorStop(0, _hexShift(p.col, 70)); sg.addColorStop(1, _hexShift(p.col, -50));
      ctx.shadowColor = p.col; ctx.shadowBlur = r*1.6;
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;

      if (_ssShowLabels) {
        ctx.font = Math.max(9, Math.min(12, r*2.2))+'px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText(p.n, sx, sy-r-4);
      }
      _ssPickObjs.push({ name:p.n, au:p.a.toFixed(2)+' AU', sx, sy, sr:r+8 });

    } else if (obj.type === 'voyager') {
      const { v } = obj;
      const r = Math.max(2, 2.5*sc);
      ctx.shadowColor = v.col; ctx.shadowBlur = 12;
      ctx.fillStyle = v.col;
      ctx.beginPath();
      ctx.moveTo(sx, sy-r*2.2); ctx.lineTo(sx+r*1.3, sy); ctx.lineTo(sx, sy+r*2.2); ctx.lineTo(sx-r*1.3, sy);
      ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
      if (_ssShowLabels) {
        ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = v.col; ctx.fillText(v.n, sx, sy-r*2.5-3);
      }
      _ssPickObjs.push({ name:v.n, au:v.au+' AU — interstellar', sx, sy, sr:r*3+8 });
    }
  });
}

function _initSSControls(canvas) {
  canvas.addEventListener('mousedown', e => { _ssDragging=true; _ssDragLast={x:e.clientX,y:e.clientY}; canvas.style.cursor='grabbing'; });
  window.addEventListener('mouseup', () => { _ssDragging=false; canvas.style.cursor='grab'; });
  window.addEventListener('mousemove', e => {
    if (_ssDragging) {
      _cam.theta -= (e.clientX-_ssDragLast.x)*.005;
      _cam.phi   -= (e.clientY-_ssDragLast.y)*.005;
      _cam.phi    = Math.max(.05, Math.min(Math.PI-.05, _cam.phi));
      _ssDragLast = { x:e.clientX, y:e.clientY };
    }
    // Hover tooltip
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX-rect.left, my = e.clientY-rect.top;
    const hit = _ssPickObjs.find(o => Math.hypot(o.sx-mx, o.sy-my) < o.sr);
    const hov = document.getElementById('ss3d-hover');
    if (hit && hov) {
      hov.style.display = '';
      document.getElementById('ss3d-hover-name').textContent = hit.name;
      const lines = [hit.au];
      if (hit.name === 'Earth') lines.push('Purple ring: ISS orbit · Amber ring: Tiangong');
      if (hit.name === 'Saturn') lines.push('Ring system visible from 1.3 billion km away');
      if (hit.au && hit.au.toString().includes('interstellar')) lines.push('Launched 1977 — now beyond the solar system');
      document.getElementById('ss3d-hover-detail').innerHTML = lines.join('<br>');
    } else if (hov) hov.style.display = 'none';
  });
  canvas.addEventListener('mouseleave', () => { const h=document.getElementById('ss3d-hover'); if(h) h.style.display='none'; });
  canvas.addEventListener('wheel', e => {
    _cam.r *= 1+e.deltaY*.0008; _cam.r = Math.max(5, Math.min(135, _cam.r));
  }, { passive:true });
  // Touch
  let _tp = null;
  canvas.addEventListener('touchstart', e => { _tp=e.touches; _ssDragging=true; }, { passive:true });
  window.addEventListener('touchend', () => { _ssDragging=false; _tp=null; });
  window.addEventListener('touchmove', e => {
    if (!_tp || !e.touches[0]) return;
    _cam.theta -= (e.touches[0].clientX-_tp[0].clientX)*.005;
    _cam.phi   -= (e.touches[0].clientY-_tp[0].clientY)*.005;
    _cam.phi    = Math.max(.05, Math.min(Math.PI-.05, _cam.phi));
    _tp = e.touches; e.preventDefault();
  }, { passive:false });
}

function ss3dToggleOrbits() { _ssShowOrbits = !_ssShowOrbits; }
function ss3dToggleLabels() { _ssShowLabels = !_ssShowLabels; }
function ss3dReset() { _cam.theta=-0.5; _cam.phi=0.82; _cam.r=90; }
function ss3dSetSpeed(v) { _ssSimSpeed = parseFloat(v)||0; }

// ══════════════════════════════════════════════════════════════════════════════
// SPACE STATIONS
// ══════════════════════════════════════════════════════════════════════════════
async function astroLoadISS() {
  try {
    const r = await fetch(BASE_PATH + '/api/iss?device='+deviceId);
    const d = await r.json();
    _issData = d.iss||null; _cssData = d.css||null;
    _renderStation('iss', _issData); _renderStation('css', _cssData);
    drawStationMap(); _checkOverhead();
    if (issTimer) clearTimeout(issTimer);
    issTimer = setTimeout(astroLoadISS, 5000);
  } catch { issTimer = setTimeout(astroLoadISS, 8000); }
}

function _renderStation(id, d) {
  if (!d) { _setText(id+'-vis','N/A'); return; }
  const vis = (d.visibility||'unknown').replace(/_/g,' ');
  const badge = document.getElementById(id+'-vis');
  if (badge) { badge.textContent=vis; badge.className='st-badge '+(vis==='daylight'?'daylight':vis==='eclipsed'?'eclipsed':vis.includes('twilight')?'twilight':'na'); }
  const fL = v => (v>=0?'+':'')+v.toFixed(2)+'°';
  _setText(id+'-lat', fL(d.latitude));
  _setText(id+'-lng', fL(d.longitude));
  _setText(id+'-alt', d.altitude ? d.altitude.toFixed(1)+' km' : '—');
  _setText(id+'-vel', d.velocity ? Math.round(d.velocity).toLocaleString()+' km/h' : '—');
}

// Simplified continent polygons [lon,lat]
const _CONTINENTS = [
  [[32,-28],[18,-34],[12,-17],[-1,5],[15,4],[26,-5],[36,-5],[42,5],[44,12],[43,15],[38,22],[32,30],[25,37],[10,38],[-3,37],[-6,34],[-14,10],[-17,5],[-17,15],[-10,25],[5,32],[15,28],[25,20],[33,12]],
  [[-10,36],[-5,36],[0,39],[3,44],[8,44],[15,47],[25,46],[30,45],[32,42],[28,38],[24,38],[20,40],[16,40],[14,38],[8,38],[3,43],[-2,44],[-7,44],[-8,40],[-10,36]],
  [[32,42],[42,42],[60,44],[80,44],[100,50],[120,52],[134,48],[140,42],[140,36],[130,34],[120,26],[108,18],[100,10],[104,2],[100,-2],[110,-8],[120,-10],[130,0],[120,20],[100,25],[90,28],[80,32],[70,26],[60,22],[52,16],[44,12],[42,12],[36,12],[36,18],[42,22],[38,30],[35,36],[32,42]],
  [[-70,45],[-60,46],[-64,50],[-70,55],[-80,62],[-90,65],[-100,68],[-120,68],[-140,60],[-155,58],[-165,62],[-168,66],[-140,70],[-120,70],[-105,72],[-85,70],[-80,64],[-82,58],[-88,56],[-90,50],[-85,46],[-82,42],[-76,44],[-72,44],[-65,44],[-60,46]],
  [[-68,-54],[-65,-50],[-60,-52],[-48,-28],[-40,-20],[-34,-8],[-36,0],[-50,0],[-60,-5],[-70,-12],[-76,-10],[-80,-2],[-78,2],[-76,6],[-70,12],[-62,12],[-58,6],[-50,-2],[-38,-14],[-36,-22],[-46,-24],[-50,-30],[-52,-34],[-56,-38],[-62,-42],[-68,-46],[-68,-54]],
  [[114,-22],[118,-34],[122,-34],[130,-32],[138,-36],[145,-38],[148,-42],[148,-38],[152,-28],[152,-22],[145,-16],[138,-12],[132,-12],[126,-14],[118,-22],[114,-22]],
  [[-22,83],[-14,82],[-10,76],[-18,72],[-28,70],[-36,65],[-42,65],[-48,68],[-54,70],[-52,76],[-44,82],[-30,84],[-22,83]],
];

function drawStationMap() {
  const canvas = document.getElementById('station-map'); if (!canvas) return;
  const dpr=devicePixelRatio||1, W=canvas.offsetWidth||500, H=160;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);

  ctx.fillStyle='#06101e'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,.04)'; ctx.lineWidth=.5;
  for(let lo=-180;lo<=180;lo+=30){const x=(lo+180)/360*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let la=-90;la<=90;la+=30){const y=(90-la)/180*H;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=.8;
  ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();

  ctx.fillStyle='rgba(50,80,50,.55)'; ctx.strokeStyle='rgba(70,110,70,.3)'; ctx.lineWidth=.4;
  _CONTINENTS.forEach(poly=>{
    ctx.beginPath();
    poly.forEach(([lo,la],i)=>{ const x=(lo+180)/360*W,y=(90-la)/180*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  });

  ctx.fillStyle='rgba(167,139,250,.04)';
  ctx.fillRect(0,(90-51.6)/180*H,W,(103.2/180)*H);
  ctx.fillStyle='rgba(245,158,11,.04)';
  ctx.fillRect(0,(90-41.5)/180*H,W,(83/180)*H);

  const _dot=(lat,lon,col,r,label)=>{
    const x=(lon+180)/360*W, y=(90-lat)/180*H;
    ctx.shadowColor=col; ctx.shadowBlur=8; ctx.beginPath();
    ctx.fillStyle=col; ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    if(label){ctx.fillStyle=col;ctx.font='9px system-ui';ctx.textAlign='left';ctx.fillText(label,Math.min(x+6,W-30),y-3);}
  };
  if (_issData) _dot(_issData.latitude,_issData.longitude,'#a78bfa',4.5,'ISS');
  if (_cssData) _dot(_cssData.latitude,_cssData.longitude,'#f59e0b',4.5,'CSS');
  if (astroLat!==null) _dot(astroLat,astroLng,'#34d399',3.5,'');
}

function _checkOverhead() {
  const el=document.getElementById('station-overhead'); if(!el||astroLat===null)return;
  const msgs=[];
  if(_issData){const d=_distKm(astroLat,astroLng,_issData.latitude,_issData.longitude);msgs.push('ISS '+_fmtKm(d)+' away'+(d<1000?' 🟢':''));}
  if(_cssData){const d=_distKm(astroLat,astroLng,_cssData.latitude,_cssData.longitude);msgs.push('Tiangong '+_fmtKm(d)+' away'+(d<1000?' 🟢':''));}
  el.textContent=msgs.join('  ·  ');
}
function _distKm(la1,lo1,la2,lo2){const R=6371,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180,a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function _fmtKm(km){return km>=1000?(km/1000).toFixed(1)+'k km':Math.round(km)+' km';}

// ══════════════════════════════════════════════════════════════════════════════
// SUN
// ══════════════════════════════════════════════════════════════════════════════
async function astroLoadSun() {
  try {
    const r=await fetch(BASE_PATH + '/api/sunrise?lat='+astroLat+'&lng='+astroLng+'&device='+deviceId);
    const d=(await r.json()).results; if(!d)return;
    const fmt=iso=>new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const fmtL=s=>Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
    _setText('sun-rise',fmt(d.sunrise)); _setText('sun-noon',fmt(d.solar_noon));
    _setText('sun-set',fmt(d.sunset));   _setText('sun-len',fmtL(d.day_length));
    _setText('sun-dawn',fmt(d.civil_twilight_begin||d.astronomical_twilight_begin));
    _setText('sun-dusk',fmt(d.civil_twilight_end  ||d.astronomical_twilight_end));
    lastSunData=[new Date(d.sunrise),new Date(d.sunset),new Date(d.solar_noon)];
    _drawSunArc(...lastSunData);
  } catch {}
}

function _drawSunArc(rise,set,noon) {
  const canvas=document.getElementById('sun-arc'); if(!canvas)return;
  const dpr=devicePixelRatio||1, W=canvas.offsetWidth; if(!W)return;
  const H=100; canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const now=new Date();
  const frac=Math.max(0,Math.min(1,(now-rise)/(set-rise)));
  const cx=W/2, cy=H+8, rx=W/2-18, ry=H-12;
  const angle=t=>Math.PI+t*Math.PI;
  ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=3;
  ctx.ellipse(cx,cy,rx,ry,0,Math.PI,0); ctx.stroke();
  if(frac>0){
    const g=ctx.createLinearGradient(cx-rx,0,cx+rx,0);
    g.addColorStop(0,'#f97316'); g.addColorStop(.5,'#ffd700'); g.addColorStop(1,'#f97316');
    ctx.beginPath(); ctx.strokeStyle=g; ctx.lineWidth=3;
    ctx.ellipse(cx,cy,rx,ry,0,Math.PI,angle(frac)); ctx.stroke();
  }
  const sa=angle(frac), sx=cx+Math.cos(sa)*rx, sy=cy+Math.sin(sa)*ry;
  const sg=ctx.createRadialGradient(sx,sy,0,sx,sy,9);
  sg.addColorStop(0,'#fffbe0'); sg.addColorStop(.4,'#ffd700'); sg.addColorStop(1,'rgba(255,150,0,0)');
  ctx.beginPath(); ctx.fillStyle=sg; ctx.shadowColor='#ffd700'; ctx.shadowBlur=16;
  ctx.arc(sx,sy,8,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
  ctx.fillStyle='rgba(255,255,255,.3)'; ctx.font='10px system-ui'; ctx.textAlign='center';
  ctx.fillText(rise.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),18,H-2);
  ctx.fillText(set.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),W-18,H-2);
  ctx.fillText(noon.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),cx,H-2);
  ctx.fillStyle='rgba(255,220,80,.9)';
  ctx.fillText(now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),Math.max(18,Math.min(W-18,sx)),Math.max(12,sy-14));
}

// ══════════════════════════════════════════════════════════════════════════════
// MOON
// ══════════════════════════════════════════════════════════════════════════════
function astroCalcMoon() {
  const now=new Date(), jd=_jd(now);
  const SYN=29.53058867, kNM=2451549.5+.5*SYN;
  const age=((jd-kNM)%SYN+SYN)%SYN;
  const illum=.5*(1-Math.cos(2*Math.PI*age/SYN));
  const phases=[{m:1,n:'New Moon'},{m:7.4,n:'Waxing Crescent'},{m:9,n:'First Quarter'},{m:14.8,n:'Waxing Gibbous'},{m:16.6,n:'Full Moon'},{m:22.2,n:'Waning Gibbous'},{m:24,n:'Last Quarter'},{m:SYN,n:'Waning Crescent'}];
  const emojis=['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];
  let pi=phases.findIndex(p=>age<p.m); if(pi<0)pi=7;
  _setText('moon-phase',phases[pi].n);
  _setText('moon-illum',Math.round(illum*100)+'% illuminated');
  _setText('moon-age','Age: '+age.toFixed(1)+' days');
  _setText('moon-next','Full: '+(SYN/2-age>0?SYN/2-age:SYN*1.5-age).toFixed(1)+'d · New: '+(SYN-age).toFixed(1)+'d');
  _drawMoon(illum,age<SYN/2);
  _buildLunarCal(now,SYN,kNM,emojis);
}

function _drawMoon(illum,waxing) {
  const cv=document.getElementById('moon-canvas'); if(!cv)return;
  const W=110,H=110,r=50,cx=W/2,cy=H/2; cv.width=W; cv.height=H;
  const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);
  const gl=ctx.createRadialGradient(cx,cy,r-2,cx,cy,r+10);
  gl.addColorStop(0,'rgba(200,200,180,.1)'); gl.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.fillStyle=gl; ctx.arc(cx,cy,r+10,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.fillStyle='#191926'; ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
  ctx.save();
  if(waxing){ ctx.beginPath(); ctx.rect(cx,cy-r-1,r+1,(r+1)*2); ctx.clip(); }
  else       { ctx.beginPath(); ctx.rect(cx-r-1,cy-r-1,r+1,(r+1)*2); ctx.clip(); }
  const xS=Math.abs(Math.cos(Math.PI*illum));
  const lg=ctx.createRadialGradient(cx-8,cy-12,0,cx,cy,r);
  lg.addColorStop(0,'#fff5e0'); lg.addColorStop(.6,'#d8c8a0'); lg.addColorStop(1,'#a89878');
  ctx.fillStyle=lg;
  ctx.beginPath(); ctx.ellipse(cx,cy,r*(1-xS),r,0,0,Math.PI*2); ctx.fill();
  ctx.restore();
  ctx.fillStyle='rgba(0,0,0,.1)';
  [[cx+14,cy-10,6],[cx-12,cy+14,4],[cx+4,cy+6,5],[cx-8,cy-18,3]].forEach(([x,y,rr])=>{ctx.beginPath();ctx.arc(x,y,rr,0,Math.PI*2);ctx.fill();});
  const ld=ctx.createRadialGradient(cx,cy,r*.7,cx,cy,r);
  ld.addColorStop(0,'rgba(0,0,0,0)'); ld.addColorStop(1,'rgba(0,0,0,.4)');
  ctx.beginPath(); ctx.fillStyle=ld; ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
}

function _buildLunarCal(today,syn,kNM,emojis) {
  const el=document.getElementById('moon-cal'); if(!el)return;
  const y=today.getFullYear(),m=today.getMonth();
  const dim=new Date(y,m+1,0).getDate(), fdow=new Date(y,m,1).getDay();
  let h=['S','M','T','W','T','F','S'].map(d=>'<div class="mc-dow">'+d+'</div>').join('');
  for(let i=0;i<fdow;i++) h+='<div class="mc-day empty"></div>';
  for(let day=1;day<=dim;day++){
    const jd=_jd(new Date(y,m,day,12));
    const age=((jd-kNM)%syn+syn)%syn;
    const pi=[[1,0],[7.4,1],[9,2],[14.8,3],[16.6,4],[22.2,5],[24,6],[syn,7]].findIndex(([mx])=>age<mx);
    h+='<div class="mc-day'+(day===today.getDate()?' today':'')+'"><span class="mc-e">'+emojis[pi<0?7:pi]+'</span><span class="mc-n">'+day+'</span></div>';
  }
  el.innerHTML=h;
}

function _jd(date) {
  const y=date.getFullYear(),m=date.getMonth()+1,d=date.getDate();
  const h=date.getHours()+date.getMinutes()/60+date.getSeconds()/3600;
  return 367*y-Math.floor(7*(y+Math.floor((m+9)/12))/4)+Math.floor(275*m/9)+d+1721013.5+h/24;
}

// ══════════════════════════════════════════════════════════════════════════════
// PLANETS & EVENTS
// ══════════════════════════════════════════════════════════════════════════════
function astroCalcPlanets() {
  const T=_calcT(), R=d=>d*Math.PI/180;
  const sunLon=((280.46646+36000.76983*T)%360+360)%360;
  const earth=_planetXYZ(SS_PLANETS[2],T);
  const grid=document.getElementById('planets-grid'); if(!grid)return;
  grid.innerHTML=SS_PLANETS.filter(p=>p.n!=='Earth').map(p=>{
    const [px,,pz]=_planetXYZ(p,T);
    const dAU=Math.hypot(px-earth[0],pz-earth[2]);
    const L=((p.L0+p.Ld*T/100)%360+360)%360;
    const elon=((L-sunLon+360)%360);
    const alt=Math.round(Math.sin(R(Math.min(elon,360-elon)))*65);
    const vis=alt>10,low=alt>=0&&alt<=10;
    return '<div class="planet-card">'+
      '<div class="planet-name">'+p.n+'<span class="planet-badge '+(vis?'pb-vis':low?'pb-low':'pb-hid')+'">'+(vis?'Visible':low?'Low':'Below')+'</span></div>'+
      '<div class="planet-alt">~'+(alt>=0?'+':'')+alt+'° alt</div>'+
      '<div class="planet-dist">'+dAU.toFixed(3)+' AU from Earth</div>'+
      '</div>';
  }).join('');
}

function astroGenEvents() {
  const m=new Date().getMonth();
  const SHOWERS=[
    {mo:[0],n:'Quadrantids',p:'Jan 3–4',z:'~120/hr'},{mo:[3],n:'Lyrids',p:'Apr 22',z:'~18/hr'},
    {mo:[4],n:'Eta Aquariids',p:'May 5–6',z:'~50/hr'},{mo:[6],n:'Delta Aquariids',p:'Jul 28',z:'~25/hr'},
    {mo:[7],n:'Perseids',p:'Aug 11–13',z:'~100/hr'},{mo:[9],n:'Orionids',p:'Oct 21',z:'~25/hr'},
    {mo:[10],n:'Leonids',p:'Nov 17–18',z:'~15/hr'},{mo:[11],n:'Geminids',p:'Dec 13–14',z:'~150/hr'},
    {mo:[11],n:'Ursids',p:'Dec 22',z:'~10/hr'},
  ];
  const evs=[
    ...SHOWERS.filter(s=>s.mo.some(sm=>Math.abs(sm-m)<=1)).map(s=>({i:'🌠',t:s.n+' Meteor Shower',d:'Peak: '+s.p+' · '+s.z+' · Best after midnight in dark skies.'})),
    {i:'🌌',t:'Milky Way',d:m>=3&&m<=9?'Core well-placed tonight — best 10pm–3am away from city lights.':'Core below horizon. Good for Andromeda & Orion Nebula region.'},
    {i:'🛰',t:'ISS Passes',d:'~16 passes per day. Check Heavens-Above.com for exact times for your location.'},
    {i:'🪐',t:'Saturn\'s Rings',d:'Rings tilted ~27° toward Earth in 2026 — excellent for small telescopes.'},
    {i:'🌍',t:'Earthshine',d:'Look for the faint glow on the dark lunar limb during crescent phases — sunlight reflected from Earth\'s oceans.'},
  ];
  const el=document.getElementById('astro-events-list'); if(!el)return;
  el.innerHTML=evs.map(e=>'<div class="ev-item"><div class="ev-icon">'+e.i+'</div><div><div class="ev-title">'+e.t+'</div><div class="ev-desc">'+e.d+'</div></div></div>').join('');
}
