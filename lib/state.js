// Shared runtime state — imported by all lib modules.
// Mutable reference properties (mseBroadcaster, etc.) are mutated in-place
// so all importers always see the current value.
module.exports = {
  deviceClients:    new Map(),   // deviceId → Set<ws>
  spotifyUserCache: new Map(),   // deviceId → { displayName, email, product, avatarUrl }
  playerStateCache: new Map(),   // deviceId → playerData

  mseBroadcaster:   null,
  mseMimeType:      null,
  mseInitChunk:     null,
  mseListeners:     new Set(),

  liveChannels:     new Map(),   // deviceId → { ws, initChunk, mimeType, name, avatarUrl, listeners, startedAt }
  streamListeners:  new Map(),   // res → { ip, ua, connectedAt }
  wsClientIps:      new WeakMap(), // ws → ip string
  radioNowPlaying:  new Map(),   // deviceId → { name, url, since }
};
