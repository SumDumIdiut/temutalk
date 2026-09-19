# TemuTalk Speaker

A self-hosted smart-hub web app — Spotify control, weather, crypto, news, a radio map, a kitchen timer, and a voice assistant — all in one HTTPS server with zero build step. Runs from a flash drive or any spare Linux box, stays reachable from anywhere via a Cloudflare Tunnel.

## Features

- **Music** — Full Spotify playback control via the Web Playback SDK, client-side, no server-side credential storage.
- **Radio** — Browse and play internet radio stations on an interactive map.
- **Weather, crypto prices, news headlines, kitchen timer.**
- **Voice assistant** — Always-listening wake word, speech-to-text, Piper TTS replies, and a tool-use loop against a local Ollama model to actually take actions (play a station, set a timer, navigate tabs).
- **Live broadcast** — Share your own browser's audio with others in a channel.
- **Theming** — Full visual customization, persisted per browser.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/SumDumIdiut/codecade-install/main/install.sh | bash
```

Installs portable Node.js, sets up TTS, and drops you into a TUI covering every app in the stack, TemuTalk included.

**Windows:** `Start.bat`

**Manual (no installer):**
```bash
node launcher.js   # or `node server.js` for just the server, no auto-update/tunnel
```

## Configuration

Auto-creates `.env` with sane defaults on first run; copy `.env.example` to customize (`PORT`, `BASE_URL`, `WEATHER_CITY`, `OLLAMA_URL`/`ASSISTANT_MODEL`). Spotify credentials are entered per-device in the browser at OAuth time, never stored server-side. Generates a self-signed TLS cert on first run (accept it once in your browser).

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Entire backend |
| `launcher.js` | Process supervision, tunnel, auto-update |
| `lib/assistant.js` | Voice assistant tool-use loop |
| `lib/tts.js` | Server-side text-to-speech |
| `public/` | The single-page app |

## Troubleshooting

- **Nothing loads / Cloudflare error page** — the tunnel isn't connected; restart it.
- **TLS warning** — expected on first connect (self-signed cert); accept once.
- **Voice assistant silent** — check Ollama is running with a tool-calling model pulled.
