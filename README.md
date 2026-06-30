# TemuTalk Speaker

A self-hosted smart-hub web app — Spotify control, system audio casting to any browser, weather, crypto, news, a radio map, and a kitchen timer — all in one HTTPS server with zero build step. Designed to run from a flash drive or any spare Linux box and stay reachable from anywhere via a Cloudflare Tunnel.

## Features

- **Music** — Full Spotify playback control (search, queue, playlists, library, synced lyrics) via PKCE OAuth, per-browser-tab device identity, no server-side credential storage.
- **Cast** — Streams the host machine's system audio (via `ffmpeg` + Icecast2) to any listening device over plain HTTP audio — no WebRTC, no plugins. The progress bar auto-corrects for stream buffering delay.
- **Radio** — Browse and play internet radio stations on an interactive map (Leaflet + radio-browser.info).
- **Weather** — Current conditions and forecast (wttr.in).
- **Finance** — Live crypto prices (CoinGecko).
- **News** — Headlines feed.
- **Timer** — Kitchen timer tab.
- **System** — Theme engine (accent colour, blobs, fonts, glass opacity, corner radius, clock format — all CSS custom properties, persisted in `localStorage`), plus host system stats.
- **Multi-device** — Each browser tab gets its own UUID identity; the server tracks Spotify tokens per device in `devices.json`.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/SumDumIdiut/temutalk/main/install.sh | bash
```

Or, if you already have a copy of the repo:

```bash
./install.sh
```

`install.sh` is a one-stop installer + control panel. On first run it:

1. Clones (or updates) this repo
2. Installs `icecast2` and `ffmpeg` via `apt` if missing
3. Downloads portable Node.js + `cloudflared` binaries (no system Node install required)
4. Auto-detects your PulseAudio monitor source for audio casting

...then drops you into a terminal menu:

```
 1) Start server      — icecast2 + ffmpeg + Node server + Cloudflare tunnel
 2) Stop server
 3) Open web UI        — where you finish Spotify setup in-browser
 4) Configure audio source
 5) Check for updates
 6) View logs
 7) Exit
```

Starting the server backgrounds everything (PIDs tracked in `.run/`), so you can keep using the menu while it runs.

### Windows

```cmd
Start.bat
```

Windows uses the bundled binaries in `bin/win/` and does not run Icecast/ffmpeg audio casting (Linux-only feature, requires PulseAudio).

### Manual run (no installer)

```bash
node launcher.js
# or, if you just want the server without the update/tunnel wrapper:
node server.js
```

## Configuration

The server auto-creates `.env` on first run with sane defaults. To customize, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `PORT` | HTTPS port (default `3001`) |
| `BASE_URL` | Public base URL, used for Spotify's redirect URI (default `https://codecade.co.za`) |
| `SESSION_SECRET` | Auto-generated random secret |
| `WEATHER_CITY` | Default city shown in the Weather tab |

**Spotify** isn't configured here — client ID/secret are entered per-device in the browser at OAuth time and never persisted server-side beyond the PKCE handshake. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and set its Redirect URI to `<your BASE_URL>/callback`.

The server auto-generates a self-signed TLS certificate (`.cert-key.pem` / `.cert-cert.pem`) on first run. Your browser will need to accept it once.

## Architecture

**Single-file server** (`server.js`) — Express + HTTPS + WebSocket on one port. Serves the SPA from `public/`, exposes REST APIs, proxies Spotify/weather/crypto/radio/lyrics/map-tile requests (keeping API keys server-side), runs the WebSocket hub for real-time player state, and proxies the Icecast audio stream at `/stream`.

**SPA shell** (`public/index.html`) — One shell file for the whole app. The home tab renders inline for an immediate first paint. Every other tab (`music`, `radio`, `weather`, `finance`, `news`, `timer`, `system`) lazy-loads its `view.html` fragment into a pre-existing container on first visit. Each tab has its own `style.css` (loaded eagerly) and `script.js` (loaded once, executes at page load).

**Audio cast pipeline**:
```
PulseAudio monitor source
   → ffmpeg (MP3 192kbps)
   → Icecast2 (:8000/stream)
   → server.js proxy (/stream)
   → listener <audio src="/stream">
```
No WebSockets or MSE involved in the live path — the client just plays an `<audio>` tag. A legacy WebRTC/MSE broadcaster still exists at `/broadcast` as a fallback but isn't used by the cast button.

**Connectivity** — `launcher.js` starts `server.js` and a Cloudflare Tunnel (`cloudflared`), restarts either if they crash, and polls `origin/main` every 60s to auto-pull and restart on updates.

**Per-device identity** — Each tab generates a `deviceId` UUID in `localStorage`; every API call appends `?device=<id>`. The server maps device IDs to Spotify tokens, never tying credentials to a single physical machine.

See [CLAUDE.md](CLAUDE.md) for the full internals reference (file-by-file breakdown, key patterns, theme system, OAuth flow details).

## Project layout

| Path | Purpose |
|---|---|
| `install.sh` | One-stop installer + TUI control panel (recommended entry point) |
| `server.js` | Entire backend |
| `launcher.js` | Production wrapper: process supervision, tunnel, auto-update |
| `public/` | The SPA — shell, per-tab views/scripts/styles |
| `Start.sh` / `Start.bat` / `Start.py` | Legacy platform-specific entry points |
| `Setup.sh` / `Download.sh` / `Check-Update.sh` | Legacy single-purpose scripts, superseded by `install.sh` |
| `icecast.xml` | Bundled Icecast2 config (port 8000, mount `/stream`) |
| `devices.json` | Per-device Spotify tokens (gitignored, auto-created) |
| `bin/` | Portable Node + cloudflared binaries (downloaded, gitignored) |

## Troubleshooting

**Site shows a Cloudflare error page / nothing loads** — the tunnel isn't connected. Error `1033` specifically means no `cloudflared` process is running for the hostname. Run `install.sh` → option 1 (Start server), or check the host machine to see why the process died.

**Styling looks broken / unstyled page** — almost always the same root cause as above (you're looking at a Cloudflare error page, not your actual unstyled HTML). Check `curl -I https://<your-domain>/style.css`.

**TLS warning in browser** — expected on first connect; the server uses a self-signed cert. Accept it once per browser.

**Audio cast silent** — confirm `audio-source.conf` points at a real monitor source (`pactl list sources short`), not a null/virtual sink, and that `ffmpeg` is actually running (`logs/server.log` or `/tmp/speaker-ffmpeg.log`).

## External services used

All proxied through `server.js` to keep API keys server-side and avoid CORS:

- Spotify Web API — playback, search, library
- wttr.in — weather
- CoinGecko — crypto prices
- lrclib.net — synced lyrics
- radio-browser.info — station search
- CartoCDN — map tiles (LRU-cached server-side, up to 8000 tiles)
