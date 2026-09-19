// WebSocket server: MSE relay, live channels, radio tracking.

const WebSocket = require('ws');

const state   = require('./state');
const { broadcastToDevice, broadcastToAll } = require('./broadcast');
const { devices, getDeviceToken } = require('./devices');
const { logEvent } = require('./telemetry');

function relayToClients(str) {
  for (const [, conns] of state.deviceClients)
    for (const c of conns)
      if (c !== state.mseBroadcaster && c.readyState === WebSocket.OPEN) c.send(str);
}

function broadcastListenerCount() {
  if (state.mseBroadcaster?.readyState === WebSocket.OPEN)
    state.mseBroadcaster.send(JSON.stringify({ type: 'mse-listener-count', count: state.mseListeners.size }));
}

module.exports = function setupWebSocket(wss, broadcastLiveList, ASSET_VERSION) {
  // asset-version was previously only ever sent once, on 'join' -- a tab
  // whose WS connection has stayed continuously open since before a
  // deploy would never see it again, since 'join' only fires at connection
  // time. That tab would keep silently running the exact code from before
  // whatever fix just shipped, no matter how many more fixes followed --
  // confirmed as the likely explanation after several assistant fixes in a
  // row each tested correctly but were reported as producing no change at
  // all. Re-broadcasting periodically means even a rock-solid connection
  // eventually notices and reloads (see _checkAssetVersion in index.html).
  setInterval(() => broadcastToAll({ type: 'asset-version', v: ASSET_VERSION }), 60_000);

  wss.on('connection', (ws, req) => {
    const wsIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    state.wsClientIps.set(ws, wsIp);
    let wsDeviceId = null;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        for (const [, ch] of state.liveChannels) {
          if (ch.ws === ws) {
            if (!ch.initChunk) ch.initChunk = Buffer.from(raw);
            for (const cl of ch.listeners) if (cl.readyState === WebSocket.OPEN) cl.send(raw);
            return;
          }
        }
        if (ws === state.mseBroadcaster) {
          if (!state.mseInitChunk) {
            state.mseInitChunk = Buffer.from(raw);
            console.log('[mse] init chunk saved, size:', state.mseInitChunk.length);
          }
          for (const c of state.mseListeners) if (c.readyState === WebSocket.OPEN) c.send(raw);
        }
        return;
      }

      const str = raw.toString();
      let msg;
      try { msg = JSON.parse(str); } catch { return; }

      // Incoming only -- outgoing ws.send() calls are scattered across this
      // file plus lib/broadcast.js, and instrumenting every one individually
      // wasn't worth the invasiveness. This still covers every client-
      // initiated action, which is what "latency" mostly means here.
      logEvent('ws', { dir: 'in', msgType: msg.type, deviceId: wsDeviceId || msg.deviceId });

      if (msg.type === 'join') {
        wsDeviceId = msg.deviceId;
        if (!state.deviceClients.has(wsDeviceId)) state.deviceClients.set(wsDeviceId, new Set());
        state.deviceClients.get(wsDeviceId).add(ws);
        const dev = devices.get(wsDeviceId);
        ws.send(JSON.stringify({ type: 'status', authenticated: !!(dev?.tokens?.access_token) }));
        ws.send(JSON.stringify({ type: 'mse-broadcaster-status', online: !!(state.mseBroadcaster?.readyState === WebSocket.OPEN), mimeType: state.mseMimeType }));
        // Lets an already-open tab notice a deploy happened -- the server
        // restarts (bumping this) on every commit (launcher.js), but nothing
        // else tells a tab that's been sitting open since before that to go
        // get the new code. See _checkAssetVersion() in index.html.
        ws.send(JSON.stringify({ type: 'asset-version', v: ASSET_VERSION }));
        return;
      }

      if (msg.type === 'mse-broadcaster-ready') {
        state.mseBroadcaster = ws;
        state.mseMimeType    = msg.mimeType;
        state.mseInitChunk   = null;
        console.log('[mse] broadcaster connected, mime:', state.mseMimeType);
        relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: true, mimeType: state.mseMimeType }));
        return;
      }

      if (msg.type === 'mse-broadcaster-leave') {
        relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: false }));
        return;
      }

      if (msg.type === 'mse-listener-join') {
        state.mseListeners.add(ws);
        console.log('[mse] listener joined, total:', state.mseListeners.size);
        if (state.mseInitChunk) ws.send(state.mseInitChunk);
        broadcastListenerCount();
        return;
      }

      if (msg.type === 'mse-listener-leave') {
        state.mseListeners.delete(ws);
        broadcastListenerCount();
        return;
      }

      if (msg.type === 'host-play-radio' || msg.type === 'host-stop-radio') {
        if (state.mseBroadcaster?.readyState === WebSocket.OPEN) state.mseBroadcaster.send(str);
        return;
      }

      if (msg.type === 'radio-now-playing' && wsDeviceId) {
        state.radioNowPlaying.set(wsDeviceId, { name: msg.name || '', url: msg.url || '', since: Date.now() });
        return;
      }
      if (msg.type === 'radio-stopped' && wsDeviceId) {
        state.radioNowPlaying.delete(wsDeviceId);
        return;
      }

      // Relay a play/stop/volume command to another device's own tab(s), so
      // it plays through that device's speakers instead of the sender's.
      // Radio has no Connect-style protocol of its own (unlike Spotify) —
      // this is the whole mechanism.
      if (msg.type === 'radio-remote-cmd' && msg.targetDeviceId && msg.action) {
        const targets = state.deviceClients.get(msg.targetDeviceId);
        if (targets?.size) {
          const out = JSON.stringify({
            type: 'radio-remote', action: msg.action, payload: msg.payload || {},
            fromName: wsDeviceId ? (devices.get(wsDeviceId)?.name || '') : '',
          });
          for (const c of targets) if (c.readyState === WebSocket.OPEN) c.send(out);
        }
        return;
      }

      // ── Live multi-channel ──────────────────────────────────────────────────
      if (msg.type === 'live-start' && wsDeviceId) {
        state.liveChannels.set(wsDeviceId, {
          ws, initChunk: null, mimeType: msg.mimeType || 'audio/webm;codecs=opus',
          name: devices.get(wsDeviceId)?.name || ('Device-' + wsDeviceId.slice(0, 6)),
          avatarUrl: null,
          listeners: new Set(), startedAt: Date.now(),
        });
        broadcastLiveList();
        return;
      }
      if (msg.type === 'live-stop' && wsDeviceId) {
        const ch = state.liveChannels.get(wsDeviceId);
        if (ch) {
          const end = JSON.stringify({ type: 'live-channel-ended', channelId: wsDeviceId });
          for (const cl of ch.listeners) if (cl.readyState === WebSocket.OPEN) cl.send(end);
          state.liveChannels.delete(wsDeviceId);
        }
        broadcastLiveList();
        return;
      }
      if (msg.type === 'live-join') {
        for (const c of state.liveChannels.values()) c.listeners.delete(ws);
        const ch = state.liveChannels.get(msg.channelId);
        if (ch) {
          ch.listeners.add(ws);
          if (ch.initChunk) ws.send(ch.initChunk);
          broadcastLiveList();
        }
        return;
      }
      if (msg.type === 'live-leave') {
        for (const ch of state.liveChannels.values()) ch.listeners.delete(ws);
        broadcastLiveList();
        return;
      }
    });

    const cleanup = () => {
      if (wsDeviceId) {
        state.deviceClients.get(wsDeviceId)?.delete(ws);
        if (!state.deviceClients.get(wsDeviceId)?.size) state.radioNowPlaying.delete(wsDeviceId);
      }
      if (ws === state.mseBroadcaster) {
        state.mseBroadcaster = null;
        state.mseInitChunk   = null;
        console.log('[mse] broadcaster disconnected');
        relayToClients(JSON.stringify({ type: 'mse-broadcaster-status', online: false }));
      }
      if (state.mseListeners.delete(ws)) broadcastListenerCount();
      if (wsDeviceId && state.liveChannels.has(wsDeviceId)) {
        const ch = state.liveChannels.get(wsDeviceId);
        const end = JSON.stringify({ type: 'live-channel-ended', channelId: wsDeviceId });
        for (const cl of ch.listeners) if (cl.readyState === WebSocket.OPEN) cl.send(end);
        state.liveChannels.delete(wsDeviceId);
        broadcastLiveList();
      }
      for (const ch of state.liveChannels.values()) ch.listeners.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
};
