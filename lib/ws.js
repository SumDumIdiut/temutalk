// WebSocket server: MSE relay, live channels, radio tracking, chat dispatch.

const WebSocket = require('ws');

const state   = require('./state');
const { broadcastToDevice } = require('./broadcast');
const { devices, getDeviceToken } = require('./devices');
const chat    = require('./chat');
const games   = require('./games');

function relayToClients(str) {
  for (const [, conns] of state.deviceClients)
    for (const c of conns)
      if (c !== state.mseBroadcaster && c.readyState === WebSocket.OPEN) c.send(str);
}

function broadcastListenerCount() {
  if (state.mseBroadcaster?.readyState === WebSocket.OPEN)
    state.mseBroadcaster.send(JSON.stringify({ type: 'mse-listener-count', count: state.mseListeners.size }));
}

module.exports = function setupWebSocket(wss, broadcastLiveList) {
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

      if (msg.type === 'join') {
        wsDeviceId = msg.deviceId;
        if (!state.deviceClients.has(wsDeviceId)) state.deviceClients.set(wsDeviceId, new Set());
        state.deviceClients.get(wsDeviceId).add(ws);
        const dev = devices.get(wsDeviceId);
        ws.send(JSON.stringify({ type: 'status', authenticated: !!(dev?.tokens?.access_token) }));
        ws.send(JSON.stringify({ type: 'mse-broadcaster-status', online: !!(state.mseBroadcaster?.readyState === WebSocket.OPEN), mimeType: state.mseMimeType }));
        chat.sendFriendData(ws, wsDeviceId);
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

      // ── Live multi-channel ──────────────────────────────────────────────────
      if (msg.type === 'live-start' && wsDeviceId) {
        state.liveChannels.set(wsDeviceId, {
          ws, initChunk: null, mimeType: msg.mimeType || 'audio/webm;codecs=opus',
          name: chat.chatGetName(wsDeviceId), avatarUrl: chat.chatGetAvatarUrl(wsDeviceId),
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

      // ── Chat ────────────────────────────────────────────────────────────────
      if (msg.type.startsWith('chat:') || msg.type === 'chat:ghost-join') {
        chat.handleChatMessage(ws, msg, wsDeviceId);
      }

      // ── Games ────────────────────────────────────────────────────────────────
      if (msg.type.startsWith('game:')) {
        games.handleGameMessage(ws, msg, wsDeviceId);
      }
    });

    const cleanup = () => {
      if (wsDeviceId) {
        state.deviceClients.get(wsDeviceId)?.delete(ws);
        if (!state.deviceClients.get(wsDeviceId)?.size) state.radioNowPlaying.delete(wsDeviceId);
        chat.handleDisconnect(wsDeviceId);
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
