// ── Astronomy tab ──────────────────────────────────────────────────────────────
let astroLoaded = false, astroLat = null, astroLng = null;
let issTimer = null, lastSunData = null;
let _issData = null, _cssData = null;

// ── Init ───────────────────────────────────────────────────────────────────────
function astroInit() {
  if (astroLoaded) { _redrawStatic(); return; }
  astroLoaded = true;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => { astroLat=p.coords.latitude; astroLng=p.coords.longitude;
        _setText('astro-location', astroLat.toFixed(2)+'°, '+astroLng.toFixed(2)+'°');
        _loadAll(); },
      () => { astroLat=-26.2; astroLng=28.0;
        _setText('astro-location','Default (Johannesburg)'); _loadAll(); }
    );
  } else { astroLat=-26.2; astroLng=28.0; _setText('astro-location','No geolocation'); _loadAll(); }
  // 3D doesn't need location — start it immediately (waits for canvas size internally)
  _ss3dStart();
  window.addEventListener('resize', () => { _ss3dOnResize(); _redrawStatic(); });
}

function astroRefresh() { _loadAll(); }
function _loadAll() { astroLoadSun(); astroCalcMoon(); astroCalcPlanets(); astroLoadISS(); astroGenEvents(); }
function _redrawStatic() { if(lastSunData) _drawSunArc(...lastSunData); drawStationMap(); }
function _setText(id, v) { const e=document.getElementById(id); if(e) e.textContent=v; }

// ══════════════════════════════════════════════════════════════════════════════
// THREE.JS 3D SOLAR SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
const SS_PLANETS = [
  { n:'Mercury', col:0xa8a8a8, sz:.18, a:.387,  e:.206, L0:252.25, Ld:149474.07, w0:77.46  },
  { n:'Venus',   col:0xe8d48b, sz:.32, a:.723,  e:.007, L0:181.98, Ld:58519.21,  w0:131.56 },
  { n:'Earth',   col:0x4fa3e0, sz:.36, a:1.000, e:.017, L0:100.46, Ld:35999.37,  w0:102.94 },
  { n:'Mars',    col:0xc1440e, sz:.22, a:1.524, e:.093, L0:355.43, Ld:19141.70,  w0:336.08 },
  { n:'Jupiter', col:0xc88b3a, sz:.85, a:5.203, e:.049, L0:34.40,  Ld:3036.30,   w0:14.33  },
  { n:'Saturn',  col:0xead39c, sz:.70, a:9.537, e:.056, L0:49.94,  Ld:1223.51,   w0:92.86, ring:true },
  { n:'Uranus',  col:0x7de8e4, sz:.52, a:19.19, e:.047, L0:313.23, Ld:428.48,    w0:172.43 },
  { n:'Neptune', col:0x3f54ba, sz:.48, a:30.07, e:.010, L0:304.88, Ld:218.49,    w0:46.68  },
];
// Voyager positions ~mid-2026 (ecliptic 3D unit vectors × AU)
const VOYAGERS = [
  { n:'Voyager 1', col:0xff88cc, au:166, u:[-0.184,-0.793, 0.579] },
  { n:'Voyager 2', col:0x88ffcc, au:139, u:[ 0.359,-0.736,-0.573] },
];

function _auTo3D(au) { return 55 * Math.log(1+au) / Math.log(201); }

function _calcT(extraDays=0) {
  const n=new Date(Date.now()+extraDays*86400000);
  return (367*n.getFullYear()-Math.floor(7*(n.getFullYear()+Math.floor((n.getMonth()+10)/12))/4)
    +Math.floor(275*(n.getMonth()+1)/9)+n.getDate()+1721013.5
    +(n.getHours()+n.getMinutes()/60+n.getSeconds()/3600)/24-2451545)/36525;
}

function _planetXYZ(p, T) {
  const R=d=>d*Math.PI/180;
  const L=((p.L0+p.Ld*T/100)%360+360)%360;
  let M=R(((L-p.w0)%360+360)%360), E=M;
  for(let i=0;i<8;i++) E=M+p.e*Math.sin(E);
  const v=2*Math.atan2(Math.sqrt(1+p.e)*Math.sin(E/2),Math.sqrt(1-p.e)*Math.cos(E/2));
  const r=p.a*(1-p.e*Math.cos(E)), lon=R(p.w0)+v, d=_auTo3D(r);
  return [d*Math.cos(lon), 0, -d*Math.sin(lon)];
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────────
function _rng(seed) { let s=seed; return ()=>{ s=(s*16807)%2147483647; return(s-1)/2147483646; }; }

// ── Simple Orbit Controls ──────────────────────────────────────────────────────
class _OrbitCtrl {
  constructor(cam, el) {
    this.cam=cam; this.el=el; this.theta=-Math.PI/8; this.phi=Math.PI/4; this.r=72;
    this.target=null; // set after THREE loads
    let dn=false, lx=0, ly=0, pt=null;
    el.addEventListener('mousedown', e=>{dn=true;lx=e.clientX;ly=e.clientY;});
    window.addEventListener('mouseup', ()=>dn=false);
    window.addEventListener('mousemove', e=>{
      if(!dn)return;
      this.theta-=(e.clientX-lx)*.006; this.phi-=(e.clientY-ly)*.006;
      this.phi=Math.max(.04,Math.min(Math.PI-.04,this.phi));
      lx=e.clientX; ly=e.clientY; this._upd();
    });
    el.addEventListener('wheel', e=>{
      this.r*=1+e.deltaY*.0008; this.r=Math.max(3,Math.min(130,this.r)); this._upd();
    },{passive:true});
    el.addEventListener('touchstart', e=>{pt=e.touches;},{passive:true});
    window.addEventListener('touchend', ()=>{pt=null;});
    window.addEventListener('touchmove', e=>{
      if(!pt||!e.touches[0])return;
      this.theta-=(e.touches[0].clientX-pt[0].clientX)*.006;
      this.phi  -=(e.touches[0].clientY-pt[0].clientY)*.006;
      this.phi=Math.max(.04,Math.min(Math.PI-.04,this.phi));
      pt=e.touches; this._upd(); e.preventDefault();
    },{passive:false});
  }
  _upd() {
    if(!this.target)return;
    const x=this.r*Math.sin(this.phi)*Math.sin(this.theta);
    const y=this.r*Math.cos(this.phi);
    const z=this.r*Math.sin(this.phi)*Math.cos(this.theta);
    this.cam.position.set(x,y,z); this.cam.lookAt(this.target);
  }
}

// ── Scene state ────────────────────────────────────────────────────────────────
let _3d=null, _3dSimDays=0, _3dSimSpeed=10, _3dLastT=0;
let _3dPlanetObjs=[], _3dLabelEls=[], _3dPickObjs=[];
let _3dShowLabels=true, _3dShowOrbits=true;

function _ss3dStart() {
  const canvas=document.getElementById('ss3d-canvas');
  if(!canvas) return;
  if(canvas.offsetWidth===0) { requestAnimationFrame(_ss3dStart); return; }
  if(_3d) { _ss3dOnResize(); return; }
  if(window.THREE) { _ss3dBuild(); return; }
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js';
  s.onload=_ss3dBuild;
  s.onerror=()=>_setText('ss3d-loading','3D engine failed to load');
  document.head.appendChild(s);
}

function _ss3dBuild() {
  const canvas=document.getElementById('ss3d-canvas');
  const loading=document.getElementById('ss3d-loading');
  if(!canvas||!window.THREE) return;
  const T=window.THREE;

  const W=canvas.offsetWidth, H=420;
  canvas.style.height=H+'px';
  const renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(W,H,false);

  const scene=new T.Scene();
  const camera=new T.PerspectiveCamera(50,W/H,.05,600);
  const ctrl=new _OrbitCtrl(camera,canvas);
  ctrl.target=new T.Vector3(0,0,0); ctrl._upd();

  // ── Lights ──
  scene.add(new T.PointLight(0xfff5e0,2.5,250));
  scene.add(new T.AmbientLight(0x111133,.8));

  // ── Stars ──
  const starPos=new Float32Array(5000*3), sr=_rng(42);
  for(let i=0;i<starPos.length;i+=3){
    const r=120+sr()*180, phi=Math.acos(1-2*sr()), th=sr()*Math.PI*2;
    starPos[i]=r*Math.sin(phi)*Math.cos(th); starPos[i+1]=r*Math.cos(phi); starPos[i+2]=r*Math.sin(phi)*Math.sin(th);
  }
  const sg=new T.BufferGeometry(); sg.setAttribute('position',new T.BufferAttribute(starPos,3));
  scene.add(new T.Points(sg,new T.PointsMaterial({color:0xffffff,size:.22,sizeAttenuation:true,transparent:true,opacity:.9})));

  // ── Sun ──
  const sunMesh=new T.Mesh(new T.SphereGeometry(1.6,32,32),new T.MeshBasicMaterial({color:0xffd700}));
  scene.add(sunMesh);
  sunMesh.add(_makeGlow(T,new T.Color(0xffd700),8));
  // Corona halo
  const haloGeo=new T.SphereGeometry(2.4,32,32);
  const haloMat=new T.MeshBasicMaterial({color:0xff8800,transparent:true,opacity:.12,side:T.BackSide});
  scene.add(new T.Mesh(haloGeo,haloMat));

  // ── Asteroid belt ──
  const bp=new Float32Array(3500*3), br=_rng(999);
  for(let i=0;i<bp.length;i+=3){
    const r=_auTo3D(2.2+br()*(3.2-2.2)), ang=br()*Math.PI*2, y=(br()-.5)*.6;
    bp[i]=r*Math.cos(ang); bp[i+1]=y; bp[i+2]=r*Math.sin(ang);
  }
  const bGeo=new T.BufferGeometry(); bGeo.setAttribute('position',new T.BufferAttribute(bp,3));
  scene.add(new T.Points(bGeo,new T.PointsMaterial({color:0x887755,size:.14,sizeAttenuation:true,transparent:true,opacity:.45})));

  // ── Heliosphere (Voyager shell) ──
  const hsMat=new T.MeshBasicMaterial({color:0x2233aa,transparent:true,opacity:.04,side:T.BackSide});
  scene.add(new T.Mesh(new T.SphereGeometry(54,32,16),hsMat));

  // ── Kuiper belt hint ──
  const kp=new Float32Array(1500*3), kr=_rng(1234);
  for(let i=0;i<kp.length;i+=3){
    const r=_auTo3D(30+kr()*20), ang=kr()*Math.PI*2, y=(kr()-.5)*2;
    kp[i]=r*Math.cos(ang); kp[i+1]=y; kp[i+2]=r*Math.sin(ang);
  }
  const kGeo=new T.BufferGeometry(); kGeo.setAttribute('position',new T.BufferAttribute(kp,3));
  scene.add(new T.Points(kGeo,new T.PointsMaterial({color:0x4466aa,size:.1,sizeAttenuation:true,transparent:true,opacity:.3})));

  // ── Planets ──
  _3dPlanetObjs=[]; _3dLabelEls=[]; _3dPickObjs=[];
  const overlay=document.getElementById('ss3d-labels');
  if(overlay) overlay.innerHTML='';
  const curT=_calcT(_3dSimDays);

  SS_PLANETS.forEach(p=>{
    // Orbit ring
    const oGeo=new T.RingGeometry(_auTo3D(p.a)-.04,_auTo3D(p.a)+.04,180);
    oGeo.rotateX(Math.PI/2);
    const orb=new T.Mesh(oGeo,new T.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.06,side:T.DoubleSide}));
    orb.userData.isOrbit=true; scene.add(orb);

    // Planet sphere
    const mat=new T.MeshPhongMaterial({color:p.col, emissive:new T.Color(p.col).multiplyScalar(.05), shininess:25});
    const mesh=new T.Mesh(new T.SphereGeometry(p.sz,28,18),mat);
    const [x,y,z]=_planetXYZ(p,curT);
    mesh.position.set(x,y,z);
    mesh.userData={name:p.n, au:p.a, planet:p};
    scene.add(mesh);
    mesh.add(_makeGlow(T,new T.Color(p.col),.8));

    // Saturn rings
    if(p.ring){
      const rg=new T.RingGeometry(p.sz*1.45,p.sz*2.6,64);
      rg.rotateX(Math.PI/2.4);
      mesh.add(new T.Mesh(rg,new T.MeshBasicMaterial({color:0xc8b06a,transparent:true,opacity:.55,side:T.DoubleSide})));
    }

    // ISS & CSS orbit rings around Earth
    if(p.n==='Earth'){
      const iRg=new T.RingGeometry(p.sz*1.55,p.sz*1.65,64);
      iRg.rotateX(Math.PI/2);
      mesh.add(new T.Mesh(iRg,new T.MeshBasicMaterial({color:0xa78bfa,transparent:true,opacity:.7,side:T.DoubleSide})));
      const cRg=new T.RingGeometry(p.sz*1.38,p.sz*1.48,64);
      cRg.rotateX(Math.PI/2);
      mesh.add(new T.Mesh(cRg,new T.MeshBasicMaterial({color:0xf59e0b,transparent:true,opacity:.7,side:T.DoubleSide})));
    }

    _3dPlanetObjs.push({mesh,p,orb});
    _3dPickObjs.push(mesh);

    // HTML label
    if(overlay){
      const lbl=document.createElement('div');
      lbl.className='ss3d-label';
      lbl.textContent=p.n;
      lbl.style.color='#'+new T.Color(p.col).getHexString();
      overlay.appendChild(lbl);
      _3dLabelEls.push({el:lbl,obj:mesh});
    }
  });

  // ── Voyager 1 & 2 ──
  VOYAGERS.forEach(v=>{
    const d=_auTo3D(v.au);
    const pos=new T.Vector3(v.u[0]*d, v.u[2]*d, -v.u[1]*d);
    const mat=new T.MeshBasicMaterial({color:v.col});
    const mesh=new T.Mesh(new T.SphereGeometry(.3,8,8),mat);
    mesh.position.copy(pos);
    mesh.userData={name:v.n, au:v.au, isVoyager:true};
    scene.add(mesh);
    mesh.add(_makeGlow(T,new T.Color(v.col),.8));
    _3dPickObjs.push(mesh);
    if(overlay){
      const lbl=document.createElement('div');
      lbl.className='ss3d-label ss3d-label-voy';
      lbl.textContent=v.n;
      lbl.style.color='#'+new T.Color(v.col).getHexString();
      overlay.appendChild(lbl);
      _3dLabelEls.push({el:lbl,obj:mesh});
    }
  });

  if(loading) loading.style.display='none';
  _3d={renderer,scene,camera,ctrl,THREE:T};
  _3dLastT=performance.now();
  requestAnimationFrame(_ss3dLoop);
  _initRaycast(canvas);
}

function _makeGlow(T,color,scale) {
  const sz=128, cv=document.createElement('canvas'); cv.width=sz; cv.height=sz;
  const cx=cv.getContext('2d');
  const g=cx.createRadialGradient(sz/2,sz/2,0,sz/2,sz/2,sz/2);
  const r=Math.round(color.r*255),gr=Math.round(color.g*255),b=Math.round(color.b*255);
  g.addColorStop(0,`rgba(${r},${gr},${b},1)`);
  g.addColorStop(.35,`rgba(${r},${gr},${b},.5)`);
  g.addColorStop(1,'rgba(0,0,0,0)');
  cx.fillStyle=g; cx.fillRect(0,0,sz,sz);
  const tex=new T.CanvasTexture(cv);
  const mat=new T.SpriteMaterial({map:tex,transparent:true,blending:T.AdditiveBlending,depthWrite:false});
  const s=new T.Sprite(mat); s.scale.setScalar(scale*6);
  return s;
}

function _ss3dLoop(now) {
  if(!_3d) return;
  requestAnimationFrame(_ss3dLoop);
  const dt=Math.min((now-_3dLastT)/1000,.1); _3dLastT=now;
  _3dSimDays+=_3dSimSpeed*dt;

  // Update planet positions
  const T=_calcT(_3dSimDays);
  _3dPlanetObjs.forEach(({mesh,p})=>{
    const [x,y,z]=_planetXYZ(p,T);
    mesh.position.set(x,y,z);
  });

  // Update labels
  const {renderer,camera}=_3d;
  const W=renderer.domElement.clientWidth, H=renderer.domElement.clientHeight;
  _3dLabelEls.forEach(({el,obj})=>{
    if(!_3dShowLabels){el.style.display='none';return;}
    const wp=obj.position.clone().project(camera);
    const x=(wp.x+1)/2*W, y=(-wp.y+1)/2*H;
    el.style.left=x+'px'; el.style.top=(y-18)+'px';
    el.style.display=wp.z<1&&wp.z>-1?'':'none';
  });
  renderer.render(_3d.scene,camera);
}

function _ss3dOnResize() {
  if(!_3d) return;
  const canvas=_3d.renderer.domElement;
  const W=canvas.offsetWidth, H=420;
  canvas.style.height=H+'px';
  _3d.renderer.setSize(W,H,false);
  _3d.camera.aspect=W/H; _3d.camera.updateProjectionMatrix();
}

function _initRaycast(canvas) {
  if(!_3d) return;
  const T=_3d.THREE, ray=new T.Raycaster(), mouse=new T.Vector2();
  const hover=document.getElementById('ss3d-hover');
  canvas.addEventListener('mousemove', e=>{
    if(!_3d) return;
    const rect=canvas.getBoundingClientRect();
    mouse.x=(e.clientX-rect.left)/rect.width*2-1;
    mouse.y=-(e.clientY-rect.top)/rect.height*2+1;
    ray.setFromCamera(mouse,_3d.camera);
    const hits=ray.intersectObjects(_3dPickObjs);
    if(hits.length){
      const d=hits[0].object.userData;
      if(hover){
        hover.style.display='';
        document.getElementById('ss3d-hover-name').textContent=d.name||'';
        const lines=[];
        if(d.au) lines.push((typeof d.au==='number'?d.au.toFixed(3):d.au)+' AU from Sun');
        if(d.isVoyager) lines.push('Beyond the heliosphere · Interstellar space');
        if(d.name==='Earth') lines.push('ISS orbit (purple) · CSS orbit (amber)');
        document.getElementById('ss3d-hover-detail').innerHTML=lines.join('<br>');
      }
    } else if(hover) hover.style.display='none';
  });
  canvas.addEventListener('mouseleave', ()=>{ if(hover) hover.style.display='none'; });
}

function ss3dToggleLabels() { _3dShowLabels=!_3dShowLabels; }
function ss3dToggleOrbits() {
  _3dShowOrbits=!_3dShowOrbits;
  if(_3d) _3d.scene.traverse(o=>{if(o.userData&&o.userData.isOrbit)o.visible=_3dShowOrbits;});
}
function ss3dReset() {
  if(!_3d)return;
  _3d.ctrl.theta=-Math.PI/8; _3d.ctrl.phi=Math.PI/4; _3d.ctrl.r=72; _3d.ctrl._upd();
}
function ss3dSetSpeed(v) { _3dSimSpeed=parseFloat(v)||0; }

// ══════════════════════════════════════════════════════════════════════════════
// SPACE STATIONS
// ══════════════════════════════════════════════════════════════════════════════
async function astroLoadISS() {
  try {
    const r=await fetch('/api/iss?device='+deviceId);
    const d=await r.json();
    _issData=d.iss||null; _cssData=d.css||null;
    _renderStation('iss',_issData); _renderStation('css',_cssData);
    drawStationMap(); _checkOverhead();
    if(issTimer) clearTimeout(issTimer);
    issTimer=setTimeout(astroLoadISS,5000);
  } catch { issTimer=setTimeout(astroLoadISS,8000); }
}

function _renderStation(id,d) {
  if(!d) { _setText((id==='iss'?'iss':'css')+'-vis','N/A'); return; }
  const vis=d.visibility||'unknown';
  const badge=document.getElementById(id+'-vis');
  if(badge){ badge.textContent=vis; badge.className='st-badge '+(vis==='daylight'?'daylight':vis==='eclipsed'?'eclipsed':vis.includes('twilight')?'twilight':'na'); }
  const fmtLL=v=>(v>=0?'+':'')+v.toFixed(2)+'°';
  _setText(id+'-lat',fmtLL(d.latitude));
  _setText(id+'-lng',fmtLL(d.longitude));
  _setText(id+'-alt',(d.altitude?d.altitude.toFixed(1)+' km':'—'));
  _setText(id+'-vel',(d.velocity?Math.round(d.velocity).toLocaleString()+' km/h':'—'));
}

// Simplified continent polygon [lon,lat] pairs
const _CONTINENTS=[
  // Africa
  [[32,-28],[18,-34],[12,-17],[-1,5],[15,4],[26,-5],[36,-5],[42,5],[44,12],[43,15],[38,22],[32,30],[25,37],[10,38],[-3,37],[-6,34],[-14,10],[-17,5],[-17,15],[-10,25],[5,32],[15,28],[25,20],[33,12]],
  // Europe
  [[-10,36],[-5,36],[0,39],[3,44],[8,44],[15,47],[25,46],[30,45],[32,42],[28,38],[24,38],[20,40],[16,40],[14,38],[8,38],[3,43],[-2,44],[-7,44],[-8,40],[-10,36]],
  // Asia
  [[32,42],[42,42],[60,44],[80,44],[100,50],[120,52],[134,48],[140,42],[140,36],[130,34],[120,26],[108,18],[100,10],[104,2],[100,-2],[110,-8],[120,-10],[130,0],[120,20],[100,25],[90,28],[80,32],[70,26],[60,22],[52,16],[44,12],[42,12],[36,12],[36,18],[42,22],[38,30],[35,36],[32,42]],
  // North America
  [[-70,45],[-60,46],[-64,50],[-70,55],[-80,62],[-90,65],[-100,68],[-120,68],[-140,60],[-155,58],[-165,62],[-168,66],[-140,70],[-120,70],[-105,72],[-85,70],[-80,64],[-82,58],[-88,56],[-90,50],[-85,46],[-82,42],[-76,44],[-72,44],[-65,44],[-60,46]],
  // South America
  [[-68,-54],[-65,-50],[-60,-52],[-48,-28],[-40,-20],[-34,-8],[-36,0],[-50,0],[-60,-5],[-70,-12],[-76,-10],[-80,-2],[-78,2],[-76,6],[-70,12],[-62,12],[-58,6],[-50,-2],[-38,-14],[-36,-22],[-46,-24],[-50,-30],[-52,-34],[-56,-38],[-62,-42],[-68,-46],[-68,-54]],
  // Australia
  [[114,-22],[118,-34],[122,-34],[130,-32],[138,-36],[145,-38],[148,-42],[148,-38],[152,-28],[152,-22],[145,-16],[138,-12],[132,-12],[126,-14],[118,-22],[114,-22]],
  // Greenland
  [[-22,83],[-14,82],[-10,76],[-18,72],[-28,70],[-36,65],[-42,65],[-48,68],[-54,70],[-52,76],[-44,82],[-30,84],[-22,83]],
];

function drawStationMap() {
  const canvas=document.getElementById('station-map');
  if(!canvas) return;
  const dpr=devicePixelRatio||1, W=canvas.offsetWidth||500, H=160;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);

  // Ocean
  ctx.fillStyle='#06101e'; ctx.fillRect(0,0,W,H);
  // Grid
  ctx.strokeStyle='rgba(255,255,255,.04)'; ctx.lineWidth=.5;
  for(let lo=-180;lo<=180;lo+=30){const x=(lo+180)/360*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let la=-90;la<=90;la+=30){const y=(90-la)/180*H;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  // Equator
  ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=.8;
  ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();

  // Continents
  ctx.fillStyle='rgba(50,80,50,.55)'; ctx.strokeStyle='rgba(70,110,70,.3)'; ctx.lineWidth=.4;
  _CONTINENTS.forEach(poly=>{
    ctx.beginPath();
    poly.forEach(([lo,la],i)=>{ const x=(lo+180)/360*W,y=(90-la)/180*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  });

  // ISS orbital inclination band (51.6°)
  ctx.fillStyle='rgba(167,139,250,.04)';
  ctx.beginPath(); ctx.rect(0,(90-51.6)/180*H,W,(103.2/180)*H); ctx.fill();

  // Tiangong inclination band (41.5°)
  ctx.fillStyle='rgba(245,158,11,.04)';
  ctx.beginPath(); ctx.rect(0,(90-41.5)/180*H,W,(83/180)*H); ctx.fill();

  const _dot=(lat,lon,col,r,label)=>{
    const x=(lon+180)/360*W, y=(90-lat)/180*H;
    ctx.beginPath(); ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=8;
    ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    if(label){ ctx.fillStyle=col; ctx.font='9px system-ui'; ctx.textAlign='left'; ctx.fillText(label,Math.min(x+6,W-30),y-3); }
  };

  if(_issData) _dot(_issData.latitude,_issData.longitude,'#a78bfa',4.5,'ISS');
  if(_cssData) _dot(_cssData.latitude,_cssData.longitude,'#f59e0b',4.5,'CSS');
  if(astroLat!==null) _dot(astroLat,astroLng,'#34d399',3.5,'');
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
    const r=await fetch('/api/sunrise?lat='+astroLat+'&lng='+astroLng+'&device='+deviceId);
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
  // Background arc
  ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=3;
  ctx.ellipse(cx,cy,rx,ry,0,Math.PI,0); ctx.stroke();
  // Progress arc
  if(frac>0){
    const g=ctx.createLinearGradient(cx-rx,0,cx+rx,0);
    g.addColorStop(0,'#f97316'); g.addColorStop(.5,'#ffd700'); g.addColorStop(1,'#f97316');
    ctx.beginPath(); ctx.strokeStyle=g; ctx.lineWidth=3;
    ctx.ellipse(cx,cy,rx,ry,0,Math.PI,angle(frac)); ctx.stroke();
  }
  // Sun dot
  const sa=angle(frac), sx=cx+Math.cos(sa)*rx, sy=cy+Math.sin(sa)*ry;
  const sg=ctx.createRadialGradient(sx,sy,0,sx,sy,9);
  sg.addColorStop(0,'#fffbe0'); sg.addColorStop(.4,'#ffd700'); sg.addColorStop(1,'rgba(255,150,0,0)');
  ctx.beginPath(); ctx.fillStyle=sg; ctx.shadowColor='#ffd700'; ctx.shadowBlur=16;
  ctx.arc(sx,sy,8,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
  // Labels
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
  const phases=[{m:1,'🌑':{},n:'New Moon'},{m:7.4,n:'Waxing Crescent'},{m:9,n:'First Quarter'},{m:14.8,n:'Waxing Gibbous'},{m:16.6,n:'Full Moon'},{m:22.2,n:'Waning Gibbous'},{m:24,n:'Last Quarter'},{m:SYN,n:'Waning Crescent'}];
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
  // Outer glow
  const gl=ctx.createRadialGradient(cx,cy,r-2,cx,cy,r+10);
  gl.addColorStop(0,'rgba(200,200,180,.1)'); gl.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.fillStyle=gl; ctx.arc(cx,cy,r+10,0,Math.PI*2); ctx.fill();
  // Dark base
  ctx.beginPath(); ctx.fillStyle='#191926'; ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
  // Lit side using clipping
  ctx.save();
  if(waxing){ ctx.beginPath(); ctx.rect(cx,cy-r-1,r+1,(r+1)*2); ctx.clip(); }
  else       { ctx.beginPath(); ctx.rect(cx-r-1,cy-r-1,r+1,(r+1)*2); ctx.clip(); }
  const xS=Math.abs(Math.cos(Math.PI*illum));
  const lg=ctx.createRadialGradient(cx-8,cy-12,0,cx,cy,r);
  lg.addColorStop(0,'#fff5e0'); lg.addColorStop(.6,'#d8c8a0'); lg.addColorStop(1,'#a89878');
  ctx.fillStyle=lg;
  ctx.beginPath(); ctx.ellipse(cx,cy,r*(1-xS),r,0,0,Math.PI*2); ctx.fill();
  ctx.restore();
  // Craters
  ctx.fillStyle='rgba(0,0,0,.1)';
  [[cx+14,cy-10,6],[cx-12,cy+14,4],[cx+4,cy+6,5],[cx-8,cy-18,3]].forEach(([x,y,rr])=>{ctx.beginPath();ctx.arc(x,y,rr,0,Math.PI*2);ctx.fill();});
  // Limb darkening
  const ld=ctx.createRadialGradient(cx,cy,r*.7,cx,cy,r);
  ld.addColorStop(0,'rgba(0,0,0,0)'); ld.addColorStop(1,'rgba(0,0,0,.4)');
  ctx.beginPath(); ctx.fillStyle=ld; ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
}

function _buildLunarCal(today,syn,kNM,emojis) {
  const el=document.getElementById('moon-cal'); if(!el)return;
  const y=today.getFullYear(),m=today.getMonth();
  const dim=new Date(y,m+1,0).getDate(), fdow=new Date(y,m,1).getDay();
  const DOWS=['S','M','T','W','T','F','S'];
  let h=DOWS.map(d=>'<div class="mc-dow">'+d+'</div>').join('');
  for(let i=0;i<fdow;i++) h+='<div class="mc-day empty"></div>';
  for(let day=1;day<=dim;day++){
    const jd=_jd(new Date(y,m,day,12));
    const age=((jd-kNM)%syn+syn)%syn;
    const pi=[[1,0],[7.4,1],[9,2],[14.8,3],[16.6,4],[22.2,5],[24,6],[syn,7]].findIndex(([mx])=>age<mx);
    const e=emojis[pi<0?7:pi];
    const today2=day===today.getDate();
    h+='<div class="mc-day'+(today2?' today':'')+'"><span class="mc-e">'+e+'</span><span class="mc-n">'+day+'</span></div>';
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
    const [px,py,pz]=_planetXYZ(p,T);
    const dAU=Math.hypot(px-earth[0],pz-earth[2]);
    const L=((p.L0+p.Ld*T/100)%360+360)%360;
    const elon=((L-sunLon+360)%360);
    const alt=Math.round(Math.sin(R(Math.min(elon,360-elon)))*65);
    const vis=alt>10,low=alt>=0&&alt<=10;
    return '<div class="planet-card">'+
      '<div class="planet-name">'+p.n+
        '<span class="planet-badge '+(vis?'pb-vis':low?'pb-low':'pb-hid')+'">'+(vis?'Visible':low?'Low':'Below')+'</span></div>'+
      '<div class="planet-alt">~'+(alt>=0?'+':'')+alt+'° alt</div>'+
      '<div class="planet-dist">'+dAU.toFixed(3)+' AU from Earth</div>'+
      '</div>';
  }).join('');
}

function astroGenEvents() {
  const m=new Date().getMonth();
  const SHOWERS=[
    {mo:[0],n:'Quadrantids',p:'Jan 3–4',z:'~120/hr'},
    {mo:[3],n:'Lyrids',p:'Apr 22',z:'~18/hr'},
    {mo:[4],n:'Eta Aquariids',p:'May 5–6',z:'~50/hr'},
    {mo:[6],n:'Delta Aquariids',p:'Jul 28',z:'~25/hr'},
    {mo:[7],n:'Perseids',p:'Aug 11–13',z:'~100/hr'},
    {mo:[9],n:'Orionids',p:'Oct 21',z:'~25/hr'},
    {mo:[10],n:'Leonids',p:'Nov 17–18',z:'~15/hr'},
    {mo:[11],n:'Geminids',p:'Dec 13–14',z:'~150/hr'},
    {mo:[11],n:'Ursids',p:'Dec 22',z:'~10/hr'},
  ];
  const evs=[
    ...SHOWERS.filter(s=>s.mo.some(sm=>Math.abs(sm-m)<=1)).map(s=>({i:'🌠',t:s.n+' Meteor Shower',d:'Peak: '+s.p+' · '+s.z+' · Best after midnight in dark skies.'})),
    {i:'🌌',t:'Milky Way',d:m>=3&&m<=9?'Core well-placed tonight — best 10pm–3am away from city lights.':'Core below horizon. Good for Andromeda & Orion Nebula region.'},
    {i:'🛰',t:'ISS Passes',d:'~16 passes per day. Check Heavens-Above.com for exact times for your location.'},
    {i:'🪐',t:'Saturn's Rings',d:'Rings tilted ~27° toward Earth in 2026 — excellent for small telescopes.'},
    {i:'🌍',t:'Earthshine',d:'Look for the faint glow on the dark lunar limb during crescent phases — sunlight reflected from Earth's oceans.'},
  ];
  const el=document.getElementById('astro-events-list'); if(!el)return;
  el.innerHTML=evs.map(e=>'<div class="ev-item"><div class="ev-icon">'+e.i+'</div><div><div class="ev-title">'+e.t+'</div><div class="ev-desc">'+e.d+'</div></div></div>').join('');
}
