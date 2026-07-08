// ── Voice assistant ──────────────────────────────────────────────────────────
// Fully headless — no UI at all. Wake word listening starts automatically on
// page load and runs continuously in the background; say the wake word, then
// the command. STT → POST /api/assistant → server runs a tool loop on a local
// Ollama model → reply is spoken via speechSynthesis and device actions
// (radio, timers, chat, navigation) are executed here using the globals the
// tab scripts already define (playStation, addTimer, ws, …).
//
// Speech-to-text engines, best first:
//   1. Web Speech API (Chrome/Edge with Google STT)
//   2. MediaRecorder + silence detection → POST /api/assistant/stt
//      (local whisper.cpp on the server — works in Firefox/Chromium)

(function () {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Wake word + voice settings are read live so the System-tab settings apply
  // without a reload.
  function wakeWord() { return (localStorage.getItem('vaWakeWord') || 'hey temu').toLowerCase(); }

  // ── Wake glow ───────────────────────────────────────────────────────────
  // The only visual feedback left: an orange edge-glow overlay. Turns on the
  // instant the wake chime plays, pulses while actively capturing the user's
  // spoken command, and fades out once the whole exchange is done.
  const glow = document.createElement('div');
  glow.id = 'va-glow';
  document.body.appendChild(glow);
  function glowOn()      { glow.classList.add('on'); }
  function glowOff()     { glow.classList.remove('on', 'pulse'); }
  function glowPulse(on) { glow.classList.toggle('pulse', on); }

  // ── State ───────────────────────────────────────────────────────────────
  let busy        = false;  // command round-trip in flight
  let speaking    = false;  // TTS playing (don't listen to ourselves)
  let listening   = false;  // any capture in progress
  let wakeEnabled = true;   // always on — no UI toggle
  let wakeLoopOn  = false;
  let cancelCapture = null; // cancels the in-flight recorder capture
  let srSession   = null;

  // No visual UI beyond the wake glow — status is console-only for
  // debugging; replies/errors are always spoken in full via TTS instead.
  function setStatus(msg, isErr) { if (msg) console.log('[assistant]', isErr ? 'error:' : 'status:', msg); }
  function setListening(on) { listening = on; glowPulse(on); }
  function setBotSpeaking() { /* no-op — kept for call-site symmetry, no UI to update */ }

  // ── Audio helpers ───────────────────────────────────────────────────────
  let micStream = null, chimeCtx = null;

  async function ensureMic() {
    if (micStream && micStream.active) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    unlockAudio(); // closest thing to a user gesture we get in the headless flow
    return micStream;
  }
  function releaseMic() {
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  }
  function chime() {
    try {
      chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (chimeCtx.state === 'suspended') chimeCtx.resume().catch(() => {});
      [[0, 660], [0.12, 990]].forEach(([t0, f]) => {
        const o = chimeCtx.createOscillator(), g = chimeCtx.createGain();
        o.connect(g); g.connect(chimeCtx.destination);
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, chimeCtx.currentTime + t0);
        g.gain.linearRampToValueAtTime(0.4, chimeCtx.currentTime + t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, chimeCtx.currentTime + t0 + 0.18);
        o.start(chimeCtx.currentTime + t0); o.stop(chimeCtx.currentTime + t0 + 0.2);
      });
    } catch (_) {}
  }

  // ── Engine 2: raw-PCM capture + silence detection → /api/assistant/stt ─
  // Captures PCM through a ScriptProcessor so we can keep a 0.6s pre-roll
  // ring buffer — the start of the first word is never clipped — and track
  // an adaptive noise floor instead of a fixed volume threshold.

  function pcmToWav(chunks, sampleRate) {
    const len = chunks.reduce((s, c) => s + c.length, 0);
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wr(36, 'data'); v.setUint32(40, len * 2, true);
    let off = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Waits for speech, records until trailing silence. Resolves with a WAV
  // Blob, or null on timeout/cancel/too-short blip.
  function captureUtterance({ startTimeoutMs = 8000, maxMs = 12000, silenceMs = 1300 } = {}) {
    return new Promise(async (resolve) => {
      let stream;
      try { stream = await ensureMic(); }
      catch (_) { setStatus('Mic blocked', true); return resolve(null); }

      const ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      const rate = ac.sampleRate;
      const src  = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(2048, 1, 1);
      const mute = ac.createGain();
      mute.gain.value = 0; // ScriptProcessor only runs when routed to the destination

      const PRE_MAX = Math.round(rate * 0.6);
      const preRoll = [];
      let preLen = 0;
      const rec = [];
      let started = false, finished = false, cancelled = false;
      let noise = 0.004, lastLoud = 0, startedAt = 0;
      const t0 = Date.now();

      function finish(blob) {
        if (finished) return;
        finished = true;
        cancelCapture = null;
        try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch (_) {}
        ac.close().catch(() => {});
        resolve(cancelled ? null : blob);
      }
      cancelCapture = () => { cancelled = true; finish(null); };

      proc.onaudioprocess = (e) => {
        if (finished) return;
        const input = e.inputBuffer.getChannelData(0);
        const chunk = new Float32Array(input); // copy — the buffer is reused
        let sum = 0;
        for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
        const rms = Math.sqrt(sum / chunk.length);
        const now = Date.now();

        if (!started) {
          // Track ambient level while idle; speech = well above the floor.
          noise = Math.min(0.02, noise * 0.95 + rms * 0.05);
          preRoll.push(chunk); preLen += chunk.length;
          while (preLen - preRoll[0].length > PRE_MAX) preLen -= preRoll.shift().length;
          if (rms > Math.max(0.012, noise * 3.5)) {
            started = true; startedAt = now; lastLoud = now;
            rec.push(...preRoll); // include the pre-roll so the first word survives
          } else if (now - t0 > startTimeoutMs) {
            return finish(null); // nobody spoke
          }
        } else {
          rec.push(chunk);
          if (rms > Math.max(0.01, noise * 3)) lastLoud = now;
          const over = now - lastLoud > silenceMs || now - startedAt > maxMs;
          if (over) {
            // Ignore sub-300ms blips (door slam, cough)
            if (lastLoud - startedAt < 300) return finish(null);
            return finish(pcmToWav(rec, rate));
          }
        }
      };

      src.connect(proc);
      proc.connect(mute);
      mute.connect(ac.destination);
    });
  }

  async function sttBlob(blob) {
    const r = await fetch('/api/assistant/stt?device=' + encodeURIComponent(deviceId), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return (data.text || '').trim();
  }

  // ── Engine 1: Web Speech API ────────────────────────────────────────────
  function srListenOnce() {
    return new Promise((resolve) => {
      const rec = new SR();
      srSession = rec;
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      let finalText = '', lastInterim = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        lastInterim = (finalText + interim).trim();
        if (lastInterim) setStatus(lastInterim);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed') setStatus('Mic blocked', true);
      };
      rec.onend = () => { srSession = null; resolve((finalText.trim() || lastInterim).trim()); };
      try { rec.start(); } catch (_) { resolve(''); }
    });
  }

  // ── Wake word ───────────────────────────────────────────────────────────
  // Fuzzy word-level match, generalized to any wake phrase the user sets
  // (not hardcoded to "hey temu"). STT mishears short names constantly —
  // "hey temu" comes back as "hey teamie", "hey timmy", "hey tamu", etc. —
  // so exact substring matching alone misses real wake attempts.
  //
  // Levenshtein distance, normalized by word length, catches those variants.
  // Two tolerances, tuned against a battery of real mishearings vs. ordinary
  // sentences (see the session's tuning notes): the full-phrase match (every
  // wake-word token present in sequence, e.g. "hey" + "temu"-ish) is a strong
  // enough signal to allow looser tolerance; a bare last-word match (no "hey"
  // anchor — covers a clipped/dropped lead-in) is weaker, so it's held to a
  // tighter tolerance to avoid firing on unrelated words like "timer" or
  // "tell". A first-letter gate on every token is a cheap additional guard —
  // ASR rarely mangles a word's opening sound.
  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }
  function _fuzzyWordEq(w, tok, tol) {
    if (!w || !tok || w[0] !== tok[0]) return false;
    return _levenshtein(w, tok) / Math.max(w.length, tok.length, 1) <= tol;
  }
  const WAKE_TOL_FULL = 0.5;  // every wake-word token present, in order
  const WAKE_TOL_LAST = 0.34; // bare last-token fallback (no "hey" anchor)

  // Returns null (no wake) or { command } — command may be '' meaning
  // "woke up, but no command in the same breath".
  function matchWake(text) {
    const wakeTokens = wakeWord().split(/\s+/).filter(Boolean);
    const words = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length || !wakeTokens.length) return null;

    // Full phrase, allowing up to 2 filler words before it starts
    // ("um, hey temu", "so hey temu…").
    const maxStart = Math.min(2, Math.max(0, words.length - wakeTokens.length));
    for (let start = 0; start <= maxStart; start++) {
      let ok = true;
      for (let i = 0; i < wakeTokens.length; i++) {
        if (!_fuzzyWordEq(words[start + i], wakeTokens[i], WAKE_TOL_FULL)) { ok = false; break; }
      }
      if (ok) return { command: words.slice(start + wakeTokens.length).join(' ') };
    }

    // Bare last-token fallback (the distinctive "name" part of the phrase),
    // near the start of the utterance — covers a mis-heard/clipped lead-in.
    const lastTok = wakeTokens[wakeTokens.length - 1];
    if (lastTok.length >= 3) {
      for (let start = 0; start <= Math.min(2, words.length - 1); start++) {
        if (_fuzzyWordEq(words[start], lastTok, WAKE_TOL_LAST)) {
          return { command: words.slice(start + 1).join(' ') };
        }
      }
    }
    return null;
  }

  async function handleWokenCommand(command) {
    chime();
    glowOn();
    try {
      if (!command) {
        // Wake word alone — listen for the command as the next utterance
        setListening(true);
        setStatus('Yes?');
        if (SR) command = await srListenOnce();
        else {
          const blob = await captureUtterance({ startTimeoutMs: 6000 });
          if (blob) { setStatus('Transcribing…'); command = await sttBlob(blob).catch(() => ''); }
        }
        setListening(false);
      }
      if (command) await submit(command);
      else setStatus('');
    } finally {
      glowOff();
    }
  }

  // Background loop, recorder engine: VAD-gated utterances → STT → wake check.
  async function wakeLoopRecorder() {
    while (wakeEnabled) {
      if (busy || speaking || listening) { await sleep(300); continue; }
      const blob = await captureUtterance({ startTimeoutMs: 3600000, maxMs: 10000, silenceMs: 1100 });
      if (!wakeEnabled) break;
      if (!blob || busy || speaking || listening) continue;
      let text = '';
      try { text = await sttBlob(blob); }
      catch (e) { setStatus(e.message, true); await sleep(5000); continue; }
      const m = matchWake(text);
      if (m) await handleWokenCommand(m.command);
    }
  }

  // Background loop, SR engine: continuous recognition, restart on end.
  function wakeLoopSR() {
    if (!wakeEnabled || busy || speaking) return;
    const rec = new SR();
    srSession = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const m = matchWake(e.results[i][0].transcript);
        if (m) {
          try { rec.onend = null; rec.stop(); } catch (_) {}
          srSession = null;
          handleWokenCommand(m.command).finally(() => setTimeout(wakeLoopSR, 400));
          return;
        }
      }
    };
    rec.onerror = () => {};
    rec.onend = () => { srSession = null; if (wakeEnabled) setTimeout(wakeLoopSR, 500); };
    try { rec.start(); } catch (_) { setTimeout(wakeLoopSR, 2000); }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function startWake() {
    if (!SR) {
      try { await ensureMic(); }
      catch (_) { wakeEnabled = false; setStatus('Mic blocked — wake word needs mic access.', true); return; }
    }
    setStatus('Armed — say ' + wakeWord());
    if (SR) wakeLoopSR();
    else if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
  }

  // ── Text to speech ──────────────────────────────────────────────────────
  // Voice choice (System tab → Voice assistant → Voice) is stored as the
  // browser's own voiceURI so it survives across sessions on this device.
  // Every reply and error is spoken in full — with no transcript panel
  // anymore, TTS is the only place the full text is available.
  //
  // Chrome (and embedded WebViews especially) will silently swallow
  // speechSynthesis.speak() — no error, no sound — until the page has seen
  // at least one real user gesture. The old floating mic button used to
  // supply that gesture for free; now that everything is headless/automatic
  // there may never be one, so we grab the very first click/touch/key on the
  // page (or the mic permission grant) and use it to "prime" the engine.
  let _audioUnlocked = false;
  function unlockAudio() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    try {
      chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (chimeCtx.state === 'suspended') chimeCtx.resume().catch(() => {});
    } catch (_) {}
    try {
      if ('speechSynthesis' in window) {
        if (speechSynthesis.paused) speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch (_) {}
  }
  ['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, unlockAudio, { once: true, passive: true }));

  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const uri = localStorage.getItem('vaVoiceURI');
    if (!uri) return null;
    return speechSynthesis.getVoices().find(v => v.voiceURI === uri) || null;
  }
  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    if (localStorage.getItem('vaTts') === 'off') return; // voice replies disabled in settings
    try {
      if (speechSynthesis.paused) speechSynthesis.resume(); // known Chrome bug: stays paused after idle
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = parseFloat(localStorage.getItem('vaTtsRate')) || 1.05;
      const voice = pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = navigator.language || 'en-US';
      speaking = true;
      u.onend = () => { speaking = false; setBotSpeaking(false); };
      u.onerror = (e) => { console.warn('[assistant] TTS error:', e.error); speaking = false; setBotSpeaking(false); };
      speechSynthesis.speak(u);
      setBotSpeaking(true);
      // Safety: some engines never fire onend
      setTimeout(() => { speaking = false; setBotSpeaking(false); }, Math.min(30000, 2000 + text.length * 90));
    } catch (e) { console.warn('[assistant] TTS failed:', e); speaking = false; setBotSpeaking(false); }
  }

  // ── Device actions returned by the server ───────────────────────────────
  function runAction(a) {
    try {
      switch (a.type) {
        case 'play_radio':
          if (typeof playStation === 'function' && a.station) playStation(a.station);
          break;
        case 'stop_radio':
          if (typeof stopRadio === 'function') stopRadio();
          break;
        case 'set_timer':
          if (typeof addTimer === 'function') {
            addTimer(a.seconds, a.label || timerFmt(a.seconds));
            // addTimer creates timers paused — voice timers should run
            const t = timers[timers.length - 1];
            if (t) {
              t.running = true;
              if (!timerInterval) timerInterval = setInterval(tickTimers, 1000);
              renderTimers();
              if (typeof updateHomeTimers === 'function') updateHomeTimers();
            }
          }
          break;
        case 'send_chat':
          if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'chat:msg', room: a.room || 'global', text: a.text }));
          break;
        case 'navigate':
          if (typeof navigate === 'function') navigate(a.tab);
          break;
      }
    } catch (e) { console.warn('[assistant] action failed:', a.type, e); }
  }

  // ── Send a command to the server ────────────────────────────────────────
  async function submit(text) {
    if (busy || !text) return;
    // Wake word said into any capture path: strip it, and if it was said
    // alone, chime and ask for the command.
    const woke = matchWake(text);
    if (woke) {
      if (woke.command) text = woke.command;
      else return handleWokenCommand('');
    }
    busy = true;
    setStatus('Thinking…');
    try {
      const r = await fetch('/api/assistant?device=' + encodeURIComponent(deviceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          context: {
            tab: typeof curTab !== 'undefined' ? curTab : null,
            radioPlaying: typeof radioStation !== 'undefined' && !!radioStation,
            coords: (typeof wxLocQuery !== 'undefined' && wxLocQuery) || null,
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      (data.actions || []).forEach(runAction);
      const reply = data.reply || 'Done.';
      setStatus(reply);
      speak(reply);
    } catch (e) {
      const msg = e.message || 'Something went wrong.';
      setStatus(msg, true);
      speak(msg);
    } finally {
      busy = false;
    }
  }

  // ── Auto-start ───────────────────────────────────────────────────────────
  // No toggle, no button — wake word listening starts as soon as the page
  // loads. Note: opening the mic (getUserMedia or Web Speech API) can make
  // the OS/browser renegotiate the active audio device (notably Bluetooth
  // speakers switching profiles), which may briefly interrupt audio playing
  // in another tab. Accepted tradeoff for always-on hands-free listening.
  startWake();
})();
