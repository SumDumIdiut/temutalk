# TemuTalk — Design Specification

## 1. Overview

TemuTalk is a personal, multi-device web application combining music
playback control, internet radio, weather, financial and news data, a
voice assistant, and a real-time chat/live-broadcast system. It is
designed as a single-page application backed by a single-file Node.js
server, intended for a small, known set of devices rather than public
signup.

## 2. Goals

- **One server process, one port.** All functionality — REST API,
  WebSocket hub, static asset serving — is served from a single Express
  process to keep operational overhead minimal.
- **Client-side playback.** No audio is ever rendered on the server.
  Every playback surface (Spotify, internet radio) plays directly in the
  requesting browser tab, so server load does not scale with listening
  time.
- **No server-side install requirement for voice.** Text-to-speech is
  synthesized server-side via a bundled, portable engine so that no
  client device needs any audio software installed to receive spoken
  responses.
- **Device-scoped identity, not account-scoped.** Each browser tab is a
  distinct logical device with its own persisted state; there is no
  central login requirement for core functionality.

## 3. Architecture

### 3.1 Server (`server.js`)

A single Express application providing:

- HTTPS termination using a self-signed certificate, generated on first
  run if not already present.
- REST endpoints, namespaced per feature area (music, radio, weather,
  finance, news, assistant).
- A WebSocket hub for real-time state push (player state, live broadcast
  rosters, chat).

### 3.2 Frontend

A single-page application shell (`public/index.html`) that renders its
home view immediately, and lazily loads all other views on first
navigation. Each view consists of three files loaded independently:

| File | Loaded | Purpose |
|---|---|---|
| `<tab>/view.html` | On first navigation to that tab | HTML fragment, injected into a pre-existing container |
| `<tab>/style.css` | Eagerly, at page load | Tab-specific styling |
| `<tab>/script.js` | Eagerly, at page load | Tab-specific behavior, executes once |

### 3.3 Identity and persistence

Each browser tab generates a UUID on first load, stored in
`localStorage`. This device identifier is appended to every API call. The
server maintains a mapping from device identifier to authorization state
(for example, Spotify tokens) in a persisted JSON file, so state survives
a server restart without requiring a database.

### 3.4 Playback

- **Spotify** plays through the official Web Playback SDK, running
  entirely in the browser.
- **Internet radio** plays through a standard HTML audio element pointed
  at a station stream URL.
- Neither path ever routes audio through the server process. A prior
  design that captured server-side audio output for a "cast" feature was
  removed because, by design, nothing was ever rendered to the server's
  own audio device — that pipeline could only ever have captured silence.

### 3.5 Live broadcast

Independent of the playback design above, a listener may capture their
own browser's audio output (via a `MediaRecorder` attached to an
intercepted audio graph node) and share that stream with other connected
devices in a named channel. Channel membership and stream chunks are
relayed entirely over the existing WebSocket connection; no separate
media server is involved.

### 3.6 Voice assistant

A headless interaction surface (no persistent visible UI) that:

1. Listens for a wake phrase using the browser's speech recognition API,
   with a local `whisper.cpp` fallback for environments where that API is
   unavailable.
2. Sends the transcribed request to the server, which runs a tool-use
   loop against a locally hosted language model to decide on an action
   (playing radio, setting a timer, sending a chat message, navigating a
   tab, or answering a factual question).
3. Synthesizes the reply server-side using a bundled, portable
   text-to-speech engine and streams the resulting audio back for
   playback.

### 3.7 Authentication (Spotify)

Standard OAuth 2.0 with PKCE. Third-party client credentials are supplied
by the browser at authorization time and held only in `localStorage` —
they are never persisted server-side beyond the brief window needed to
complete the authorization code exchange.

## 4. Deployment

TemuTalk is one of the applications managed by the shared `install.sh`
installer described in the top-level `DESIGN_SPEC.md`, but is also
independently runnable via its own production wrapper, which polls its
git remote on an interval and restarts itself automatically when a new
commit is available.

TemuTalk operates its own Cloudflare Tunnel, separate from the tunnel
used by the shared portal, so that it remains independently reachable
when run standalone.

## 5. External Dependencies

| Provider | Purpose |
|---|---|
| Spotify Web API | Music playback, search, library access |
| wttr.in | Weather data |
| CoinGecko | Cryptocurrency pricing |
| lrclib.net | Synchronized lyrics |
| radio-browser.info | Internet radio station directory |
| CartoCDN | Map tile imagery, cached in memory |

All third-party API calls are proxied through the server, both to avoid
browser CORS restrictions and to avoid exposing provider credentials to
the client where the provider's own flow does not require it.

## 6. Administration

An administrative console — chat moderation, device management, account
management, and a remote terminal — is provided as part of the shared
Dev Panel service (see the top-level `DESIGN_SPEC.md`, section 6). Access
is gated by possession of a physical key file rather than a password; the
server stores only a cryptographic hash of the key's content.
