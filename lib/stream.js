// Live channel list broadcast (client-tapped audio, see lib/ws.js) — see
// CLAUDE.md for why the old icecast/ffmpeg server-side cast pipeline was
// removed: neither Spotify (Web Playback SDK) nor radio (client <audio>)
// ever actually played through the server's own audio output, so it only
// ever captured silence.

const WebSocket = require('ws');

const state = require('./state');

// ─── Live channel list broadcast ──────────────────────────────────────────────
function broadcastLiveList() {
  const list = [...state.liveChannels.entries()]
    .filter(([, ch]) => ch.ws?.readyState === WebSocket.OPEN)
    .map(([id, ch]) => ({ id, name: ch.name, avatarUrl: ch.avatarUrl, listeners: ch.listeners.size, mimeType: ch.mimeType, startedAt: ch.startedAt }));
  const msg = JSON.stringify({ type: 'live-list', channels: list });
  for (const [, sockets] of state.deviceClients)
    for (const s of sockets)
      if (s.readyState === WebSocket.OPEN) s.send(msg);
}

// ─── Route setup ──────────────────────────────────────────────────────────────
module.exports = function setupStreamRoutes(app, MAIN_BASE, BASE_PATH = '') {

  app.get('/api/live', (req, res) => {
    const list = [...state.liveChannels.entries()]
      .filter(([, ch]) => ch.ws?.readyState === WebSocket.OPEN)
      .map(([id, ch]) => ({ id, name: ch.name, avatarUrl: ch.avatarUrl, listeners: ch.listeners.size, mimeType: ch.mimeType, startedAt: ch.startedAt }));
    res.json(list);
  });

  return { broadcastLiveList };
};
