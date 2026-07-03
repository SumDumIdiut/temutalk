const WebSocket = require('ws');
const state     = require('./state');

function broadcastToDevice(deviceId, data) {
  const msg = JSON.stringify(data);
  for (const ws of state.deviceClients.get(deviceId) || [])
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

module.exports = { broadcastToDevice };
