// All chat: state, persistence, helpers, WS message handlers, REST routes.

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const WebSocket = require('ws');

const state   = require('./state');
const { broadcastToDevice } = require('./broadcast');
const { devices } = require('./devices');

// ─── Constants ────────────────────────────────────────────────────────────────
const PANEL_BOT_ID         = 'panel-bot';
const TEST_USER_ID         = 'test-user';
const CHAT_MSG_LIMIT       = 200;
const CHAT_GLOBAL_CLEAR_MS = 12 * 60 * 60 * 1000;
const CHAT_STATE_FILE      = path.join(__dirname, '..', '.chat-state.json');

// ─── State ────────────────────────────────────────────────────────────────────
const chatGhostTokens  = new Map();
const chatGhostDevices = new Set();
const chatNames        = new Map();
const chatAvatars      = new Map();
const chatProfiles     = new Map();
const chatGlobal       = { messages: [] };
const chatGroups       = new Map();
const chatDMs          = new Map();
const chatFriends      = new Map();
const chatFriendReqs   = new Map();
const chatCalls        = new Map();
const chatAccounts     = new Map();
let   chatSaveTimer    = null;

// ─── Persistence ──────────────────────────────────────────────────────────────
function buildSaveData() {
  return {
    accounts: Object.fromEntries(chatAccounts),
    profiles: Object.fromEntries(chatProfiles),
    names:    Object.fromEntries(chatNames),
    avatars:  Object.fromEntries(chatAvatars),
    groups:   [...chatGroups.values()].map(g => ({
      id: g.id, name: g.name, passwordHash: g.passwordHash,
      messages: g.messages.slice(-CHAT_MSG_LIMIT),
      members:  [...g.members],
      created:  g.created,
    })),
    dms:        [...chatDMs.entries()].map(([k, v]) => ({ key: k, messages: v.messages.slice(-CHAT_MSG_LIMIT) })),
    friends:    [...chatFriends.entries()].map(([k, v]) => [k, [...v]]),
    friendReqs: [...chatFriendReqs.entries()].map(([k, v]) => [k, [...v]]),
    global:     chatGlobal.messages.slice(-CHAT_MSG_LIMIT),
  };
}

function chatSave() {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(() => {
    fs.writeFile(CHAT_STATE_FILE, JSON.stringify(buildSaveData()), err => {
      if (err) console.error('[chat] save error:', err.message);
    });
  }, 2000);
}

function chatSaveSync() {
  clearTimeout(chatSaveTimer);
  try { fs.writeFileSync(CHAT_STATE_FILE, JSON.stringify(buildSaveData())); }
  catch (e) { console.error('[chat] sync save error:', e.message); }
}

(function chatLoad() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.accounts || {})) chatAccounts.set(k, v);
    for (const [k, v] of Object.entries(data.profiles || {})) chatProfiles.set(k, v);
    for (const [k, v] of Object.entries(data.names    || {})) chatNames.set(k, v);
    for (const [k, v] of Object.entries(data.avatars  || {})) chatAvatars.set(k, v);
    for (const g of (data.groups || []))
      chatGroups.set(g.id, { ...g, members: new Set(g.members || []), messages: g.messages || [] });
    for (const { key, messages } of (data.dms || [])) chatDMs.set(key, { messages: messages || [] });
    for (const [k, v] of (data.friends    || [])) chatFriends.set(k, new Set(v));
    for (const [k, v] of (data.friendReqs || [])) chatFriendReqs.set(k, new Set(v));
    if (data.global) chatGlobal.messages = data.global;
    console.log('[chat] state loaded');
  } catch (e) { if (e.code !== 'ENOENT') console.error('[chat] load error:', e.message); }
})();

process.on('exit',    chatSaveSync);
process.on('SIGINT',  () => { chatSaveSync(); process.exit(0); });
process.on('SIGTERM', () => { chatSaveSync(); process.exit(0); });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function chatGetName(id) {
  if (id === PANEL_BOT_ID) return 'Server';
  if (id === TEST_USER_ID) return 'Test User';
  const u = state.spotifyUserCache.get(id);
  if (u?.displayName) return u.displayName;
  if (chatProfiles.has(id)) return chatProfiles.get(id).name;
  if (chatNames.has(id))    return chatNames.get(id);
  return 'User-' + id.slice(0, 6);
}

function chatGetAvatarUrl(id) {
  if (id === PANEL_BOT_ID) return null;
  if (id === TEST_USER_ID) return null;
  return chatAvatars.get(id) || state.spotifyUserCache.get(id)?.avatarUrl || chatProfiles.get(id)?.avatarUrl || null;
}

function chatRoomMessages(room) {
  if (room === 'global')         return chatGlobal.messages;
  if (room.startsWith('dm:'))    return chatDMs.get(room)?.messages   ?? null;
  if (room.startsWith('group:')) return chatGroups.get(room)?.messages ?? null;
  return null;
}

function chatCanAccess(deviceId, room) {
  if (chatGhostDevices.has(deviceId)) return true;
  if (room === 'global') return true;
  if (room.startsWith('dm:'))    return room.slice(3).split(':').includes(deviceId);
  if (room.startsWith('group:')) return chatGroups.get(room)?.members.has(deviceId) ?? false;
  return false;
}

function chatGetRoomTargets(room) {
  const targets = new Set(chatGhostDevices);
  if (room === 'global') {
    for (const id of state.deviceClients.keys()) targets.add(id);
  } else if (room.startsWith('dm:')) {
    for (const id of room.slice(3).split(':')) targets.add(id);
  } else if (room.startsWith('group:')) {
    const g = chatGroups.get(room);
    if (g) for (const m of g.members) targets.add(m);
  }
  return targets;
}

function chatBroadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [, conns] of state.deviceClients)
    for (const c of conns)
      if (c.readyState === WebSocket.OPEN) c.send(msg);
}

function chatBroadcastRoom(room, data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const devId of chatGetRoomTargets(room)) {
    if (devId === excludeId) continue;
    for (const c of state.deviceClients.get(devId) || [])
      if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

function chatGetCallParticipants(room, includeGhosts = false) {
  const ps = chatCalls.get(room) || new Set();
  return includeGhosts ? [...ps] : [...ps].filter(id => !chatGhostDevices.has(id));
}

function chatGenerateGhostToken() {
  const token = crypto.randomBytes(24).toString('hex');
  chatGhostTokens.set(token, Date.now() + 60_000);
  setTimeout(() => chatGhostTokens.delete(token), 60_000);
  return token;
}

// ─── Global clear schedule ────────────────────────────────────────────────────
;(function chatScheduleGlobalClear() {
  const now  = Date.now();
  const next = Math.ceil((now + 1) / CHAT_GLOBAL_CLEAR_MS) * CHAT_GLOBAL_CLEAR_MS;
  setTimeout(() => {
    chatGlobal.messages = [];
    chatBroadcastAll({ type: 'chat:clear', room: 'global' });
    chatSave();
    chatScheduleGlobalClear();
  }, next - now).unref();
})();

// ─── WS: send friend data on join ─────────────────────────────────────────────
function sendFriendData(ws, wsDeviceId) {
  const myFriends = chatFriends.get(wsDeviceId);
  if (myFriends?.size) {
    ws.send(JSON.stringify({
      type: 'chat:friends-list',
      friends: [...myFriends].map(id => ({ id, name: chatGetName(id), avatarUrl: chatGetAvatarUrl(id) })),
    }));
    for (const friendId of myFriends) {
      const dmKey = 'dm:' + [wsDeviceId, friendId].sort().join(':');
      if (chatDMs.has(dmKey))
        ws.send(JSON.stringify({ type: 'chat:history', room: dmKey, messages: chatDMs.get(dmKey).messages.slice(-100) }));
    }
  }
  const pendingReqs = chatFriendReqs.get(wsDeviceId);
  if (pendingReqs?.size) {
    for (const fromId of pendingReqs)
      ws.send(JSON.stringify({ type: 'chat:friend-req', fromId, fromName: chatGetName(fromId), avatarUrl: chatGetAvatarUrl(fromId) }));
  }
}

// ─── WS: chat message handler ─────────────────────────────────────────────────
function handleChatMessage(ws, msg, wsDeviceId) {
  if (msg.type === 'chat:ghost-join') {
    const exp = chatGhostTokens.get(msg.token);
    if (!exp || Date.now() > exp) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Invalid ghost token' })); return; }
    chatGhostTokens.delete(msg.token);
    if (wsDeviceId) chatGhostDevices.add(wsDeviceId);
    ws.send(JSON.stringify({
      type: 'chat:ghost-state',
      global: chatGlobal.messages.slice(-100),
      groups: [...chatGroups.values()].map(g => ({
        id: g.id, name: g.name, memberCount: g.members.size,
        messages: g.messages.slice(-100), members: [...g.members],
      })),
      dms: [...chatDMs.entries()].map(([k, v]) => ({ room: k, messages: v.messages.slice(-50) })),
    }));
    return;
  }

  if (msg.type === 'chat:set-name' && wsDeviceId) {
    const name = String(msg.name || '').trim().slice(0, 32);
    if (name) { chatNames.set(wsDeviceId, name); chatSave(); }
    ws.send(JSON.stringify({ type: 'chat:name-set', name: chatGetName(wsDeviceId) }));
    return;
  }

  if (msg.type === 'chat:set-avatar' && wsDeviceId) {
    const url = String(msg.url || '').trim().slice(0, 500);
    if (url) chatAvatars.set(wsDeviceId, url);
    else chatAvatars.delete(wsDeviceId);
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:avatar-set', avatarUrl: chatGetAvatarUrl(wsDeviceId), customUrl: chatAvatars.get(wsDeviceId) || null }));
    return;
  }

  if (msg.type === 'chat:join' && wsDeviceId) {
    const room = String(msg.room || '');
    if (!chatCanAccess(wsDeviceId, room) && room !== 'global') return;
    let msgs = chatRoomMessages(room);
    if (msgs === null) {
      if (room.startsWith('dm:')) { chatDMs.set(room, { messages: [] }); msgs = chatDMs.get(room).messages; }
      else return;
    }
    ws.send(JSON.stringify({ type: 'chat:history', room, messages: msgs.slice(-100) }));
    if (room.startsWith('group:')) {
      const g = chatGroups.get(room);
      if (g) ws.send(JSON.stringify({
        type: 'chat:members', room,
        members: [...g.members].filter(id => !chatGhostDevices.has(id)).map(id => ({
          id, name: chatGetName(id), online: !!(state.deviceClients.get(id)?.size),
        })),
      }));
    }
    const callPs = chatGetCallParticipants(room);
    if (callPs.length) ws.send(JSON.stringify({
      type: 'chat:call-participants', room,
      participants: callPs.map(id => ({ id, name: chatGetName(id) })),
    }));
    return;
  }

  if (msg.type === 'chat:msg' && wsDeviceId) {
    const room = String(msg.room || '');
    const text = String(msg.text || '').trim().slice(0, 2000);
    if (!text || !chatCanAccess(wsDeviceId, room)) return;
    let msgs = chatRoomMessages(room);
    if (msgs === null) {
      if (room.startsWith('dm:')) {
        if (!chatDMs.has(room)) chatDMs.set(room, { messages: [] });
        msgs = chatDMs.get(room).messages;
      } else return;
    }
    const m = {
      id: crypto.randomBytes(6).toString('hex'),
      from: wsDeviceId, fromName: chatGetName(wsDeviceId),
      avatarUrl: chatGetAvatarUrl(wsDeviceId), text, ts: Date.now(),
    };
    msgs.push(m);
    if (msgs.length > CHAT_MSG_LIMIT) msgs.splice(0, msgs.length - CHAT_MSG_LIMIT);
    chatBroadcastRoom(room, { type: 'chat:msg', room, ...m });
    chatSave();
    return;
  }

  if (msg.type === 'chat:friend-req' && wsDeviceId) {
    const targetId = String(msg.targetId || '');
    if (!targetId || targetId === wsDeviceId) return;
    if (!chatFriendReqs.has(targetId)) chatFriendReqs.set(targetId, new Set());
    chatFriendReqs.get(targetId).add(wsDeviceId);
    chatSave();
    broadcastToDevice(targetId, { type: 'chat:friend-req', fromId: wsDeviceId, fromName: chatGetName(wsDeviceId), avatarUrl: chatGetAvatarUrl(wsDeviceId) });
    return;
  }

  if (msg.type === 'chat:friend-accept' && wsDeviceId) {
    const fromId = String(msg.fromId || '');
    if (!chatFriendReqs.get(wsDeviceId)?.has(fromId)) return;
    chatFriendReqs.get(wsDeviceId).delete(fromId);
    if (!chatFriends.has(wsDeviceId)) chatFriends.set(wsDeviceId, new Set());
    if (!chatFriends.has(fromId)) chatFriends.set(fromId, new Set());
    chatFriends.get(wsDeviceId).add(fromId);
    chatFriends.get(fromId).add(wsDeviceId);
    chatSave();
    broadcastToDevice(fromId, { type: 'chat:friend-accepted', byId: wsDeviceId, byName: chatGetName(wsDeviceId), byAvatarUrl: chatGetAvatarUrl(wsDeviceId) });
    ws.send(JSON.stringify({ type: 'chat:friend-accepted', byId: fromId, byName: chatGetName(fromId), byAvatarUrl: chatGetAvatarUrl(fromId) }));
    return;
  }

  if (msg.type === 'chat:friend-reject' && wsDeviceId) {
    chatFriendReqs.get(wsDeviceId)?.delete(String(msg.fromId || ''));
    chatSave();
    return;
  }

  if (msg.type === 'chat:group-create' && wsDeviceId) {
    const name = String(msg.name || '').trim().slice(0, 50);
    const pass = String(msg.password || '').trim();
    if (!name || !pass) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Name and password required' })); return; }
    const id = 'group:' + crypto.randomBytes(8).toString('hex');
    chatGroups.set(id, { id, name, passwordHash: crypto.createHash('sha256').update(pass).digest('hex'), messages: [], members: new Set([wsDeviceId]), created: Date.now() });
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:group-created', group: { id, name } }));
    ws.send(JSON.stringify({ type: 'chat:history', room: id, messages: [] }));
    return;
  }

  if (msg.type === 'chat:group-join' && wsDeviceId) {
    const { groupId, password } = msg;
    const group = chatGroups.get(String(groupId || ''));
    if (!group) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Group not found' })); return; }
    const hashBuf = Buffer.from(crypto.createHash('sha256').update(String(password || '')).digest('hex'));
    const expBuf  = Buffer.from(group.passwordHash);
    if (hashBuf.length !== expBuf.length || !crypto.timingSafeEqual(hashBuf, expBuf)) {
      ws.send(JSON.stringify({ type: 'chat:error', error: 'Wrong password' })); return;
    }
    group.members.add(wsDeviceId);
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:history', room: groupId, messages: group.messages.slice(-100) }));
    ws.send(JSON.stringify({
      type: 'chat:members', room: groupId,
      members: [...group.members].filter(id => !chatGhostDevices.has(id)).map(id => ({
        id, name: chatGetName(id), online: !!(state.deviceClients.get(id)?.size),
      })),
    }));
    chatBroadcastRoom(groupId, { type: 'chat:member-join', room: groupId, member: { id: wsDeviceId, name: chatGetName(wsDeviceId) } }, wsDeviceId);
    return;
  }

  if (msg.type === 'chat:group-leave' && wsDeviceId) {
    const group = chatGroups.get(String(msg.groupId || ''));
    if (group) {
      group.members.delete(wsDeviceId);
      chatSave();
      chatBroadcastRoom(msg.groupId, { type: 'chat:member-leave', room: msg.groupId, memberId: wsDeviceId }, wsDeviceId);
    }
    return;
  }

  if (msg.type === 'chat:call-join' && wsDeviceId) {
    const room = String(msg.room || '');
    if (!chatCanAccess(wsDeviceId, room)) return;
    if (!chatCalls.has(room)) chatCalls.set(room, new Set());
    const call = chatCalls.get(room);
    for (const existId of chatGetCallParticipants(room, true)) {
      if (existId === wsDeviceId) continue;
      broadcastToDevice(existId, { type: 'chat:call-new-peer', room, peerId: wsDeviceId });
    }
    call.add(wsDeviceId);
    const visiblePeers = chatGhostDevices.has(wsDeviceId)
      ? chatGetCallParticipants(room, true)
      : chatGetCallParticipants(room, false);
    ws.send(JSON.stringify({
      type: 'chat:call-participants', room,
      participants: visiblePeers.filter(id => id !== wsDeviceId).map(id => ({ id, name: chatGetName(id) })),
    }));
    if (!chatGhostDevices.has(wsDeviceId))
      chatBroadcastRoom(room, { type: 'chat:call-joined', room, participant: { id: wsDeviceId, name: chatGetName(wsDeviceId) } }, wsDeviceId);
    return;
  }

  if (msg.type === 'chat:call-leave' && wsDeviceId) {
    const room = String(msg.room || '');
    chatCalls.get(room)?.delete(wsDeviceId);
    if (!chatCalls.get(room)?.size) chatCalls.delete(room);
    if (!chatGhostDevices.has(wsDeviceId))
      chatBroadcastRoom(room, { type: 'chat:call-left', room, participantId: wsDeviceId });
    return;
  }

  if (msg.type === 'chat:signal' && wsDeviceId) {
    const to = String(msg.to || '');
    if (to) broadcastToDevice(to, { type: 'chat:signal', from: wsDeviceId, room: msg.room, signal: msg.signal });
    return;
  }
}

// ─── WS: disconnect cleanup ───────────────────────────────────────────────────
function handleDisconnect(wsDeviceId) {
  const wasGhost = chatGhostDevices.has(wsDeviceId);
  if (!state.deviceClients.get(wsDeviceId)?.size) chatGhostDevices.delete(wsDeviceId);
  for (const [room, participants] of chatCalls) {
    if (!participants.has(wsDeviceId)) continue;
    participants.delete(wsDeviceId);
    if (!wasGhost) chatBroadcastRoom(room, { type: 'chat:call-left', room, participantId: wsDeviceId });
    if (!participants.size) chatCalls.delete(room);
  }
}

// ─── REST routes ──────────────────────────────────────────────────────────────
function setupChatRoutes(app, resolveDevice, BASE_PATH = '') {
  app.get('/api/chat/me', (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).json({ error: 'device required' });
    const spotify = state.spotifyUserCache.get(deviceId);
    res.json({
      name: chatGetName(deviceId),
      avatarUrl: chatGetAvatarUrl(deviceId),
      customAvatarUrl: chatAvatars.get(deviceId) || null,
      provider: spotify?.displayName ? 'spotify' : null,
      authenticated: !!(spotify?.displayName),
      deviceId,
    });
  });

  app.get('/api/admin/ghost-token', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    res.json({ token: chatGenerateGhostToken() });
  });

  app.get('/api/admin/chat-accounts', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    res.json({
      accounts: [...chatAccounts.entries()].map(([key, a]) => ({ key, name: a.name, avatarUrl: a.avatarUrl || null })),
      groups: [...chatGroups.values()].map(g => ({ id: g.id, name: g.name, memberCount: g.members.size })),
    });
  });

  app.patch('/api/admin/chat-account', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const { key, name, avatarUrl } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const acc = chatAccounts.get(key);
    if (!acc) return res.status(404).json({ error: 'account not found' });
    if (name !== undefined) acc.name = String(name).trim().slice(0, 32) || acc.name;
    if (avatarUrl !== undefined) acc.avatarUrl = avatarUrl || null;
    for (const [deviceId, profile] of chatProfiles) {
      if (profile.providerId !== key) continue;
      profile.name = acc.name;
      profile.avatarUrl = acc.avatarUrl;
      chatNames.set(deviceId, acc.name);
      broadcastToDevice(deviceId, { type: 'chat:profile', name: acc.name, avatarUrl: acc.avatarUrl, customAvatarUrl: chatAvatars.get(deviceId) || null, provider: profile.provider });
    }
    chatSave();
    res.json({ ok: true, name: acc.name, avatarUrl: acc.avatarUrl });
  });

  app.post('/api/chat/upload-avatar', (req, res) => {
    const deviceId = req.query.device;
    if (!deviceId) return res.status(400).json({ error: 'Missing device' });
    const { dataUrl } = req.body || {};
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(jpeg|png|gif|webp));base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image data' });
    const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
    const buf = Buffer.from(match[3], 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 2MB)' });
    const avatarDir = path.join(__dirname, '..', 'public', 'avatars');
    if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
    const filename = deviceId.replace(/[^a-z0-9]/gi, '').slice(0, 64) + '.' + ext;
    fs.writeFile(path.join(avatarDir, filename), buf, err => {
      if (err) return res.status(500).json({ error: 'Save failed' });
      res.json({ url: BASE_PATH + '/avatars/' + filename });
    });
  });

  app.get('/api/chat/groups', (req, res) => {
    res.json({
      groups: [...chatGroups.values()].map(g => ({
        id: g.id, name: g.name, memberCount: g.members.size, created: g.created,
        hasCall: chatCalls.has(g.id),
      })),
    });
  });

  app.delete('/api/admin/chat-group/:id', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const { id } = req.params;
    if (!chatGroups.has(id)) return res.status(404).json({ error: 'group not found' });
    chatGroups.delete(id);
    chatSave();
    chatBroadcastAll({ type: 'chat:group-deleted', groupId: id });
    res.json({ ok: true });
  });

  app.post('/api/admin/test-msg', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const room = String(req.body?.room || '').trim();
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!room || !text) return res.status(400).json({ error: 'room and text required' });
    let roomMsgs;
    if (room === 'global') {
      roomMsgs = chatGlobal.messages;
    } else if (room.startsWith('group:') && chatGroups.has(room)) {
      roomMsgs = chatGroups.get(room).messages;
    } else if (room.startsWith('dm:')) {
      if (!chatDMs.has(room)) chatDMs.set(room, { messages: [] });
      roomMsgs = chatDMs.get(room).messages;
    } else {
      return res.status(404).json({ error: 'room not found' });
    }
    const m = { id: crypto.randomBytes(6).toString('hex'), from: TEST_USER_ID, fromName: 'Test User', avatarUrl: null, text, ts: Date.now() };
    roomMsgs.push(m);
    if (roomMsgs.length > CHAT_MSG_LIMIT) roomMsgs.splice(0, roomMsgs.length - CHAT_MSG_LIMIT);
    chatBroadcastRoom(room, { type: 'chat:msg', room, ...m });
    chatSave();
    res.json({ ok: true });
  });

  app.get('/api/admin/test-friend-reqs', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const pending = chatFriendReqs.get(TEST_USER_ID) || new Set();
    res.json({ reqs: [...pending].map(id => ({ id, name: chatGetName(id), avatarUrl: chatGetAvatarUrl(id) })) });
  });

  app.post('/api/admin/test-accept-req', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const fromId = String(req.body?.fromId || '').trim();
    if (!fromId) return res.status(400).json({ error: 'fromId required' });
    if (!chatFriendReqs.get(TEST_USER_ID)?.has(fromId)) return res.status(404).json({ error: 'no pending request' });
    chatFriendReqs.get(TEST_USER_ID).delete(fromId);
    if (!chatFriends.has(TEST_USER_ID)) chatFriends.set(TEST_USER_ID, new Set());
    if (!chatFriends.has(fromId)) chatFriends.set(fromId, new Set());
    chatFriends.get(TEST_USER_ID).add(fromId);
    chatFriends.get(fromId).add(TEST_USER_ID);
    chatSave();
    broadcastToDevice(fromId, { type: 'chat:friend-accepted', byId: TEST_USER_ID, byName: 'Test User', byAvatarUrl: null });
    res.json({ ok: true });
  });

  app.post('/api/admin/test-friend-all', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    let count = 0;
    const candidates = new Set([...devices.keys(), ...chatNames.keys()]);
    for (const devId of candidates) {
      if (devId === TEST_USER_ID || devId === PANEL_BOT_ID) continue;
      if (!chatFriends.has(TEST_USER_ID)) chatFriends.set(TEST_USER_ID, new Set());
      if (!chatFriends.has(devId)) chatFriends.set(devId, new Set());
      if (!chatFriends.get(devId).has(TEST_USER_ID)) {
        chatFriends.get(TEST_USER_ID).add(devId);
        chatFriends.get(devId).add(TEST_USER_ID);
        broadcastToDevice(devId, { type: 'chat:friend-accepted', byId: TEST_USER_ID, byName: 'Test User', byAvatarUrl: null });
        count++;
      }
    }
    chatSave();
    res.json({ ok: true, count });
  });

  app.post('/api/admin/panel-broadcast', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const room = String(req.body?.room || '').trim();
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!room || !text) return res.status(400).json({ error: 'room and text required' });
    let roomMsgs;
    if (room === 'global') {
      roomMsgs = chatGlobal.messages;
    } else if (room.startsWith('group:') && chatGroups.has(room)) {
      roomMsgs = chatGroups.get(room).messages;
    } else {
      return res.status(404).json({ error: 'room not found' });
    }
    const m = { id: crypto.randomBytes(6).toString('hex'), from: PANEL_BOT_ID, fromName: 'Server', avatarUrl: null, text, ts: Date.now(), isPanelMsg: true };
    roomMsgs.push(m);
    if (roomMsgs.length > CHAT_MSG_LIMIT) roomMsgs.splice(0, roomMsgs.length - CHAT_MSG_LIMIT);
    chatBroadcastRoom(room, { type: 'chat:msg', room, ...m });
    chatSave();
    res.json({ ok: true });
  });

  app.post('/api/admin/clear-room', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const room = String(req.body?.room || '').trim();
    let container;
    if (room === 'global')             container = chatGlobal;
    else if (room.startsWith('group:')) container = chatGroups.get(room);
    else if (room.startsWith('dm:'))    container = chatDMs.get(room);
    if (!container) return res.status(404).json({ error: 'room not found' });
    container.messages.length = 0;
    if (room === 'global') chatBroadcastAll({ type: 'chat:clear', room });
    else chatBroadcastRoom(room, { type: 'chat:clear', room });
    chatSave();
    res.json({ ok: true });
  });
}

module.exports = {
  chatGetName, chatGetAvatarUrl, chatSaveSync,
  chatCalls, chatGhostDevices,
  handleChatMessage, handleDisconnect, sendFriendData,
  setupChatRoutes,
};
