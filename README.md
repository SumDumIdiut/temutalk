# TemuTalk Speaker

A self-hosted smart-hub web app — Spotify control, weather, crypto, news, a radio map, and a kitchen timer — all in one HTTPS server with zero build step. Designed to run from a flash drive or any spare Linux box and stay reachable from anywhere via a Cloudflare Tunnel.

## Features

- **Music** — Full Spotify playback control (search, queue, playlists, library, synced lyrics) via the Web Playback SDK, running client-side in the browser — no server-side credential storage.
- **Radio** — Browse and play internet radio stations on an interactive map (Leaflet + radio-browser.info).
- **Weather** — Current conditions and forecast (wttr.in).
- **Finance** — Live crypto prices (CoinGecko).
- **News** — Headlines feed.
- **Timer** — Kitchen timer tab.
- **System** — Theme engine (accent colour, blobs, fonts, glass opacity, corner radius, clock format — all CSS custom properties, persisted in `localStorage`), plus host system stats.
- **Multi-device** — Each browser tab gets its own UUID identity; the server tracks Spotify tokens per device in `devices.json`.

## Quick start

TemuTalk no longer has its own standalone installer — setup, start/stop, and
the terminal menu all now live in one consolidated `install.sh` shared
across the whole codecade stack:

```bash
curl -fsSL https://raw.githubusercontent.com/SumDumIdiut/codecade-install/main/install.sh | bash
```

It clones (or updates) this repo alongside the other apps, installs
`ffmpeg` via `apt` if missing (used server-side to convert browser mic audio
to WAV for local speech-to-text), downloads portable Node.js + `cloudflared`
binaries (no system Node install required), sets up Piper TTS, and handles
the physical-USB-key enrollment that gates the dev panel — then drops you
into a tabbed terminal menu (CONTROL / SERVICES / DIAGNOSTICS) covering
every app, TemuTalk included, not just this one.

Starting the server backgrounds everything (PIDs tracked in `.run/`), so you
can keep using the menu while it runs.

### Web control panel

`install.sh` also starts a small HTTPS control panel, reachable from any device on the same LAN at `https://<this machine's IP>:9090/` (option 7 toggles it, or it's printed on the TUI status line). It lets you start/stop the Node server+tunnel independently of the TUI, plus chat moderation, device monitoring, and account management.

It's gated behind a per-install access token, auto-generated on first start and saved to `.run/panel-token` (gitignored, never leaves the device). Traffic is TLS-encrypted, sessions are HMAC-signed cookies that reset on every panel restart, and repeated wrong-token attempts get rate-limited and temporarily locked out. No setup is "unbreachable," but this is real auth + real encryption, not security theater — see the comment at the top of `control-panel.js` for the exact model.

### Windows

```cmd
Start.bat
```

Windows uses the bundled binaries in `bin/win/`.

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

**Single-file server** (`server.js`) — Express + HTTPS + WebSocket on one port. Serves the SPA from `public/`, exposes REST APIs, proxies Spotify/weather/crypto/radio/lyrics/map-tile requests (keeping API keys server-side), and runs the WebSocket hub for real-time player state.

**SPA shell** (`public/index.html`) — One shell file for the whole app. The home tab renders inline for an immediate first paint. Every other tab (`music`, `radio`, `weather`, `finance`, `news`, `timer`, `system`) lazy-loads its `view.html` fragment into a pre-existing container on first visit. Each tab has its own `style.css` (loaded eagerly) and `script.js` (loaded once, executes at page load).

**Playback** is entirely client-side: Spotify via the Web Playback SDK, radio via a plain `<audio>` element — nothing plays through the server's own audio output, so there's no server-side audio pipeline to manage. (An earlier server-side "Cast" feature captured the host machine's own audio via PulseAudio/ffmpeg/Icecast and re-streamed it — removed once Spotify and radio playback both moved client-side, since it only ever captured silence. A separate, still-live "live broadcast" feature lets a listener tap their own browser's audio output and share it with others in a channel — see `lib/ws.js`'s `live-start`/`live-join` handlers and `lib/stream.js`'s `broadcastLiveList`.) A legacy WebRTC/MSE broadcaster also still exists in `lib/ws.js` (`mse-broadcaster-ready` etc.) as a documented but currently-unused fallback mechanism.

**Connectivity** — `launcher.js` starts `server.js` and a Cloudflare Tunnel (`cloudflared`), restarts either if they crash, and polls `origin/main` every 60s to auto-pull and restart on updates.

**Per-device identity** — Each tab generates a `deviceId` UUID in `localStorage`; every API call appends `?device=<id>`. The server maps device IDs to Spotify tokens, never tying credentials to a single physical machine.

See [CLAUDE.md](CLAUDE.md) for the full internals reference (file-by-file breakdown, key patterns, theme system, OAuth flow details).

## Project layout

| Path | Purpose |
|---|---|
| `control-panel.js` | HTTPS web control panel (token auth), started by the shared `install.sh` (see [codecade-install](https://github.com/SumDumIdiut/codecade-install)) |
| `server.js` | Entire backend |
| `launcher.js` | Production wrapper: process supervision, tunnel, auto-update |
| `public/` | The SPA — shell, per-tab views/scripts/styles |
| `Start.sh` / `Start.bat` / `Start.py` | Legacy platform-specific entry points |
| `Setup.sh` / `Download.sh` / `Check-Update.sh` | Legacy single-purpose scripts, superseded by `install.sh` |
| `devices.json` | Per-device Spotify tokens (gitignored, auto-created) |
| `bin/` | Portable Node + cloudflared binaries (downloaded, gitignored) |

## Troubleshooting

**Site shows a Cloudflare error page / nothing loads** — the tunnel isn't connected. Error `1033` specifically means no `cloudflared` process is running for the hostname. Run the shared `install.sh` → SERVICES → Toggle Tunnel, or check the host machine to see why the process died.

**Styling looks broken / unstyled page** — almost always the same root cause as above (you're looking at a Cloudflare error page, not your actual unstyled HTML). Check `curl -I https://<your-domain>/style.css`.

**TLS warning in browser** — expected on first connect; the server uses a self-signed cert. Accept it once per browser.

## External services used

All proxied through `server.js` to keep API keys server-side and avoid CORS:

- Spotify Web API — playback, search, library
- wttr.in — weather
- CoinGecko — crypto prices
- lrclib.net — synced lyrics
- radio-browser.info — station search
- CartoCDN — map tiles (LRU-cached server-side, up to 8000 tiles)
