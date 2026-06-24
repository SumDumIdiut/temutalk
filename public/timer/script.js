// ── Shared AudioContext ────────────────────────────────────────────────────
let _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
  return _audioCtx;
}

function _pingAudio() {
  const ctx = _getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
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
  _pingAudio(); // prime AudioContext during the tap gesture that creates the timer
  const id = Date.now();
  timers.push({ id, total: totalSecs, remaining: totalSecs, label, running: false, done: false });
  renderTimers();
  if (typeof updateHomeTimers === 'function') updateHomeTimers();
  if (!timerInterval) timerInterval = setInterval(tickTimers, 1000);
  _startAudioKeepAlive();
}
function addCustomTimer() {
  const inp = document.getElementById('timer-custom-val');
  if (!inp) return;
  const val = inp.value.trim();
  if (!val) return;
  let secs = 0;
  if (val.includes(':')) { const parts = val.split(':'); secs = (+parts[0]) * 60 + (+parts[1]); }
  else secs = +val;
  if (secs > 0) { addTimer(Math.round(secs), timerFmt(Math.round(secs))); inp.value = ''; }
}
function tickTimers() {
  let changed = false;
  const justDone = [];
  timers.forEach(t => {
    if (t.running && t.remaining > 0) {
      t.remaining--;
      changed = true;
      if (t.remaining === 0) { t.done = true; t.running = false; justDone.push(t); }
    }
  });
  if (changed) { renderTimers(); updateHomeTimers(); }
  justDone.forEach(t => { try { notifyTimer(t); } catch(e) {} });
}
function notifyTimer(t) {
  try {
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('Timer done!', { body: t.label || 'Timer', icon: '/favicon.ico' });
  } catch(e) {}
  const ctx = _getAudioCtx();
  if (!ctx) return;
  const play = () => {
    const beeps = [[0, 880], [0.22, 1108], [0.44, 880], [0.66, 1108]];
    const reps = 3, repGap = 1.1;
    for (let r = 0; r < reps; r++) {
      beeps.forEach(([offset, freq]) => {
        const t0 = 0.05 + r * repGap + offset;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0,    ctx.currentTime + t0);
        g.gain.linearRampToValueAtTime(1.0, ctx.currentTime + t0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + 0.22);
        o.start(ctx.currentTime + t0);
        o.stop(ctx.currentTime + t0 + 0.25);
      });
    }
  };
  if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {}); else play();
}

function removeTimer(id) {
  timers = timers.filter(t => t.id !== id);
  renderTimers();
  if (typeof updateHomeTimers === 'function') updateHomeTimers();
  if (!timers.some(t => t.running)) { clearInterval(timerInterval); timerInterval = null; }
}
function toggleTimer(id) {
  const t = timers.find(t => t.id === id);
  if (!t || t.done) return;
  _pingAudio();
  t.running = !t.running;
  if (t.running && !timerInterval) timerInterval = setInterval(tickTimers, 1000);
  renderTimers();
  if (typeof updateHomeTimers === 'function') updateHomeTimers();
}
function resetTimer(id) {
  const t = timers.find(t => t.id === id);
  if (!t) return;
  t.remaining = t.total; t.running = false; t.done = false;
  renderTimers();
  if (typeof updateHomeTimers === 'function') updateHomeTimers();
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
