# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

```bash
# Recommended — installer + TUI control panel (handles everything)
bash install.sh

# Or run the server directly
node launcher.js
```

`install.sh` installs dependencies, enrolls the USB key, starts the control panel, and drops into a TUI. `launcher.js` checks for remote updates every 60 seconds and auto-pulls + restarts the server when one is found.

The server runs on HTTPS (default port 3001). It auto-generates a self-signed TLS cert on first run (`.cert-key.pem` / `.cert-cert.pem`). The browser requires a one-time "accept certificate" click.

The server auto-creates `.env` if missing. To configure Spotify or change defaults, copy `.env.example` to `.env` and fill in values.

No build step. No lint/test commands. Restart `server.js` to pick up server-side changes; browser tab refresh for client-side changes.

## Architecture

**Single file server** (`server.js`) — Express + HTTPS + WebSocket on one port. Serves the SPA from `public/`, exposes REST APIs, and handles the WebSocket hub for real-time Spotify state updates.

**SPA shell** (`public/index.html`) — One large file that is the entire app. The home tab is rendered inline (immediate paint). All other tabs (`music`, `radio`, `weather`, `finance`, `news`, `timer`, `system`) are lazy-loaded on first visit via `ensureTab(tab)`, which fetches `/<tab>/view.html` and injects it into the pre-existing `<div id="view-<tab>">`. Per-tab styles come from `public/<tab>/style.css` (loaded eagerly in `<head>`); per-tab scripts from `public/<tab>/script.js` (loaded via `<script src>` at the bottom of index.html and execute once on page load).

**Per-device identity** — Each browser tab generates a UUID stored in `localStorage` as `deviceId`. Every API call appends `?device=<deviceId>`. The server maps device IDs to Spotify tokens in `devices.json` (persisted across restarts). Spotify credentials (client ID + secret) are stored only in the browser's localStorage and passed at OAuth time — never stored on the server long-term.

**Spotify OAuth flow** — PKCE. The browser sends `clientId` + `clientSecret` to `/auth/spotify`, which stores them ephemerally in `pkceStore` and redirects to Spotify. On callback the server exchanges the code, stores tokens in `devices`, and notifies the device via WebSocket (`type: 'status'`).

**WebSocket** — One persistent WS per browser tab. On connect the client sends `{ type: 'join', deviceId }`. The server maintains `deviceClients: Map<deviceId, Set<ws>>`. Used for Spotify player state push (`type: 'player'`), and for the "live broadcast" feature below.

**Playback is entirely client-side** — Spotify plays via the Web Playback SDK (`public/music/script.js`, `new Spotify.Player(...)`), radio plays via a plain `<audio>` element (`public/radio/script.js`). Nothing ever plays through the server's own audio output. A previous server-side "Cast" feature (PulseAudio monitor → `ffmpeg` → Icecast2 → `GET /stream` proxy → listener `<audio src="/stream">`) was removed for exactly this reason: since neither Spotify nor radio ever rendered to the server's own PulseAudio sink, that pipeline only ever captured silence or unrelated desktop audio. `getCastDelay()`/`setCastMode()`/the cast button and `lib/stream.js`'s `ffmpegRunning`/`/stream`/`/api/broadcast/*`/`/broadcast` page are all gone; `install.sh` no longer installs `icecast2` or manages an audio source.

**Live broadcast** (unrelated to the old cast feature, still live) — A listener can tap their own browser's Web Audio output (`_liveTapAudio()`/`_liveRecord()` in `public/music/script.js`, via a `MediaRecorder` on an intercepted `AudioNode.connect`) and share it with others in a channel. Client sends `live-start`/`live-stop`/`live-join`/`live-leave` over the existing WS; `lib/ws.js` maintains `state.liveChannels` and calls `lib/stream.js`'s `broadcastLiveList()` on every change, which fans out a `live-list` message to all connected devices. `GET /api/live` returns the same roster over REST.

**MSE legacy broadcaster** — A separate, older WebRTC/MSE relay mechanism still exists in `lib/ws.js` (`mse-broadcaster-ready`, `host-play-radio`/`host-stop-radio`, `state.mseBroadcaster`/`mseListeners`). Nothing currently sends `mse-broadcaster-ready`, so it's unreachable in practice — kept as a documented fallback mechanism, not wired to any current UI. `mseSetBroadcasterOnline()` no-op stubs remain in `index.html`/`tw/index.html` only because the `mse-broadcaster-status` WS handler still calls them.

## Key patterns

**All API calls include `?device=`** via the `api()` helper:
```js
function api(path, opts = {}) {
  return fetch(path + (path.includes('?') ? '&' : '?') + 'device=' + deviceId, opts).then(r => r.json());
}
```
Direct `fetch` calls in tab scripts must append `?device=` manually.

**Tab HTML files** (`public/<tab>/view.html`) contain only the inner HTML fragment — no `<html>`, `<head>`, or `<body>` tags. They are injected verbatim into the view container.

**Theme system** — All theme state is in `localStorage` and applied via CSS custom properties on `<html>`. Accent colour, blob colours, font, glass opacity, corner radius, clock format etc. are all user-configurable from the System tab.

**Auto-update** — `launcher.js` runs `checkForUpdate()` every 60 seconds. It compares the local git HEAD to `origin/main` via `ls-remote`. If behind, it runs `git pull` and restarts the server process. The Cloudflare tunnel is left running.

**External APIs used** (all proxied through server.js to avoid CORS / key exposure):
- Spotify Web API — music playback, search, library
- wttr.in — weather
- CoinGecko — crypto prices
- lrclib.net — synced lyrics
- radio-browser.info — radio station search
- CartoCDN — map tiles (LRU-cached in memory, up to 8000 tiles)

## File map

| Path | Purpose |
|---|---|
| `server.js` | Entire backend: Express routes, WebSocket |
| `launcher.js` | Production wrapper: kills port, starts server, manages Cloudflare tunnel, auto-restarts, auto-updates |
| `install.sh` | Installer + TUI: installs deps, enrolls USB key, starts/stops all components |
| `control-panel.js` | HTTPS web control panel (port 9090), gated by USB key file |
| `lib/stream.js` | Live-broadcast roster (`broadcastLiveList`, `GET /api/live`) — see "Live broadcast" above |
| `lib/assistant.js` | Voice assistant backend: `POST /api/assistant` — tool-use loop on a local Ollama model (weather, finance, news, Spotify, radio) returning `{ reply, actions }`; needs Ollama running with a tool-calling model (`OLLAMA_URL` / `ASSISTANT_MODEL` in `.env`, default llama3.1). Also `POST /api/assistant/stt` (whisper.cpp) and `POST /api/assistant/tts` (Piper, via `lib/tts.js`) |
| `lib/tts.js` | Server-side text-to-speech: shells out to a local Piper install (`bin/linux/piper`, bundled by `install.sh`) and returns WAV bytes. Runs server-side so no client device needs anything installed for voice replies (unlike the browser's `speechSynthesis`, which e.g. needs `speech-dispatcher`/`espeak-ng` installed system-wide on Linux Firefox to produce any audio) |
| `public/assistant/` | Voice assistant UI: fully headless (no UI), wake-word listening starts automatically on page load, speech-to-text via Web Speech API or whisper.cpp fallback, spoken reply played back from `/api/assistant/tts` through a plain `<audio>` element, executes device actions (play_radio, set_timer, send_chat, navigate) via tab-script globals. Only visual feedback is a solid orange edge-glow while awake/processing |
| `public/index.html` | SPA shell: home tab inline, all shared JS, theme engine, WS client |
| `public/style.css` | Global CSS variables and base styles |
| `public/music/script.js` | Music tab JS — `onPlayer()`, `renderProg()`, live-broadcast tap/record (`_liveTapAudio`, `_liveRecord`) |
| `public/<tab>/view.html` | Lazy-loaded HTML fragment for each tab |
| `public/<tab>/script.js` | Tab-specific JS (executes once at page load) |
| `public/<tab>/style.css` | Tab-specific CSS (loaded eagerly) |
| `devices.json` | Persisted per-device Spotify tokens (auto-created, gitignored) |
| `.cloudflared/` | Cloudflare tunnel credentials (gitignored, used by launcher.js) |
| `bin/` | Bundled node + cloudflared binaries for Linux/Windows |
