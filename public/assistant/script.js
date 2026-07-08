// ── Voice assistant ──────────────────────────────────────────────────────────
// Mic button → speech-to-text → POST /api/assistant → server runs a tool loop
// on a local Ollama model → reply is spoken via speechSynthesis and device
// actions (radio, timers, chat, navigation) are executed here using the
// globals the tab scripts already define (playStation, addTimer, ws, …).
//
// Speech-to-text engines, best first:
//   1. Web Speech API (Chrome/Edge with Google STT)
//   2. MediaRecorder + silence detection → POST /api/assistant/stt
//      (local whisper.cpp on the server — works in Firefox/Chromium)
//
// Wake word ("hey temu", localStorage 'vaWakeWord'): opt-in toggle in the
// panel. Background-listens for utterances, discards anything that doesn't
// start with the wake word, runs the rest as a command.

(function () {
  'use strict';

  // ── DOM ─────────────────────────────────────────────────────────────────
  const MIC_SVG =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  const btn = document.createElement('button');
  btn.id = 'va-btn';
  btn.title = 'Voice assistant';
  btn.innerHTML = MIC_SVG;

  const panel = document.createElement('div');
  panel.id = 'va-panel';
  panel.innerHTML =
    '<div class="va-hdr"><span class="va-title">Assistant</span>' +
    '<button class="va-close" title="Close">✕</button></div>' +
    '<div class="va-log" id="va-log"><div class="va-log-hint" id="va-log-hint">Ask me anything, or say the wake word.</div></div>' +
    '<div class="va-status" id="va-status"></div>' +
    '<div class="va-input-row">' +
    '<input class="va-input" id="va-input" placeholder="Type a command…" autocomplete="off">' +
    '<button class="va-mic" id="va-mic" title="Speak">' + MIC_SVG + '</button>' +
    '<button class="va-send" id="va-send" title="Send">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
    '</button></div>' +
    '<div class="va-wake-row" id="va-wake-row">' +
    '<div class="va-toggle" id="va-wake-toggle"><div class="va-toggle-knob"></div></div>' +
    '<span>Wake word <b id="va-wake-word"></b></span></div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const $status     = panel.querySelector('#va-status');
  const $log        = panel.querySelector('#va-log');
  const $logHint    = panel.querySelector('#va-log-hint');
  const $input      = panel.querySelector('#va-input');
  const $micInner   = panel.querySelector('#va-mic');
  const $wakeToggle = panel.querySelector('#va-wake-toggle');

  // ── Chat log ────────────────────────────────────────────────────────────
  // Replaces the old single-turn transcript/reply lines with a scrollable
  // running history, so a session reads like an actual conversation.
  const LOG_MAX_MSGS = 16;
  let $pendingUserBubble = null; // live-updates while STT/SR is still talking

  function logScrollBottom() { $log.scrollTop = $log.scrollHeight; }
  function logTrim() {
    while ($log.children.length > LOG_MAX_MSGS) $log.removeChild($log.firstChild);
  }
  function logEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function logUserLive(text) {
    if ($logHint) { $logHint.remove(); }
    if (!$pendingUserBubble) {
      const row = document.createElement('div');
      row.className = 'va-msg va-msg-user';
      row.innerHTML = '<div class="va-bubble"></div>';
      $log.appendChild(row);
      $pendingUserBubble = row.querySelector('.va-bubble');
      logTrim();
    }
    $pendingUserBubble.textContent = text;
    logScrollBottom();
  }
  function logUserFinal(text) {
    logUserLive(text);
    $pendingUserBubble = null; // next utterance starts a fresh bubble
  }
  function logBot(text, isError) {
    if ($logHint) { $logHint.remove(); }
    const row = document.createElement('div');
    row.className = 'va-msg va-msg-bot';
    row.innerHTML = '<div class="va-bubble' + (isError ? ' va-bubble-err' : '') + '"></div>';
    row.querySelector('.va-bubble').textContent = text;
    $log.appendChild(row);
    logTrim();
    logScrollBottom();
    return row;
  }
  function setBotSpeaking(on) {
    const bubbles = $log.querySelectorAll('.va-msg-bot .va-bubble');
    const last = bubbles[bubbles.length - 1];
    if (last) last.classList.toggle('va-speaking', on);
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Wake word + voice settings are read live so the System-tab settings apply
  // without a reload.
  function wakeWord() { return (localStorage.getItem('vaWakeWord') || 'hey temu').toLowerCase(); }

  // ── State ───────────────────────────────────────────────────────────────
  let busy        = false;  // command round-trip in flight
  let speaking    = false;  // TTS playing (don't listen to ourselves)
  let listening   = false;  // any capture in progress
  // Wake mode is never auto-armed on load (see the bottom of this file for
  // why) — always starts off, regardless of what was remembered last time.
  let wakeEnabled = false;
  const _wakeWasOnLastTime = localStorage.getItem('vaWake') === 'on';
  let wakeLoopOn  = false;
  let cancelCapture = null; // cancels the in-flight recorder capture
  let srSession   = null;

  function setStatus(msg, isErr) {
    $status.textContent = msg || '';
    $status.classList.toggle('va-err', !!isErr);
  }
  function setListening(on) {
    listening = on;
    btn.classList.toggle('va-listening', on);
    $micInner.classList.toggle('va-listening', on);
  }
  function renderWake() {
    $wakeToggle.classList.toggle('on', wakeEnabled);
    btn.classList.toggle('va-wake', wakeEnabled);
    panel.querySelector('#va-wake-word').textContent = '“' + wakeWord() + '”';
  }

  // ── Audio helpers ───────────────────────────────────────────────────────
  let micStream = null, chimeCtx = null;

  async function ensureMic() {
    if (micStream && micStream.active) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      catch (_) { setStatus('Microphone blocked — allow mic access or type instead.', true); return resolve(null); }

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
        logUserLive(lastInterim);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed') setStatus('Microphone blocked — allow mic access or type instead.', true);
      };
      rec.onend = () => { srSession = null; resolve((finalText.trim() || lastInterim).trim()); };
      try { rec.start(); } catch (_) { resolve(''); }
    });
  }

  // ── Unified one-shot listen ─────────────────────────────────────────────
  async function listenOnce() {
    if (busy || listening) return;
    // A background wake-word capture may be mid-flight — take over the mic.
    if (cancelCapture) cancelCapture();
    if (srSession) { try { srSession.onend = null; srSession.stop(); } catch (_) {} srSession = null; }
    // Clean up an empty bubble left by a previous attempt that yielded nothing.
    if ($pendingUserBubble && !$pendingUserBubble.textContent.trim()) {
      $pendingUserBubble.closest('.va-msg')?.remove();
      $pendingUserBubble = null;
    }
    setListening(true);
    setStatus('Listening…');
    let text = '';
    try {
      if (SR) {
        text = await srListenOnce();
      } else {
        const blob = await captureUtterance();
        if (blob) {
          setStatus('Transcribing…');
          text = await sttBlob(blob);
          logUserLive(text);
        }
      }
    } catch (e) {
      setListening(false);
      setStatus(e.message || 'Speech recognition failed.', true);
      return;
    }
    setListening(false);
    if (text) submit(text);
    else if (!$status.classList.contains('va-err')) setStatus('Didn’t catch that — tap the mic to try again.');
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
    panel.classList.add('open');
    if (!command) {
      // Wake word alone — listen for the command as the next utterance
      setListening(true);
      setStatus('Yes?');
      if (SR) command = await srListenOnce();
      else {
        const blob = await captureUtterance({ startTimeoutMs: 6000 });
        if (blob) { setStatus('Transcribing…'); command = await sttBlob(blob).catch(() => ''); logUserLive(command); }
      }
      setListening(false);
    }
    if (command) await submit(command);
    else setStatus('');
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

  async function setWake(on) {
    wakeEnabled = on;
    localStorage.setItem('vaWake', on ? 'on' : 'off');
    renderWake();
    if (on) {
      if (!SR) {
        try { await ensureMic(); }
        catch (_) { wakeEnabled = false; localStorage.setItem('vaWake', 'off'); renderWake(); setStatus('Microphone blocked — wake word needs mic access.', true); return; }
      }
      setStatus('Wake word on — say ' + wakeWord() + '.');
      if (SR) wakeLoopSR();
      else if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
    } else {
      if (cancelCapture) cancelCapture();
      if (srSession) { try { srSession.onend = null; srSession.stop(); } catch (_) {} srSession = null; }
      if (!SR) releaseMic();
      setStatus('');
    }
  }

  // ── Text to speech ──────────────────────────────────────────────────────
  // Voice choice (System tab → Voice assistant → Voice) is stored as the
  // browser's own voiceURI so it survives across sessions on this device.
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
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = parseFloat(localStorage.getItem('vaTtsRate')) || 1.05;
      const voice = pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = navigator.language || 'en-US';
      speaking = true;
      u.onend = u.onerror = () => { speaking = false; setBotSpeaking(false); };
      speechSynthesis.speak(u);
      setBotSpeaking(true);
      // Safety: some engines never fire onend
      setTimeout(() => { speaking = false; setBotSpeaking(false); }, Math.min(30000, 2000 + text.length * 90));
    } catch (_) { speaking = false; setBotSpeaking(false); }
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
    // Wake word said into any capture path (tap-to-talk included):
    // strip it, and if it was said alone, chime and ask for the command.
    const woke = matchWake(text);
    if (woke) {
      if (woke.command) text = woke.command;
      else return handleWokenCommand('');
    }
    busy = true;
    logUserFinal(text);
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
      logBot(reply);
      setStatus('');
      speak(reply);
    } catch (e) {
      const msg = e.message || 'Something went wrong.';
      logBot(msg, true);
      setStatus('');
    } finally {
      busy = false;
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  function openPanel(withVoice) {
    panel.classList.add('open');
    if (withVoice) listenOnce();
    else $input.focus();
  }
  function closePanel() {
    if (!wakeEnabled && cancelCapture) cancelCapture();
    if (!wakeEnabled && srSession) { try { srSession.stop(); } catch (_) {} }
    if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (_) {} speaking = false; }
    panel.classList.remove('open');
  }

  btn.addEventListener('click', () => {
    if (listening) { // tap again = stop the current capture early
      if (cancelCapture) cancelCapture();
      if (srSession) { try { srSession.stop(); } catch (_) {} }
      setListening(false);
    } else if (panel.classList.contains('open')) closePanel();
    else openPanel(true);
  });
  panel.querySelector('.va-close').addEventListener('click', closePanel);
  $micInner.addEventListener('click', () => {
    if (listening) { if (cancelCapture) cancelCapture(); if (srSession) { try { srSession.stop(); } catch (_) {} } }
    else listenOnce();
  });
  $wakeToggle.parentElement.addEventListener('click', () => setWake(!wakeEnabled));
  panel.querySelector('#va-send').addEventListener('click', () => {
    const v = $input.value.trim();
    if (v) { $input.value = ''; submit(v); }
  });
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = $input.value.trim();
      if (v) { $input.value = ''; submit(v); }
    }
    if (e.key === 'Escape') closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
  });

  renderWake();
  // Wake mode deliberately does NOT auto-resume on page load. Opening the
  // microphone (whether via getUserMedia or the browser's own Web Speech
  // API) makes the OS/browser renegotiate the active audio device — on many
  // systems (especially Bluetooth speakers/headsets switching from a
  // stereo-playback profile to a mic-capable one) that briefly interrupts or
  // pauses whatever else is playing, including audio in a completely
  // unrelated browser tab. Silently re-arming the mic on every refresh was
  // causing exactly that. One explicit tap on the toggle re-enables it.
  if (_wakeWasOnLastTime) setStatus('Wake word was on last time — tap to resume.');
})();
