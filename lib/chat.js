// All chat: state, persistence, helpers, WS message handlers, REST routes.

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');
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
const chatProfiles     = new Map(); // deviceId -> { name, avatarUrl, provider, providerId }
const chatGlobal       = { messages: [] };
// A "server" is Discord's structure: channels, cosmetic roles, an owner, and
// account-keyed membership (persists across devices — see accountDevices
// below). Not to be confused with lib/state.js's unrelated `liveChannels`
// (an audio-broadcast "channel" keyed by broadcaster deviceId) — separate
// Map, separate chat:/live: WS namespaces, just the same English word.
const chatServers      = new Map(); // serverId -> ServerObject (see chatServerSummary)
const chatInviteCodes  = new Map(); // inviteCode -> serverId
const chatDMs          = new Map();
const chatFriends      = new Map();
const chatFriendReqs   = new Map();
const chatCalls        = new Map();
const chatAccounts     = new Map(); // providerId (e.g. 'discord:123') -> { name, avatarUrl }
const chatOAuthState   = new Map(); // state -> { deviceId, exp }
// Reverse index for chatProfiles' deviceId->providerId link, maintained at
// every site that mutates chatProfiles (OAuth callback, logout,
// delete-account, load). Server membership is accountKey-keyed but WS
// delivery is deviceId-keyed; this makes that translation O(1) instead of a
// per-broadcast scan over every known device.
const accountDevices   = new Map(); // providerId -> Set<deviceId>
let   chatSaveTimer    = null;

function chatLinkAccountDevice(accountKey, deviceId) {
  if (!accountKey) return;
  if (!accountDevices.has(accountKey)) accountDevices.set(accountKey, new Set());
  accountDevices.get(accountKey).add(deviceId);
}
function chatUnlinkAccountDevice(accountKey, deviceId) {
  const set = accountDevices.get(accountKey);
  if (!set) return;
  set.delete(deviceId);
  if (!set.size) accountDevices.delete(accountKey);
}

// One-time upgrade for DM rooms saved before the account-linking migration
// existed: back then both parties in a dm: room were always raw deviceIds
// (no accountKey party could exist yet), so the old 'dm:<a>:<b>' single-
// colon format was never ambiguous. It became ambiguous the moment an
// accountKey party (its own internal colon, e.g. 'discord:999') became
// possible -- chatCanAccess/chatGetRoomTargets/chatMigrateDeviceToAccount
// all now split on '::' to stay unambiguous, so any surviving single-colon
// room from before this change would otherwise become permanently
// unreachable (chatCanAccess would never match either party again). Must
// run before chatMigrateDeviceToAccount below, which itself expects every
// existing dm: room to already be in '::' form.
function chatUpgradeDmRoomSeparators() {
  for (const [room, data] of [...chatDMs.entries()]) {
    if (!room.startsWith('dm:') || room.includes('::')) continue;
    const parts = room.slice(3).split(':');
    if (parts.length !== 2) continue; // unexpected shape -- leave it rather than guess
    const newRoom = 'dm:' + parts.sort().join('::');
    if (chatDMs.has(newRoom)) {
      chatDMs.get(newRoom).messages = [...chatDMs.get(newRoom).messages, ...data.messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    } else {
      chatDMs.set(newRoom, data);
    }
    chatDMs.delete(room);
  }
}

// When a device links to a Discord account, any friends/pending requests/DM
// history it accumulated under its own raw deviceId (before linking, or
// from a previous session before this migration existed) move onto the
// account -- otherwise that data would silently become unreachable the
// moment friends/DMs start being looked up by accountKey (chatIdentityKey)
// instead of raw deviceId. Idempotent: safe to call repeatedly (e.g. once
// per already-linked profile at boot, as a defensive backfill for state
// saved before this function existed) since it's a no-op once nothing is
// left keyed under the raw deviceId.
function chatMigrateDeviceToAccount(deviceId, accountKey) {
  if (!accountKey || deviceId === accountKey) return;

  // Friends: merge the device's friend set into the account's, and fix up
  // the OTHER side of each friendship to point at the new key too.
  const oldFriends = chatFriends.get(deviceId);
  if (oldFriends?.size) {
    if (!chatFriends.has(accountKey)) chatFriends.set(accountKey, new Set());
    const mine = chatFriends.get(accountKey);
    for (const otherKey of oldFriends) {
      mine.add(otherKey);
      chatFriends.get(otherKey)?.delete(deviceId);
      chatFriends.get(otherKey)?.add(accountKey);
    }
    chatFriends.delete(deviceId);
  }

  // Friend requests: this device's own pending incoming requests...
  const oldIncoming = chatFriendReqs.get(deviceId);
  if (oldIncoming?.size) {
    if (!chatFriendReqs.has(accountKey)) chatFriendReqs.set(accountKey, new Set());
    for (const reqKey of oldIncoming) chatFriendReqs.get(accountKey).add(reqKey);
    chatFriendReqs.delete(deviceId);
  }
  // ...and requests this device sent to others, stored keyed by the
  // recipient with this device's raw id inside their own Set.
  for (const reqSet of chatFriendReqs.values()) {
    if (reqSet.delete(deviceId)) reqSet.add(accountKey);
  }

  // DMs: re-key every dm: room this device was a party to. If the account
  // already has a DM room with the same other party (e.g. a second device
  // of this account already talked to them before this device linked),
  // merge message history instead of clobbering it, sorted back into
  // chronological order.
  for (const [room, data] of [...chatDMs.entries()]) {
    if (!room.startsWith('dm:') || !room.slice(3).split('::').includes(deviceId)) continue;
    const newRoom = 'dm:' + room.slice(3).split('::').map(p => p === deviceId ? accountKey : p).sort().join('::');
    if (newRoom === room) continue;
    if (chatDMs.has(newRoom)) {
      chatDMs.get(newRoom).messages = [...chatDMs.get(newRoom).messages, ...data.messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    } else {
      chatDMs.set(newRoom, data);
    }
    chatDMs.delete(room);
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function buildSaveData() {
  return {
    accounts: Object.fromEntries(chatAccounts),
    profiles: Object.fromEntries(chatProfiles),
    names:    Object.fromEntries(chatNames),
    avatars:  Object.fromEntries(chatAvatars),
    servers:  [...chatServers.values()].map(s => ({
      id: s.id, name: s.name, icon: s.icon, description: s.description,
      ownerId: s.ownerId, inviteCode: s.inviteCode,
      channels: s.channels, defaultChannelId: s.defaultChannelId, roles: s.roles,
      members: [...s.members.entries()],
      channelMessages: [...s.channelMessages.entries()].map(([cid, msgs]) => [cid, msgs.slice(-CHAT_MSG_LIMIT)]),
      created: s.created,
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
    for (const s of (data.servers || [])) {
      chatServers.set(s.id, {
        ...s,
        members: new Map(s.members || []),
        channelMessages: new Map((s.channelMessages || []).map(([cid, msgs]) => [cid, msgs || []])),
      });
      if (s.inviteCode) chatInviteCodes.set(s.inviteCode, s.id);
    }
    for (const { key, messages } of (data.dms || [])) chatDMs.set(key, { messages: messages || [] });
    for (const [k, v] of (data.friends    || [])) chatFriends.set(k, new Set(v));
    for (const [k, v] of (data.friendReqs || [])) chatFriendReqs.set(k, new Set(v));
    if (data.global) chatGlobal.messages = data.global;
    for (const [deviceId, profile] of chatProfiles) chatLinkAccountDevice(profile.providerId, deviceId);
    chatUpgradeDmRoomSeparators();
    // Defensive backfill for state saved before chatMigrateDeviceToAccount
    // existed -- a no-op for state that's already migrated (or never had
    // any deviceId-keyed friends/DMs to begin with).
    for (const [deviceId, profile] of chatProfiles) chatMigrateDeviceToAccount(deviceId, profile.providerId);
    console.log('[chat] state loaded');
  } catch (e) { if (e.code !== 'ENOENT') console.error('[chat] load error:', e.message); }
})();

process.on('exit',    chatSaveSync);
process.on('SIGINT',  () => { chatSaveSync(); process.exit(0); });
process.on('SIGTERM', () => { chatSaveSync(); process.exit(0); });

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Discord is chat's only identity source now — Spotify is a separate,
// unrelated integration (music playback) and no longer feeds chat name/avatar.
// chatAccounts is checked first in both getters below because `id` here can
// now be EITHER a deviceId or an accountKey (e.g. 'discord:123') — friends/
// DMs/message `from` fields are keyed by whichever chatIdentityKey() resolved
// to at the time, see below. Falling straight to the deviceId-keyed maps
// first would render an accountKey as a garbled "User-discor" fallback.
function chatGetName(id) {
  if (id === PANEL_BOT_ID) return 'Server';
  if (id === TEST_USER_ID) return 'Test User';
  if (chatAccounts.has(id)) return chatAccounts.get(id).name;
  if (chatProfiles.has(id)) return chatProfiles.get(id).name;
  if (chatNames.has(id))    return chatNames.get(id);
  return 'User-' + id.slice(0, 6);
}

function chatGetAvatarUrl(id) {
  if (id === PANEL_BOT_ID) return null;
  if (id === TEST_USER_ID) return null;
  if (chatAccounts.has(id)) return chatAccounts.get(id).avatarUrl || null;
  return chatAvatars.get(id) || chatProfiles.get(id)?.avatarUrl || null;
}

// The identity a device speaks chat as: its linked Discord account when it
// has one, otherwise the device itself. Friends/friend-requests/DM rooms are
// keyed by this (not raw deviceId) so they follow a signed-in account across
// every device that account is linked on, the same way server membership
// already does — an anonymous, never-linked device keeps today's behavior
// unchanged (its own deviceId as a stand-in identity).
function chatIdentityKey(deviceId) {
  return chatProfiles.get(deviceId)?.providerId || deviceId;
}

// Delivers to every device of an account (via accountDevices) when `key` is
// a linked accountKey, or to the single device directly when it's a raw
// deviceId (an anonymous target, or a fallback before accountDevices is
// populated) -- generalizes broadcastToDevice to accept either identity
// shape, mirroring chatGetRoomTargets' channel: branch (which already
// expands an accountKey to all its devices).
function chatNotifyIdentity(key, payload) {
  if (accountDevices.has(key)) {
    for (const devId of accountDevices.get(key)) broadcastToDevice(devId, payload);
  } else {
    broadcastToDevice(key, payload);
  }
}

// Room id 'channel:<serverId>:<channelId>' — serverId itself already
// contains a colon ('server:<hex16>'), so channelId is taken as the LAST
// segment and everything between is reassembled as the serverId. Channel
// ids are always plain hex/slugs (no colons), so this is unambiguous.
function chatParseChannelRoom(room) {
  if (!room.startsWith('channel:')) return null;
  const parts = room.split(':');
  if (parts.length < 4) return null;
  const channelId = parts[parts.length - 1];
  const serverId  = parts.slice(1, -1).join(':');
  return { serverId, channelId };
}

function chatServerSummary(server) {
  return {
    id: server.id, name: server.name, icon: server.icon, description: server.description,
    ownerId: server.ownerId, inviteCode: server.inviteCode,
    channels: server.channels, defaultChannelId: server.defaultChannelId,
    roles: server.roles, memberCount: server.members.size,
  };
}

function chatServerMembers(server) {
  return [...server.members.entries()].map(([accountKey, m]) => {
    const acc = chatAccounts.get(accountKey);
    const online = [...(accountDevices.get(accountKey) || [])].some(id => state.deviceClients.get(id)?.size);
    return {
      accountKey,
      name: acc?.name || 'Deleted User',
      avatarUrl: acc?.avatarUrl || null,
      roles: m.roles,
      online,
    };
  });
}

function chatRoomMessages(room) {
  if (room === 'global')      return chatGlobal.messages;
  if (room.startsWith('dm:')) return chatDMs.get(room)?.messages ?? null;
  const parsed = chatParseChannelRoom(room);
  if (parsed) return chatServers.get(parsed.serverId)?.channelMessages.get(parsed.channelId) ?? null;
  return null;
}

// 'dm:<partyA>::<partyB>' -- a DOUBLE colon between the two parties, not a
// single one, because a party can itself be an accountKey containing its
// own single colon ('discord:999'). A plain split(':') on 'dm:deviceB:
// discord:999' yields three pieces ('deviceB','discord','999') instead of
// the intended two and silently breaks every dm: room lookup for anyone
// signed in -- confirmed live while testing this migration, not a
// hypothetical.
function chatCanAccess(deviceId, room) {
  if (chatGhostDevices.has(deviceId)) return true;
  if (room === 'global') return true;
  if (room.startsWith('dm:')) return room.slice(3).split('::').includes(chatIdentityKey(deviceId));
  const parsed = chatParseChannelRoom(room);
  if (parsed) {
    const accountKey = chatProfiles.get(deviceId)?.providerId;
    if (!accountKey) return false;
    return chatServers.get(parsed.serverId)?.members.has(accountKey) ?? false;
  }
  return false;
}

function chatGetRoomTargets(room) {
  const targets = new Set(chatGhostDevices);
  if (room === 'global') {
    for (const id of state.deviceClients.keys()) targets.add(id);
  } else if (room.startsWith('dm:')) {
    // Each embedded id is either an accountKey (expand to every linked
    // device, same pattern as the channel: branch below) or a raw deviceId
    // from an anonymous, never-linked party (used directly).
    for (const key of room.slice(3).split('::')) {
      if (accountDevices.has(key)) { for (const devId of accountDevices.get(key)) targets.add(devId); }
      else targets.add(key);
    }
  } else {
    const parsed = chatParseChannelRoom(room);
    const server = parsed && chatServers.get(parsed.serverId);
    if (server) {
      for (const accountKey of server.members.keys())
        for (const devId of (accountDevices.get(accountKey) || [])) targets.add(devId);
    }
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
  const myKey = chatIdentityKey(wsDeviceId);
  const myFriends = chatFriends.get(myKey);
  if (myFriends?.size) {
    ws.send(JSON.stringify({
      type: 'chat:friends-list',
      friends: [...myFriends].map(id => ({ id, name: chatGetName(id), avatarUrl: chatGetAvatarUrl(id) })),
    }));
    for (const friendId of myFriends) {
      const dmKey = 'dm:' + [myKey, friendId].sort().join('::');
      if (chatDMs.has(dmKey))
        ws.send(JSON.stringify({ type: 'chat:history', room: dmKey, messages: chatDMs.get(dmKey).messages.slice(-100) }));
    }
  }
  const pendingReqs = chatFriendReqs.get(myKey);
  if (pendingReqs?.size) {
    for (const fromId of pendingReqs)
      ws.send(JSON.stringify({ type: 'chat:friend-req', fromId, fromName: chatGetName(fromId), avatarUrl: chatGetAvatarUrl(fromId) }));
  }
}

// Server membership is account-keyed, not device-keyed, so (unlike rooms the
// client already knows about from its own actions) there's no way for a
// freshly-loaded/reconnected tab to know which servers it belongs to without
// this — the client-side server rail is otherwise permanently empty until
// the next create/join in that same session.
function sendMyServers(ws, wsDeviceId) {
  const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
  if (!accountKey) return;
  const mine = [...chatServers.values()].filter(s => s.members.has(accountKey)).map(chatServerSummary);
  if (mine.length) ws.send(JSON.stringify({ type: 'chat:my-servers', servers: mine }));
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
      servers: [...chatServers.values()].map(s => ({
        id: s.id, name: s.name, memberCount: s.members.size,
        channels: s.channels.map(c => ({
          id: c.id, name: c.name, type: c.type,
          messages: (s.channelMessages.get(c.id) || []).slice(-100),
        })),
        members: chatServerMembers(s),
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

  // Logout unlinks this device from its account. Name/avatar stay
  // deviceId-scoped (a device's custom name/avatar is independent of which
  // account happens to be linked on it right now) but friends/DMs, once
  // migrated onto the account by chatMigrateDeviceToAccount, stay there —
  // this device just stops resolving to that identity (chatIdentityKey
  // falls back to the raw deviceId again) until signing back in relinks it.
  // Signing back in with the same Discord user relinks the same account since
  // the OAuth callback always re-derives the account key from Discord's own
  // user id, and any friends/DMs accumulated anonymously on this device in
  // the meantime get folded in at that point too.
  if (msg.type === 'chat:logout' && wsDeviceId) {
    const oldKey = chatProfiles.get(wsDeviceId)?.providerId;
    if (oldKey) chatUnlinkAccountDevice(oldKey, wsDeviceId);
    chatProfiles.delete(wsDeviceId);
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:logged-out' }));
    return;
  }

  // Delete account additionally forgets the linked account's stored
  // name/avatar and any manually-set name/avatar on this device, and (since
  // this is the one place a Discord identity actually gets destroyed) cleans
  // up any server ownership/membership tied to that account: owned servers
  // transfer to their oldest remaining member, or get deleted if the account
  // was the sole member; membership elsewhere is simply removed.
  if (msg.type === 'chat:delete-account' && wsDeviceId) {
    const profile    = chatProfiles.get(wsDeviceId);
    const accountKey = profile?.providerId;
    if (accountKey) {
      chatAccounts.delete(accountKey);
      chatUnlinkAccountDevice(accountKey, wsDeviceId);
      for (const server of [...chatServers.values()]) {
        if (!server.members.has(accountKey)) continue;
        server.members.delete(accountKey);
        if (server.ownerId === accountKey) {
          const remaining = [...server.members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
          if (remaining.length) {
            server.ownerId = remaining[0][0];
          } else {
            chatServers.delete(server.id);
            chatInviteCodes.delete(server.inviteCode);
            chatBroadcastAll({ type: 'chat:server-deleted', serverId: server.id });
          }
        }
      }
    }
    chatProfiles.delete(wsDeviceId);
    chatNames.delete(wsDeviceId);
    chatAvatars.delete(wsDeviceId);
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:logged-out' }));
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
    const parsed = chatParseChannelRoom(room);
    const server = parsed && chatServers.get(parsed.serverId);
    if (server) ws.send(JSON.stringify({ type: 'chat:members', serverId: server.id, members: chatServerMembers(server) }));
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
    // `from` is the sender's identity key (accountKey when signed in, else
    // deviceId) so a message sent from one of an account's devices is
    // recognized as "own" when later viewed from any of that account's
    // other devices, not just the exact tab that sent it.
    const m = {
      id: crypto.randomBytes(6).toString('hex'),
      from: chatIdentityKey(wsDeviceId), fromName: chatGetName(wsDeviceId),
      avatarUrl: chatGetAvatarUrl(wsDeviceId), text, ts: Date.now(),
    };
    // Role colour is stamped server-side at send time (same precedent as
    // isPanelMsg below), not re-derived client-side on every render.
    const parsed = chatParseChannelRoom(room);
    const server = parsed && chatServers.get(parsed.serverId);
    if (server) {
      const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
      const member = accountKey ? server.members.get(accountKey) : null;
      const role = member?.roles.length ? server.roles.find(r => r.id === member.roles[0]) : null;
      if (role) { m.roleName = role.name; m.roleColor = role.color; }
    }
    msgs.push(m);
    if (msgs.length > CHAT_MSG_LIMIT) msgs.splice(0, msgs.length - CHAT_MSG_LIMIT);
    chatBroadcastRoom(room, { type: 'chat:msg', room, ...m });
    chatSave();
    return;
  }

  // Friend requests/friendships/DMs are keyed by identity key (accountKey
  // when signed in, else deviceId — see chatIdentityKey) so they follow a
  // signed-in account across every device it's linked on. targetId/fromId
  // come from the client, which learns them from messages' `from` fields
  // and friend-list payloads — already identity keys, not raw deviceIds,
  // for anyone signed in, so no separate resolution is needed for them.
  if (msg.type === 'chat:friend-req' && wsDeviceId) {
    const myKey = chatIdentityKey(wsDeviceId);
    const targetId = String(msg.targetId || '');
    if (!targetId || targetId === myKey) return;
    if (!chatFriendReqs.has(targetId)) chatFriendReqs.set(targetId, new Set());
    chatFriendReqs.get(targetId).add(myKey);
    chatSave();
    chatNotifyIdentity(targetId, { type: 'chat:friend-req', fromId: myKey, fromName: chatGetName(myKey), avatarUrl: chatGetAvatarUrl(myKey) });
    return;
  }

  if (msg.type === 'chat:friend-accept' && wsDeviceId) {
    const myKey = chatIdentityKey(wsDeviceId);
    const fromId = String(msg.fromId || '');
    if (!chatFriendReqs.get(myKey)?.has(fromId)) return;
    chatFriendReqs.get(myKey).delete(fromId);
    if (!chatFriends.has(myKey)) chatFriends.set(myKey, new Set());
    if (!chatFriends.has(fromId)) chatFriends.set(fromId, new Set());
    chatFriends.get(myKey).add(fromId);
    chatFriends.get(fromId).add(myKey);
    chatSave();
    chatNotifyIdentity(fromId, { type: 'chat:friend-accepted', byId: myKey, byName: chatGetName(myKey), byAvatarUrl: chatGetAvatarUrl(myKey) });
    ws.send(JSON.stringify({ type: 'chat:friend-accepted', byId: fromId, byName: chatGetName(fromId), byAvatarUrl: chatGetAvatarUrl(fromId) }));
    return;
  }

  if (msg.type === 'chat:friend-reject' && wsDeviceId) {
    chatFriendReqs.get(chatIdentityKey(wsDeviceId))?.delete(String(msg.fromId || ''));
    chatSave();
    return;
  }

  if (msg.type === 'chat:server-create' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    if (!accountKey) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Sign in with Discord first' })); return; }
    const name = String(msg.name || '').trim().slice(0, 50);
    if (!name) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Name required' })); return; }
    const icon        = msg.icon ? String(msg.icon).trim().slice(0, 500) : null;
    const description = msg.description ? String(msg.description).trim().slice(0, 300) : null;
    const serverId          = 'server:' + crypto.randomBytes(8).toString('hex');
    const inviteCode        = crypto.randomBytes(5).toString('hex');
    const defaultChannelId  = 'general';
    const ownerRoleId       = 'role:' + crypto.randomBytes(4).toString('hex');
    const server = {
      id: serverId, name, icon, description, ownerId: accountKey, inviteCode,
      channels: [{ id: defaultChannelId, name: 'general', type: 'text' }],
      defaultChannelId,
      roles: [{ id: ownerRoleId, name: 'Owner', color: '#f0b232' }],
      members: new Map([[accountKey, { roles: [ownerRoleId], joinedAt: Date.now() }]]),
      channelMessages: new Map([[defaultChannelId, []]]),
      created: Date.now(),
    };
    chatServers.set(serverId, server);
    chatInviteCodes.set(inviteCode, serverId);
    chatSave();
    ws.send(JSON.stringify({ type: 'chat:server-created', server: chatServerSummary(server) }));
    return;
  }

  if (msg.type === 'chat:server-join' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    if (!accountKey) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Sign in with Discord first' })); return; }
    const code = String(msg.inviteCode || '').trim();
    const serverId = chatInviteCodes.get(code);
    const server = serverId ? chatServers.get(serverId) : null;
    if (!server) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Invalid invite code' })); return; }
    const isNew = !server.members.has(accountKey);
    if (isNew) { server.members.set(accountKey, { roles: [], joinedAt: Date.now() }); chatSave(); }
    const defaultRoom = `channel:${server.id}:${server.defaultChannelId}`;
    ws.send(JSON.stringify({ type: 'chat:server-joined', server: chatServerSummary(server), isNew }));
    ws.send(JSON.stringify({ type: 'chat:history', room: defaultRoom, messages: (server.channelMessages.get(server.defaultChannelId) || []).slice(-100) }));
    ws.send(JSON.stringify({ type: 'chat:members', serverId: server.id, members: chatServerMembers(server) }));
    if (isNew) chatBroadcastRoom(defaultRoom, { type: 'chat:member-join', serverId: server.id, members: chatServerMembers(server) }, wsDeviceId);
    return;
  }

  if (msg.type === 'chat:server-leave' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    const server = chatServers.get(String(msg.serverId || ''));
    if (!server || !accountKey || !server.members.has(accountKey)) return;
    server.members.delete(accountKey);
    if (server.ownerId === accountKey) {
      const remaining = [...server.members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      if (remaining.length) {
        server.ownerId = remaining[0][0];
      } else {
        chatServers.delete(server.id);
        chatInviteCodes.delete(server.inviteCode);
        chatSave();
        chatBroadcastAll({ type: 'chat:server-deleted', serverId: server.id });
        return;
      }
    }
    chatSave();
    chatBroadcastRoom(`channel:${server.id}:${server.defaultChannelId}`, { type: 'chat:member-leave', serverId: server.id, accountKey }, wsDeviceId);
    return;
  }

  if (msg.type === 'chat:channel-create' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    const server = chatServers.get(String(msg.serverId || ''));
    if (!server || server.ownerId !== accountKey) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Not authorized' })); return; }
    const name = String(msg.name || '').trim().slice(0, 50);
    if (!name) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Name required' })); return; }
    const channelType = msg.channelType === 'voice' ? 'voice' : 'text';
    const channelId = crypto.randomBytes(4).toString('hex');
    server.channels.push({ id: channelId, name, type: channelType });
    server.channelMessages.set(channelId, []);
    chatSave();
    chatBroadcastRoom(`channel:${server.id}:${server.defaultChannelId}`, { type: 'chat:channel-created', serverId: server.id, channel: { id: channelId, name, type: channelType } });
    return;
  }

  if (msg.type === 'chat:role-create' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    const server = chatServers.get(String(msg.serverId || ''));
    if (!server || server.ownerId !== accountKey) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Not authorized' })); return; }
    const name = String(msg.name || '').trim().slice(0, 30);
    if (!name) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Name required' })); return; }
    const color = /^#[0-9a-f]{6}$/i.test(msg.color || '') ? msg.color : '#99aab5';
    const roleId = 'role:' + crypto.randomBytes(4).toString('hex');
    server.roles.push({ id: roleId, name, color });
    chatSave();
    chatBroadcastRoom(`channel:${server.id}:${server.defaultChannelId}`, { type: 'chat:role-created', serverId: server.id, role: { id: roleId, name, color } });
    return;
  }

  // Toggles the role on/off for the target member — one handler covers both
  // assign and unassign since v1 roles have no ordering/permission semantics
  // that would make that ambiguous.
  if (msg.type === 'chat:role-assign' && wsDeviceId) {
    const accountKey = chatProfiles.get(wsDeviceId)?.providerId;
    const server = chatServers.get(String(msg.serverId || ''));
    if (!server || server.ownerId !== accountKey) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Not authorized' })); return; }
    const targetAccountKey = String(msg.targetAccountKey || '');
    const roleId = String(msg.roleId || '');
    const member = server.members.get(targetAccountKey);
    if (!member || !server.roles.some(r => r.id === roleId)) { ws.send(JSON.stringify({ type: 'chat:error', error: 'Invalid member or role' })); return; }
    member.roles = member.roles.includes(roleId) ? member.roles.filter(r => r !== roleId) : [...member.roles, roleId];
    chatSave();
    chatBroadcastRoom(`channel:${server.id}:${server.defaultChannelId}`, { type: 'chat:members', serverId: server.id, members: chatServerMembers(server) });
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
function setupChatRoutes(app, resolveDevice, BASE_PATH = '', MAIN_BASE = '') {
  const DISCORD_REDIRECT = `${MAIN_BASE}${BASE_PATH}/callback/discord`;

  app.get('/api/chat/me', (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).json({ error: 'device required' });
    const profile = chatProfiles.get(deviceId);
    res.json({
      name: chatGetName(deviceId),
      avatarUrl: chatGetAvatarUrl(deviceId),
      customAvatarUrl: chatAvatars.get(deviceId) || null,
      provider: profile?.provider || null,
      providerId: profile?.providerId || null,
      authenticated: !!profile,
      deviceId,
    });
  });

  // ── Discord account login — an alternative to linking Spotify, for anyone
  // who just wants a persistent chat identity without connecting music.
  app.get('/auth/discord', (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).send('device id required');
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET)
      return res.redirect(`${BASE_PATH}/?error=discord_not_configured`);
    const st = crypto.randomBytes(16).toString('hex');
    chatOAuthState.set(st, { deviceId, exp: Date.now() + 5 * 60 * 1000 });
    setTimeout(() => chatOAuthState.delete(st), 5 * 60 * 1000);
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT,
      response_type: 'code',
      scope: 'identify',
      state: st,
    });
    res.redirect('https://discord.com/api/oauth2/authorize?' + params);
  });

  app.get('/callback/discord', async (req, res) => {
    const { code, state: st, error } = req.query;
    if (error) return res.redirect(`${BASE_PATH}/?error=discord_${error}`);
    const entry = chatOAuthState.get(st);
    chatOAuthState.delete(st);
    if (!entry || Date.now() > entry.exp) return res.redirect(`${BASE_PATH}/?error=discord_state_mismatch`);
    try {
      const tokenRes = await axios.post(
        'https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: DISCORD_REDIRECT,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const meRes = await axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      });
      const u = meRes.data;
      const key  = 'discord:' + u.id;
      const name = u.global_name || u.username;
      const avatarUrl = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null;

      const oldKey = chatProfiles.get(entry.deviceId)?.providerId;
      if (oldKey && oldKey !== key) chatUnlinkAccountDevice(oldKey, entry.deviceId);
      chatAccounts.set(key, { name, avatarUrl });
      chatProfiles.set(entry.deviceId, { name, avatarUrl, provider: 'discord', providerId: key });
      chatLinkAccountDevice(key, entry.deviceId);
      chatMigrateDeviceToAccount(entry.deviceId, key);
      chatNames.delete(entry.deviceId); // the linked account's name now takes precedence
      chatSave();

      broadcastToDevice(entry.deviceId, {
        type: 'chat:profile', name, avatarUrl,
        customAvatarUrl: chatAvatars.get(entry.deviceId) || null, provider: 'discord', providerId: key,
      });
      res.redirect(`${BASE_PATH}/`);
    } catch (e) {
      console.error('[chat] Discord OAuth error:', e.response?.data || e.message);
      res.redirect(`${BASE_PATH}/?error=discord_auth_failed`);
    }
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
      servers: [...chatServers.values()].map(s => ({ id: s.id, name: s.name, memberCount: s.members.size, ownerId: s.ownerId })),
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
      broadcastToDevice(deviceId, { type: 'chat:profile', name: acc.name, avatarUrl: acc.avatarUrl, customAvatarUrl: chatAvatars.get(deviceId) || null, provider: profile.provider, providerId: profile.providerId });
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

  app.delete('/api/admin/chat-server/:id', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const { id } = req.params;
    const server = chatServers.get(id);
    if (!server) return res.status(404).json({ error: 'server not found' });
    chatServers.delete(id);
    chatInviteCodes.delete(server.inviteCode);
    chatSave();
    chatBroadcastAll({ type: 'chat:server-deleted', serverId: id });
    res.json({ ok: true });
  });

  app.post('/api/admin/test-msg', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const room = String(req.body?.room || '').trim();
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!room || !text) return res.status(400).json({ error: 'room and text required' });
    if (room.startsWith('dm:') && !chatDMs.has(room)) chatDMs.set(room, { messages: [] });
    const roomMsgs = chatRoomMessages(room);
    if (!roomMsgs) return res.status(404).json({ error: 'room not found' });
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
    if (room !== 'global' && !room.startsWith('channel:')) return res.status(404).json({ error: 'room not found' });
    const roomMsgs = chatRoomMessages(room);
    if (!roomMsgs) return res.status(404).json({ error: 'room not found' });
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
    const msgs = chatRoomMessages(room);
    if (!msgs) return res.status(404).json({ error: 'room not found' });
    msgs.length = 0;
    if (room === 'global') chatBroadcastAll({ type: 'chat:clear', room });
    else chatBroadcastRoom(room, { type: 'chat:clear', room });
    chatSave();
    res.json({ ok: true });
  });
}

module.exports = {
  chatGetName, chatGetAvatarUrl, chatSaveSync,
  chatCalls, chatGhostDevices,
  handleChatMessage, handleDisconnect, sendFriendData, sendMyServers,
  setupChatRoutes,
};
