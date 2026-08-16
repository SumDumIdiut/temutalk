// ── Voice assistant ──────────────────────────────────────────────────────────
// Fully headless — no UI at all. Wake word listening starts automatically on
// page load and runs continuously in the background; say the wake word, then
// the command. STT → POST /api/assistant → server runs a tool loop on a local
// Ollama model → reply is synthesized server-side (POST /api/assistant/tts,
// local Piper install) and played back through a plain <audio> element, so no
// client needs anything installed for voice replies to work. Device actions
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
  // The only visual feedback left: a solid orange edge border, styled after
  // the accent border on the home screen's mini-cards. Turns on the instant
  // the wake chime plays and stays on (no pulsing) until the whole exchange
  // is done.
  const glow = document.createElement('div');
  glow.id = 'va-glow';
  document.body.appendChild(glow);
  function glowOn()  { glow.classList.add('on'); }
  function glowOff() { glow.classList.remove('on'); }

  // ── Debug transcript overlay (temporary) ───────────────────────────────
  // The assistant is headless by design -- every status/error is
  // console-only, which isn't reachable on a kiosk tablet with no easy
  // devtools access. This surfaces the same messages on screen (any tab,
  // same as the wake glow) plus live speech-to-text as it comes in, so
  // it's possible to tell just by looking whether the mic is picking
  // anything up at all and what it's actually transcribing.
  // No auto-hide -- this is a debugging aid meant to be watched
  // continuously while testing, not a toast. It used to fade out after 8s,
  // which meant it could disappear before there was time to read it, or
  // between one status update and the next; it now just always shows
  // whatever the latest message was, replaced in place by the next one.
  const transcriptEl = document.createElement('div');
  transcriptEl.id = 'va-transcript';
  document.body.appendChild(transcriptEl);
  function showTranscript(text) {
    if (!text) return;
    transcriptEl.textContent = text;
    transcriptEl.classList.add('on');
  }

  // ── Heartbeat (temporary diagnostic) ────────────────────────────────────
  // Deliberately separate from showTranscript()/setStatus() -- every
  // previous fix tonight has been individually verified in isolation to
  // produce a visible message when its specific failure mode trips, yet the
  // on-device report after every single one has stayed exactly "Armed",
  // never anything else. That means either this tab still isn't running
  // today's code (checked -- it is: codecade.co.za serves the current
  // ASSET_VERSION, matching the latest deploy), or something is dying
  // silently in a spot none of those specific fixes cover. This counter is
  // untouched by any wake-loop/engine logic, so it answers the first
  // question directly (does this script run at all, continuously) and the
  // engine/call counts answer the second (which engine got picked, and is
  // it actually still being re-entered or did it run once and stop).
  const hbEl = document.createElement('div');
  hbEl.id = 'va-heartbeat';
  document.body.appendChild(hbEl);
  let hbSeconds = 0;
  window._vaCounters = { srCalls: 0, recorderCalls: 0 };
  setInterval(() => {
    hbSeconds++;
    const c = window._vaCounters;
    hbEl.textContent = 'alive ' + hbSeconds + 's · engine ' + (SR ? 'SR' : 'recorder') +
      ' · SR#' + c.srCalls + ' rec#' + c.recorderCalls;
  }, 1000);

  // ── State ───────────────────────────────────────────────────────────────
  let busy        = false;  // command round-trip in flight
  let speaking    = false;  // TTS playing (don't listen to ourselves)
  let listening   = false;  // any capture in progress
  let wakeEnabled = true;   // always on — no UI toggle
  let wakeLoopOn  = false;
  let cancelCapture = null; // cancels the in-flight recorder capture
  let srSession   = null;
  // Set true if SpeechRecognition fails with a permission/hardware error --
  // falls back to the recorder engine instead of retrying an engine that's
  // never going to work forever, silently, with no visibility at all.
  let srBroken    = false;

  // No visual UI beyond the wake glow — status is console-only for
  // debugging; replies/errors are always spoken in full via TTS instead.
  function setStatus(msg, isErr) {
    if (!msg) return;
    console.log('[assistant]', isErr ? 'error:' : 'status:', msg);
    showTranscript((isErr ? 'Error: ' : '') + msg);
  }
  function setListening(on) { listening = on; }
  function setBotSpeaking() { /* no-op — kept for call-site symmetry, no UI to update */ }

  // ── Audio helpers ───────────────────────────────────────────────────────
  let micStream = null, chimeCtx = null, micCtx = null;

  // getUserMedia can hang indefinitely on some platforms instead of cleanly
  // resolving or rejecting (a stuck permission dialog, a driver-level mic
  // issue) -- confirmed as the likely cause after even the live mic-level
  // readout inside captureUtterance() (which only ever runs once this
  // resolves) never appeared on screen at all, meaning execution never got
  // past this call. Racing it against a timeout turns "hangs forever with
  // zero feedback" into a real, visible, catchable error.
  function _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms')), ms)),
    ]);
  }

  async function ensureMic() {
    if (micStream && micStream.active) return micStream;
    micStream = await _withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 6000, 'getUserMedia');
    unlockAudio(); // closest thing to a user gesture we get in the headless flow
    _resumeAllContexts();
    return micStream;
  }
  // A suspended AudioContext just never runs its audio graph -- resume() is
  // the only thing that changes that, and it needs a real (or gesture-
  // adjacent) trigger to actually take effect under strict autoplay policy.
  // Called from every point that counts as such a trigger, so any context
  // that's been created but is still stuck suspended gets another shot.
  function _resumeAllContexts() {
    for (const c of [chimeCtx, micCtx]) if (c && c.state === 'suspended') c.resume().catch(() => {});
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
      catch (e) { setStatus('Mic blocked: ' + (e && e.message || e), true); return resolve(null); }

      // Reused across calls rather than a fresh AudioContext per utterance.
      // A brand new context needs its own resume() to leave 'suspended'
      // under strict autoplay policy, and this headless flow has no
      // guaranteed real user gesture to provide that on every single call --
      // only the one instance ever gets a real unlock trigger (see
      // unlockAudio/_resumeAllContexts), so it has to be the same instance
      // every time or every call after the first would be stuck again.
      const ac = micCtx || (micCtx = new (window.AudioContext || window.webkitAudioContext)());
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
      let noise = 0.004, lastLoud = 0, startedAt = 0, lastLevelShown = 0;
      const t0 = Date.now();

      function finish(blob) {
        if (finished) return;
        finished = true;
        cancelCapture = null;
        clearTimeout(audioWatchdog);
        try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch (_) {}
        resolve(cancelled ? null : blob);
      }
      cancelCapture = () => { cancelled = true; finish(null); };

      // A suspended AudioContext just never runs its audio graph at all --
      // onaudioprocess wouldn't fire, so nothing above (not even the level
      // readout) would ever show, indistinguishable from outside "Armed"
      // with nothing else ever happening again. Confirmed as the likely
      // explanation after the level readout itself -- unconditional,
      // updates every 700ms regardless of actual mic level -- was reported
      // as never appearing at all, meaning execution never reached it.
      // Closes and drops the shared context on a real stall so the next
      // attempt builds a fresh one, in case this specific instance (not
      // just the autoplay policy generally) is what's wedged.
      let gotAudioEvent = false;
      const audioWatchdog = setTimeout(() => {
        if (gotAudioEvent || finished) return;
        console.error('[assistant] onaudioprocess never fired -- AudioContext stuck at', ac.state);
        setStatus('Mic capture stalled (audio context ' + ac.state + ') — retrying', true);
        try { ac.close().catch(() => {}); } catch (_) {}
        if (micCtx === ac) micCtx = null;
        finish(null);
      }, 4000);

      proc.onaudioprocess = (e) => {
        gotAudioEvent = true;
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
          const threshold = Math.max(0.012, noise * 3.5);
          // Live mic-level readout (temporary debug aid) -- this is the one
          // place that can actually answer "is the mic bad": a level that
          // never leaves ~0 means the mic isn't being captured at all; a
          // nonzero level that just never crosses the threshold means it's
          // a real but quiet/weak mic, not a total failure. Both looked
          // identical from outside before this -- "Armed" and nothing else,
          // for up to startTimeoutMs (previously 1 full hour).
          if (now - lastLevelShown > 700) {
            lastLevelShown = now;
            showTranscript('Listening… level ' + rms.toFixed(4) + ' / need ' + threshold.toFixed(4));
          }
          if (rms > threshold) {
            started = true; startedAt = now; lastLoud = now;
            rec.push(...preRoll); // include the pre-roll so the first word survives
            showTranscript('Recording…');
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
    const r = await fetch(BASE_PATH + '/api/assistant/stt?device=' + encodeURIComponent(deviceId), {
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
      window._vaCounters.recorderCalls++;
      if (busy || speaking || listening) { await sleep(300); continue; }
      const blob = await captureUtterance({ startTimeoutMs: 3600000, maxMs: 10000, silenceMs: 1100 });
      if (!wakeEnabled) break;
      // A null blob with no real elapsed time means ensureMic() itself
      // rejected (mic blocked/missing) rather than a normal silence
      // timeout -- captureUtterance's own startTimeoutMs already paces the
      // silence-timeout case, but a hard mic failure resolves instantly,
      // and with no delay here that turned into a tight loop hammering
      // getUserMedia repeatedly instead of backing off.
      if (!blob) { await sleep(2000); continue; }
      if (busy || speaking || listening) continue;
      // Fires the moment voice-activity detection actually captured
      // something, before the transcription round-trip -- confirms the mic
      // is picking up audio at all even before there's text to show.
      showTranscript('Transcribing…');
      let text = '';
      try { text = await sttBlob(blob); }
      catch (e) { setStatus(e.message, true); await sleep(5000); continue; }
      showTranscript('Heard: ' + (text || '(nothing)'));
      const m = matchWake(text);
      if (m) await handleWokenCommand(m.command);
    }
  }

  // Background loop, SR engine: continuous recognition, restart on end.
  // If a recognition session never fires a single event (no result, no
  // error, no end) it's not "nothing said yet" -- a real continuous
  // session at least ends and restarts on its own periodically. This is a
  // *different* failure mode than an explicit error: the engine looks
  // started (no exception, no onerror) but never actually gets fed real
  // microphone audio, so it just sits there forever with nothing to show
  // -- which is exactly "always Armed, never changes." Counts consecutive
  // fully-silent sessions and falls back to the recorder engine (same as
  // srBroken) once that streak gets suspicious, same threshold logic as
  // the explicit-error path above.
  const SR_WATCHDOG_MS = 8000;
  const SR_SILENT_STREAK_LIMIT = 3;
  let srSilentStreak = 0;

  function wakeLoopSR() {
    window._vaCounters.srCalls++;
    if (!wakeEnabled || busy || speaking || srBroken) return;
    const rec = new SR();
    srSession = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    // Was false -- turned on so partial results can be shown live via
    // showTranscript() as they come in (temporary debug aid, see above).
    // Wake-word matching below still only ever acts on isFinal results,
    // exactly as before -- this only adds visibility, not new match attempts.
    rec.interimResults = true;

    let gotEvent = false;
    const watchdog = setTimeout(() => {
      if (gotEvent) return;
      srSilentStreak++;
      console.error('[assistant] SpeechRecognition produced no events at all for', SR_WATCHDOG_MS, 'ms (streak', srSilentStreak, ') -- treating as hung, not just quiet');
      try { rec.onresult = rec.onerror = rec.onend = null; rec.abort(); } catch (_) {}
      srSession = null;
      if (srSilentStreak >= SR_SILENT_STREAK_LIMIT) {
        srBroken = true;
        setStatus('Speech recognition unresponsive after ' + srSilentStreak + ' attempts — falling back to recorder engine.', true);
        if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
      } else {
        setStatus('Speech recognition unresponsive, retrying (' + srSilentStreak + '/' + SR_SILENT_STREAK_LIMIT + ')…', true);
        setTimeout(wakeLoopSR, 500);
      }
    }, SR_WATCHDOG_MS);

    rec.onresult = (e) => {
      gotEvent = true; clearTimeout(watchdog); srSilentStreak = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (!e.results[i].isFinal) { showTranscript('Hearing: ' + transcript); continue; }
        showTranscript('Heard: ' + transcript);
        const m = matchWake(transcript);
        if (m) {
          try { rec.onend = null; rec.stop(); } catch (_) {}
          srSession = null;
          handleWokenCommand(m.command).finally(() => setTimeout(wakeLoopSR, 400));
          return;
        }
      }
    };
    // Used to be a no-op -- any SpeechRecognition error, including a
    // denied/missing mic, was silently swallowed and the loop just kept
    // retrying forever with zero visibility. getUserMedia (which shows a
    // real, visible permission prompt) is only ever called on the recorder
    // engine below; SR handles microphone access internally, which doesn't
    // necessarily surface any prompt the user can actually see or respond
    // to on every platform -- exactly "doesn't work, never got the prompt."
    // 'no-speech'/'aborted' are routine (nothing said in the timeout
    // window, or a deliberate .stop()) and not worth acting on. The rest
    // mean this device's SpeechRecognition engine genuinely isn't going to
    // work -- fall back to the recorder engine instead, which does call
    // getUserMedia and gives that permission prompt an actual chance to fire.
    rec.onerror = (e) => {
      gotEvent = true; clearTimeout(watchdog);
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.error('[assistant] SpeechRecognition error:', e.error);
      if (e.error === 'not-allowed' || e.error === 'audio-capture' || e.error === 'service-not-allowed') {
        srBroken = true;
        setStatus('Speech recognition unavailable (' + e.error + ') — falling back to recorder engine.', true);
        try { rec.onend = null; } catch (_) {}
        srSession = null;
        if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
      }
    };
    rec.onend = () => {
      gotEvent = true; clearTimeout(watchdog);
      srSession = null; if (wakeEnabled && !srBroken) setTimeout(wakeLoopSR, 500);
    };
    try { rec.start(); }
    catch (e) {
      // rec.start() throwing synchronously (rather than firing the async
      // onerror above) is a real, distinct failure mode -- some browsers do
      // this for a permanently-denied/OS-blocked mic permission instead of
      // ever dispatching an error event. This used to retry silently every
      // 2s forever with zero visibility -- indistinguishable from outside
      // "Armed" and nothing else, exactly the reported symptom, and on a
      // path none of this session's other fixes (all in the async
      // onresult/onerror/watchdog handlers, or the separate recorder
      // engine) could ever reach, since none of them run until *after*
      // start() succeeds.
      clearTimeout(watchdog);
      srSilentStreak++;
      console.error('[assistant] rec.start() threw synchronously:', e && e.message || e, '(streak', srSilentStreak, ')');
      if (srSilentStreak >= SR_SILENT_STREAK_LIMIT) {
        srBroken = true;
        setStatus('Speech recognition failed to start (' + (e && e.message || e) + ') — falling back to recorder engine.', true);
        if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
      } else {
        setStatus('Speech recognition failed to start: ' + (e && e.message || e) + ' — retrying (' + srSilentStreak + '/' + SR_SILENT_STREAK_LIMIT + ')…', true);
        setTimeout(wakeLoopSR, 2000);
      }
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function startWake() {
    if (!SR) {
      try { await ensureMic(); }
      catch (e) { wakeEnabled = false; setStatus('Mic blocked: ' + (e && e.message || e) + ' — wake word needs mic access.', true); return; }
    }
    unlockAudio(); // SR path never calls ensureMic(), so it never got a chance to run this
    setStatus('Armed — say ' + wakeWord());
    if (SR) wakeLoopSR();
    else if (!wakeLoopOn) { wakeLoopOn = true; wakeLoopRecorder().finally(() => { wakeLoopOn = false; }); }
  }

  // ── Text to speech ──────────────────────────────────────────────────────
  // Synthesized server-side (POST /api/assistant/tts, local Piper install —
  // see lib/tts.js) and played back through a plain <audio> element. This
  // replaces the browser's speechSynthesis entirely: that API depends on an
  // OS-level speech engine the client may not have (e.g. Firefox on Linux
  // needs speech-dispatcher + espeak-ng installed system-wide, and silently
  // produces no audio at all without it). Playing a WAV byte stream from the
  // server works in every browser, on every device, with nothing to install.
  const player = new Audio();
  let _playerUrl = null;
  function _revokePlayerUrl() { if (_playerUrl) { URL.revokeObjectURL(_playerUrl); _playerUrl = null; } }
  player.addEventListener('ended', () => { speaking = false; setBotSpeaking(false); _revokePlayerUrl(); });
  player.addEventListener('error', () => { speaking = false; setBotSpeaking(false); _revokePlayerUrl(); });

  // <audio>.play() is still gated behind a user gesture in most browsers —
  // same reasoning as the old speechSynthesis unlock, just aimed at a real
  // media element instead. First click/touch/key (or a granted mic
  // permission, the closest we get in the headless flow) plays it once,
  // muted, to unlock playback for the rest of the session. Muted playback
  // outside a real gesture (e.g. from ensureMic()) doesn't reliably count
  // as an unlock in every browser though, so if an actual spoken reply gets
  // blocked, it's stashed and retried the moment a genuine gesture happens.
  //
  // Uses its own throwaway element rather than `player` — sharing one
  // element meant a real reply's play() could land while the unlock
  // sequence's mute/pause/unmute was still settling and silently inherit
  // muted=true: play() resolves fine either way, so nothing ever errors,
  // it just plays with no sound.
  let _audioUnlocked = false;
  let _pendingSpeech = null;
  function unlockAudio() {
    if (!_audioUnlocked) {
      _audioUnlocked = true;
      try {
        chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {}
      _resumeAllContexts();
      try {
        const primer = new Audio();
        primer.muted = true;
        primer.play().then(() => primer.pause()).catch(() => {});
      } catch (_) {}
    }
  }
  ['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
    unlockAudio();
    if (_pendingSpeech) { const t = _pendingSpeech; _pendingSpeech = null; speak(t); }
  }, { once: true, passive: true }));

  // ── Duck the music volume while speaking ────────────────────────────────
  // Smoothly lowers whatever's currently playing (Spotify/YouTube/Apple —
  // setVolume() in music/script.js already abstracts over all of them),
  // then smoothly brings it back once the reply finishes.
  function _tweenVolume(from, to, ms) {
    return new Promise((resolve) => {
      if (typeof setVolume !== 'function' || from == null) return resolve();
      const steps = 12;
      const stepMs = ms / steps;
      let i = 0;
      const iv = setInterval(() => {
        i++;
        // A throw here (e.g. from setVolume touching a stale player
        // reference) must never stop the loop from finishing and
        // resolving — speak() awaits this, and a hang here would leave
        // `speaking` stuck true forever, silently blocking the wake loop.
        try { setVolume(Math.round(from + (to - from) * (i / steps))); } catch (_) {}
        if (i >= steps) { clearInterval(iv); resolve(); }
      }, stepMs);
    });
  }
  function _currentVolume() {
    const el = document.getElementById('fp-vol');
    return (el && typeof playing !== 'undefined' && playing) ? parseInt(el.value, 10) : null;
  }

  async function speak(text) {
    if (!text) return;
    if (localStorage.getItem('vaTts') === 'off') return; // voice replies disabled in settings
    const origVol = _currentVolume();
    const duckVol = origVol != null ? Math.round(origVol * 0.25) : null;
    let ducked = false;
    try {
      const rate = parseFloat(localStorage.getItem('vaTtsRate')) || 1.05;
      const r = await fetch(BASE_PATH + '/api/assistant/tts?device=' + encodeURIComponent(deviceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rate }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || ('HTTP ' + r.status));
      }
      const blob = await r.blob();
      _revokePlayerUrl();
      _playerUrl = URL.createObjectURL(blob);
      player.src = _playerUrl;
      player.muted = false;
      player.volume = 1;
      speaking = true;
      setBotSpeaking(true);
      if (origVol != null) { await _tweenVolume(origVol, duckVol, 350); ducked = true; }
      await player.play();
      // Race against a hard timeout — some engines/edge cases never fire
      // 'ended'/'error' at all, and without this speak() would hang forever,
      // leaving `speaking` stuck true and silently blocking the wake loop
      // from ever listening again.
      await Promise.race([
        new Promise((resolve) => {
          const done = () => { player.removeEventListener('ended', done); player.removeEventListener('error', done); resolve(); };
          player.addEventListener('ended', done);
          player.addEventListener('error', done);
        }),
        new Promise((resolve) => setTimeout(resolve, Math.min(30000, 2000 + text.length * 90))),
      ]);
      // Don't rely solely on the persistent 'ended'/'error' listener (set up
      // once at player creation) to clear these — if the timeout above is
      // what actually resolved this race, that listener never fires either.
      speaking = false;
      setBotSpeaking(false);
      if (ducked) await _tweenVolume(duckVol, origVol, 350);
    } catch (e) {
      console.warn('[assistant] TTS failed:', e.name || '', e.message || e);
      // Blocked by the browser's autoplay gesture requirement rather than a
      // real failure — replay it the moment the user next touches the page.
      if (e && e.name === 'NotAllowedError') _pendingSpeech = text;
      if (ducked) _tweenVolume(duckVol, origVol, 350);
      speaking = false;
      setBotSpeaking(false);
    }
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
      const r = await fetch(BASE_PATH + '/api/assistant?device=' + encodeURIComponent(deviceId), {
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
