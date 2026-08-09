// Chat tab — executes once at page load; DOM ops deferred until chatInit()
(function () {
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _chatReady     = false;
let chatRoom       = 'global';
let chatMyName         = '';
let chatMyAvatar       = null;
let chatMyCustomAvatar = null;
let chatMyProvider     = null;
let chatMyAccountKey   = null; // chatAccounts key (e.g. 'discord:123') — used only to check server ownership
let _avUploading       = false;
const chatRoomUnread = {};   // room → count
const chatRoomMsgs   = {};   // room → [msg, ...]
const chatFriendMap  = {};   // uid → { id, name, avatarUrl }
const chatPendingIn  = {};   // uid → { id, name, avatarUrl }  (incoming requests)
const chatPendingOut = new Set(); // uids I've sent requests to
const chatDMInfo     = {};   // dmRoomId → { uid, name, avatarUrl }
const chatServerMap  = {};   // serverId → server summary (from chat:my-servers/server-created/server-joined)
let chatActiveServerId = null; // null = Home mode (Global/DMs); else viewing that server's channels
let chatMemberList = []; // roster of the currently-open channel's server (server mode only)

// Call state
let chatInCall      = false;
let chatCallRoom    = null;
const chatPeers     = {};   // peerId → { pc }
let chatLocalStream = null;
let chatMuted       = false;
const chatCallPeers = {};   // peerId → { id, name, avatarUrl }
const ICE_SERVERS   = [{ urls: 'stun:stun.l.google.com:19302' }];

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function chatEl(id) { return document.getElementById(id); }
function avatarHtml(name, url, size = 32, clickData = null) {
  const initials = esc((name || '?').slice(0, 2).toUpperCase());
  const cursor   = clickData ? 'cursor:pointer;' : '';
  const attrs    = clickData
    ? ` data-uid="${esc(clickData.uid)}" data-name="${esc(clickData.name)}" data-av="${esc(clickData.av||'')}" onclick="chatAvatarClick(event,this)"`
    : '';
  if (url) {
    return `<div class="chat-avatar"${attrs} style="${cursor}width:${size}px;height:${size}px"><img src="${esc(url)}" alt="${esc(name)}" onerror="this.parentElement.innerHTML='${initials}'"></div>`;
  }
  return `<div class="chat-avatar"${attrs} style="${cursor}width:${size}px;height:${size}px">${initials}</div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function chatInit() {
  if (_chatReady) {
    // Already set up (e.g. revisiting the tab after clicking through to Music
    // to link Spotify) -- recheck auth so the overlay correctly reappears if
    // they still haven't linked, instead of staying dismissed forever.
    chatCheckAuth();
    return;
  }
  _chatReady = true;

  // Move login overlay to body so parent stacking context doesn't clip it
  const _ov = chatEl('chat-login-overlay');
  if (_ov && _ov.parentElement !== document.body) document.body.appendChild(_ov);

  chatCheckAuth();
  chatRenderSidebar();
}
window.chatInit = chatInit;

// Check Spotify link; show overlay if not linked. Runs on first chat load and
// every time the chat tab is revisited (see chatInit above).
function chatCheckAuth() {
  fetch(BASE_PATH + '/api/chat/me?device=' + deviceId).then(r => r.json()).then(profile => {
    if (profile.authenticated) {
      chatMyName         = profile.name;
      chatMyAvatar       = profile.avatarUrl;
      chatMyCustomAvatar = profile.customAvatarUrl || null;
      chatMyProvider     = profile.provider;
      chatMyAccountKey   = profile.providerId || null;
      chatHideLogin();
      chatUpdateAccountRow();
      chatJoinRoom('global');
    } else {
      chatShowLogin();
    }
  }).catch(() => {
    // On network error, let them in with cached name if available
    if (chatMyName) {
      chatHideLogin();
      chatUpdateAccountRow();
      chatJoinRoom('global');
    } else {
      chatShowLogin();
    }
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────
function chatShowLogin() {
  const el = chatEl('chat-login-overlay');
  if (el) el.style.display = '';
}
function chatHideLogin() {
  const el = chatEl('chat-login-overlay');
  if (el) el.style.display = 'none';
}
window.chatHideLogin = chatHideLogin;

function chatLoginDiscord() {
  location.href = BASE_PATH + '/auth/discord?device=' + deviceId;
}
window.chatLoginDiscord = chatLoginDiscord;

function chatUpdateAccountRow() {
  const row = chatEl('chat-account-row');
  const nameEl = chatEl('chat-account-name');
  const avEl   = chatEl('chat-account-avatar');
  if (!row) return;
  if (chatMyName) {
    row.style.display = '';
    if (nameEl) nameEl.textContent = chatMyName;
    if (avEl) {
      avEl.innerHTML = chatMyAvatar
        ? `<img src="${esc(chatMyAvatar)}" alt="">`
        : `<div class="chat-avatar" style="width:20px;height:20px;font-size:9px">${esc(chatMyName.slice(0,2).toUpperCase())}</div>`;
    }
  } else {
    row.style.display = 'none';
  }
}


// ── Announcement bar ──────────────────────────────────────────────────────────
function chatUpdateAnnouncementBar() {
  const bar = chatEl('chat-ann-bar');
  if (!bar) return;
  // Find the most recent panel message in the CURRENT room only
  const msgs = chatRoomMsgs[chatRoom] || [];
  let latest = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.from === 'panel-bot' || m.isPanelMsg) { latest = m; break; }
  }
  if (!latest) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const text = chatEl('chat-ann-text');
  const time = chatEl('chat-ann-time');
  if (text) text.textContent = latest.text;
  if (time) time.textContent = new Date(latest.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Room ──────────────────────────────────────────────────────────────────────
// Mirrors lib/chat.js's chatParseChannelRoom: 'channel:<serverId>:<channelId>',
// where serverId itself already contains a colon ('server:<hex16>'), so the
// channelId is the LAST segment and everything between is the serverId.
function chatParseChannelRoom(room) {
  if (!room.startsWith('channel:')) return null;
  const parts = room.split(':');
  if (parts.length < 4) return null;
  const channelId = parts[parts.length - 1];
  const serverId  = parts.slice(1, -1).join(':');
  return { serverId, channelId };
}

function chatRoomLabel(room) {
  if (room === 'global') return 'Global';
  if (room.startsWith('dm:')) {
    if (chatDMInfo[room]) return chatDMInfo[room].name;
    const otherId = room.slice(3).split(':').find(id => id !== deviceId);
    return chatFriendMap[otherId]?.name || 'DM';
  }
  const parsed = chatParseChannelRoom(room);
  if (parsed) {
    const server  = chatServerMap[parsed.serverId];
    const channel = server?.channels.find(c => c.id === parsed.channelId);
    return server ? `${server.name} #${channel?.name || ''}` : 'Channel';
  }
  return room;
}

function chatJoinRoom(room) {
  chatRoom = room;
  chatRoomUnread[room] = 0;
  if (wsReady) ws.send(JSON.stringify({ type: 'chat:join', room }));
  const title = chatEl('chat-room-title');
  if (title) title.textContent = chatRoomLabel(room);
  chatRenderMessages();
  chatUpdateCallBar();
  chatUpdateAnnouncementBar();
}

function chatOpenRoom(room) {
  chatJoinRoom(room);
  document.querySelectorAll('.chat-room-item').forEach(el => {
    el.classList.toggle('active', el.dataset.room === room);
  });
}
window.chatOpenRoom = chatOpenRoom;

// ── Server rail / navigation ────────────────────────────────────────────────────
function chatRenderServerRail() {
  const el = chatEl('chat-rail-servers');
  if (!el) return;
  el.innerHTML = Object.values(chatServerMap).map(s => {
    const initials = esc((s.name || '?').slice(0, 2).toUpperCase());
    const inner = s.icon ? `<img src="${esc(s.icon)}" alt="${esc(s.name)}">` : initials;
    return `<div class="chat-rail-item${s.id === chatActiveServerId ? ' active' : ''}" data-server-id="${esc(s.id)}" title="${esc(s.name)}" onclick="chatSwitchToServer('${esc(s.id)}')">${inner}</div>`;
  }).join('');
  chatEl('chat-rail-home')?.classList.toggle('active', !chatActiveServerId);
}

function chatRenderChannelList() {
  const server = chatServerMap[chatActiveServerId];
  const textEl  = chatEl('chat-text-channels-list');
  const voiceEl = chatEl('chat-voice-channels-list');
  const voiceLbl = chatEl('chat-voice-channels-label');
  if (!server || !textEl || !voiceEl) return;
  const rowHtml = c => {
    const room = `channel:${server.id}:${c.id}`;
    const u = chatRoomUnread[room] || 0;
    return `<div class="chat-room-item${room === chatRoom ? ' active' : ''}" data-room="${room}" onclick="chatOpenRoom('${room}')">
      <div class="chat-room-icon" style="font-size:14px">${c.type === 'voice' ? '🔊' : '#'}</div>
      <div class="chat-room-name">${esc(c.name)}</div>
      ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
    </div>`;
  };
  const textChannels  = server.channels.filter(c => c.type !== 'voice');
  const voiceChannels = server.channels.filter(c => c.type === 'voice');
  textEl.innerHTML = textChannels.map(rowHtml).join('');
  voiceEl.innerHTML = voiceChannels.map(rowHtml).join('');
  if (voiceLbl) voiceLbl.style.display = voiceChannels.length ? '' : 'none';
}

function chatSwitchToServer(serverId) {
  const server = chatServerMap[serverId];
  if (!server) return;
  chatActiveServerId = serverId;
  const homeEl = chatEl('chat-home-content'), serverEl = chatEl('chat-server-content');
  if (homeEl) homeEl.style.display = 'none';
  if (serverEl) serverEl.style.display = '';
  const nameLbl = chatEl('chat-server-name-label');
  if (nameLbl) nameLbl.textContent = server.name;
  const settingsBtn = chatEl('chat-server-settings-btn');
  if (settingsBtn) settingsBtn.style.display = (server.ownerId === chatMyAccountKey) ? '' : 'none';
  chatRenderChannelList();
  chatRenderServerRail();
  chatMemberList = [];
  chatRenderMemberList();
  chatOpenRoom(`channel:${serverId}:${server.defaultChannelId}`);
}
window.chatSwitchToServer = chatSwitchToServer;

function chatGoHome() {
  chatActiveServerId = null;
  const homeEl = chatEl('chat-home-content'), serverEl = chatEl('chat-server-content');
  if (homeEl) homeEl.style.display = '';
  if (serverEl) serverEl.style.display = 'none';
  chatMemberList = [];
  chatRenderMemberList();
  chatRenderServerRail();
  chatOpenRoom('global');
}
window.chatGoHome = chatGoHome;

// Grouped by role (first-matching role only, since roles are cosmetic/unordered-priority
// in v1 — no permission hierarchy to sort by), unroled members in a plain "Members" bucket.
// Degrades to a single flat bucket when the server has no roles yet.
function chatRenderMemberList() {
  const panel = chatEl('chat-member-list');
  if (!panel) return;
  if (!chatActiveServerId || !chatMemberList.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const inner = chatEl('chat-member-list-inner');
  if (!inner) return;
  const server = chatServerMap[chatActiveServerId];
  const roles = server?.roles || [];
  const groups = roles.map(r => ({ role: r, members: [] }));
  const none = [];
  for (const m of chatMemberList) {
    const roleId = (m.roles || [])[0];
    const grp = roleId && groups.find(g => g.role.id === roleId);
    if (grp) grp.members.push(m); else none.push(m);
  }
  const sortMembers = arr => [...arr].sort((a, b) => (b.online - a.online) || (a.name || '').localeCompare(b.name || ''));
  const memberRow = (m, color) => `<div class="chat-member-item${m.online ? '' : ' offline'}">
    <div class="chat-member-avatar">
      ${m.avatarUrl ? `<img src="${esc(m.avatarUrl)}" alt="">` : esc((m.name || '?').slice(0, 2).toUpperCase())}
      <div class="chat-member-status-dot"></div>
    </div>
    <div class="chat-member-name"${color ? ` style="color:${esc(color)}"` : ''}>${esc(m.name)}</div>
  </div>`;
  let html = '';
  for (const g of groups) {
    if (!g.members.length) continue;
    html += `<div class="chat-member-group-label" style="color:${esc(g.role.color)}">${esc(g.role.name)} — ${g.members.length}</div>`;
    html += sortMembers(g.members).map(m => memberRow(m, g.role.color)).join('');
  }
  if (none.length) {
    html += `<div class="chat-member-group-label">Members — ${none.length}</div>`;
    html += sortMembers(none).map(m => memberRow(m, null)).join('');
  }
  inner.innerHTML = html;
}

// ── Server settings (owner-only: create roles/channels, assign roles) ────────
function chatOpenServerSettings() {
  const server = chatServerMap[chatActiveServerId];
  if (!server || server.ownerId !== chatMyAccountKey) return;
  document.getElementById('chat-server-settings-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'chat-settings-overlay';
  overlay.id = 'chat-server-settings-overlay';
  overlay.innerHTML = `
    <div class="chat-settings-backdrop" onclick="this.closest('.chat-settings-overlay').remove()"></div>
    <div class="chat-settings-box chat-server-settings-box">
      <div class="chat-settings-title">${esc(server.name)} — Server Settings</div>

      <label class="chat-settings-label">Roles</label>
      <div id="css-roles-list" class="chat-settings-list"></div>
      <div class="chat-settings-inline-form">
        <input class="chat-settings-input" id="css-role-name" maxlength="30" placeholder="New role name…" style="flex:1"
          onkeydown="if(event.key==='Enter')chatCreateRole()">
        <input type="color" id="css-role-color" value="#99aab5" class="chat-color-input" title="Role color">
        <button class="chat-card-btn chat-card-btn-primary" style="width:auto;font-size:.75rem;padding:8px 14px" onclick="chatCreateRole()">Add</button>
      </div>
      <div class="chat-modal-err" id="css-role-err"></div>

      <label class="chat-settings-label" style="margin-top:16px">Channels</label>
      <div id="css-channels-list" class="chat-settings-list"></div>
      <div class="chat-settings-inline-form">
        <input class="chat-settings-input" id="css-channel-name" maxlength="50" placeholder="New channel name…" style="flex:1"
          onkeydown="if(event.key==='Enter')chatCreateChannel()">
        <select id="css-channel-type" class="chat-settings-select">
          <option value="text"># Text</option>
          <option value="voice">🔊 Voice</option>
        </select>
        <button class="chat-card-btn chat-card-btn-primary" style="width:auto;font-size:.75rem;padding:8px 14px" onclick="chatCreateChannel()">Add</button>
      </div>
      <div class="chat-modal-err" id="css-channel-err"></div>

      <label class="chat-settings-label" style="margin-top:16px">Members</label>
      <div id="css-members-list" class="chat-settings-list"></div>

      <div class="chat-settings-actions">
        <button class="chat-card-btn" onclick="this.closest('.chat-settings-overlay').remove()">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  chatRenderServerSettingsPanels();
}
window.chatOpenServerSettings = chatOpenServerSettings;

// Called after creation/role-assign responses land, so an already-open panel
// reflects the change immediately instead of only on next open. No-ops
// harmlessly when the panel isn't open.
function chatRenderServerSettingsPanels() {
  const overlay = document.getElementById('chat-server-settings-overlay');
  const server = chatServerMap[chatActiveServerId];
  if (!overlay || !server) return;

  const rolesEl = overlay.querySelector('#css-roles-list');
  if (rolesEl) {
    rolesEl.innerHTML = server.roles.map(r =>
      `<div class="chat-settings-row"><span class="chat-role-pill" style="background:${esc(r.color)}22;color:${esc(r.color)};border:1px solid ${esc(r.color)}55">${esc(r.name)}</span></div>`
    ).join('') || '<div class="chat-settings-hint">No roles yet</div>';
  }

  const channelsEl = overlay.querySelector('#css-channels-list');
  if (channelsEl) {
    channelsEl.innerHTML = server.channels.map(c =>
      `<div class="chat-settings-row"><span>${c.type === 'voice' ? '🔊' : '#'} ${esc(c.name)}</span></div>`
    ).join('') || '<div class="chat-settings-hint">No channels yet</div>';
  }

  const membersEl = overlay.querySelector('#css-members-list');
  if (membersEl) {
    membersEl.innerHTML = chatMemberList.map(m => {
      const memberRoles = m.roles || [];
      const chips = server.roles.map(r => {
        const active = memberRoles.includes(r.id);
        const style = active ? `background:${esc(r.color)};color:#fff;border-color:${esc(r.color)}` : `color:${esc(r.color)};border-color:${esc(r.color)}55`;
        return `<span class="chat-role-chip" style="${style}" onclick="chatToggleMemberRole('${esc(m.accountKey)}','${esc(r.id)}')">${esc(r.name)}</span>`;
      }).join('');
      return `<div class="chat-settings-row chat-settings-member-row">
        <span class="chat-settings-member-name">${esc(m.name)}</span>
        <div class="chat-settings-role-chips">${chips || '<span class="chat-settings-hint">No roles created yet</span>'}</div>
      </div>`;
    }).join('') || '<div class="chat-settings-hint">No members</div>';
  }
}

function chatCreateRole() {
  const nameInp = document.getElementById('css-role-name');
  const colorInp = document.getElementById('css-role-color');
  const errEl = document.getElementById('css-role-err');
  const name = (nameInp?.value || '').trim();
  if (errEl) errEl.textContent = '';
  if (!name) { if (errEl) errEl.textContent = 'Name required'; return; }
  if (wsReady) ws.send(JSON.stringify({ type: 'chat:role-create', serverId: chatActiveServerId, name, color: colorInp?.value || '#99aab5' }));
  if (nameInp) nameInp.value = '';
}
window.chatCreateRole = chatCreateRole;

function chatCreateChannel() {
  const nameInp = document.getElementById('css-channel-name');
  const typeInp = document.getElementById('css-channel-type');
  const errEl = document.getElementById('css-channel-err');
  const name = (nameInp?.value || '').trim();
  if (errEl) errEl.textContent = '';
  if (!name) { if (errEl) errEl.textContent = 'Name required'; return; }
  if (wsReady) ws.send(JSON.stringify({ type: 'chat:channel-create', serverId: chatActiveServerId, name, channelType: typeInp?.value || 'text' }));
  if (nameInp) nameInp.value = '';
}
window.chatCreateChannel = chatCreateChannel;

function chatToggleMemberRole(accountKey, roleId) {
  if (wsReady) ws.send(JSON.stringify({ type: 'chat:role-assign', serverId: chatActiveServerId, targetAccountKey: accountKey, roleId }));
}
window.chatToggleMemberRole = chatToggleMemberRole;

function chatLeaveCurrentServer() {
  if (!chatActiveServerId) return;
  if (!confirm('Leave "' + (chatServerMap[chatActiveServerId]?.name || 'this server') + '"?')) return;
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:server-leave', serverId: chatActiveServerId })); } catch {}
  delete chatServerMap[chatActiveServerId];
  chatGoHome();
}
window.chatLeaveCurrentServer = chatLeaveCurrentServer;

// ── Create / Join server ─────────────────────────────────────────────────────
function chatShowServerMenu() {
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.id = 'chat-server-modal';
  m.innerHTML = `<div class="chat-modal">
    <h3>Add a Server</h3>
    <div style="display:flex;gap:8px">
      <button class="chat-modal-btn chat-modal-btn-primary" style="font-size:.78rem" onclick="chatShowCreateServer()">+ Create</button>
      <button class="chat-modal-btn chat-modal-btn-cancel" style="font-size:.78rem" onclick="chatShowJoinServer()">Join by Invite</button>
    </div>
    <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Close</button>
  </div>`;
  document.body.appendChild(m);
}
window.chatShowServerMenu = chatShowServerMenu;

function chatShowCreateServer() {
  document.getElementById('chat-server-modal')?.remove();
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Create Server</h3>
    <input class="chat-modal-inp" id="cs-name" placeholder="Server name…" maxlength="50"
      onkeydown="if(event.key==='Enter')document.getElementById('cs-desc').focus()">
    <input class="chat-modal-inp" id="cs-desc" placeholder="Description (optional)…" maxlength="300"
      onkeydown="if(event.key==='Enter')chatCreateServer()">
    <div class="chat-modal-err" id="cs-err"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatCreateServer()">Create</button>
    </div>
  </div>`;
  document.body.appendChild(m);
}
window.chatShowCreateServer = chatShowCreateServer;

function chatCreateServer() {
  const name = (document.getElementById('cs-name')?.value || '').trim();
  const description = (document.getElementById('cs-desc')?.value || '').trim();
  const errEl = document.getElementById('cs-err');
  if (!name) { if (errEl) errEl.textContent = 'Name required'; return; }
  ws.send(JSON.stringify({ type: 'chat:server-create', name, description }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatCreateServer = chatCreateServer;

function chatShowJoinServer() {
  document.getElementById('chat-server-modal')?.remove();
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Join a Server</h3>
    <input class="chat-modal-inp" id="js-code" placeholder="Invite code…"
      onkeydown="if(event.key==='Enter')chatJoinServer()">
    <div class="chat-modal-err" id="js-err"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatJoinServer()">Join</button>
    </div>
  </div>`;
  document.body.appendChild(m);
}
window.chatShowJoinServer = chatShowJoinServer;

function chatJoinServer() {
  const inviteCode = (document.getElementById('js-code')?.value || '').trim();
  const errEl = document.getElementById('js-err');
  if (!inviteCode) { if (errEl) errEl.textContent = 'Invite code required'; return; }
  ws.send(JSON.stringify({ type: 'chat:server-join', inviteCode }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatJoinServer = chatJoinServer;

// Any member can invite (not owner-gated) — chatServerSummary already sends
// inviteCode to every member via chat:my-servers/server-created/server-joined,
// so there's no extra round-trip needed here.
function chatShowInvite() {
  const server = chatServerMap[chatActiveServerId];
  if (!server) return;
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Invite to ${esc(server.name)}</h3>
    <div style="display:flex;gap:8px">
      <input class="chat-modal-inp" id="chat-invite-code-inp" readonly value="${esc(server.inviteCode)}" onclick="this.select()">
      <button class="chat-modal-btn chat-modal-btn-primary" id="chat-invite-copy-btn" style="flex:0 0 auto;width:auto;padding:9px 16px" onclick="chatCopyInviteCode()">Copy</button>
    </div>
    <div class="chat-settings-hint">Anyone with this code can join — share it with people you trust. Use "+" → Join by Invite to redeem it.</div>
    <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Close</button>
  </div>`;
  document.body.appendChild(m);
}
window.chatShowInvite = chatShowInvite;

function chatCopyInviteCode() {
  const inp = document.getElementById('chat-invite-code-inp');
  const btn = document.getElementById('chat-invite-copy-btn');
  if (!inp) return;
  const showCopied = () => { if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 1500); } };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(inp.value).then(showCopied).catch(() => { inp.select(); document.execCommand('copy'); showCopied(); });
  } else {
    inp.select();
    document.execCommand('copy');
    showCopied();
  }
}
window.chatCopyInviteCode = chatCopyInviteCode;

// ── Onboarding ────────────────────────────────────────────────────────────────
function chatShowServerOnboarding(server) {
  document.getElementById('chat-onboarding-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'chat-settings-overlay';
  overlay.id = 'chat-onboarding-overlay';
  const iconHtml = server.icon
    ? `<img src="${esc(server.icon)}" alt="" style="width:64px;height:64px;border-radius:16px;object-fit:cover">`
    : `<div style="font-size:40px">🎉</div>`;
  overlay.innerHTML = `
    <div class="chat-settings-backdrop" onclick="this.parentElement.remove()"></div>
    <div class="chat-settings-box" style="text-align:center;align-items:center;display:flex;flex-direction:column;gap:10px">
      ${iconHtml}
      <div class="chat-settings-title">Welcome to ${esc(server.name)}!</div>
      ${server.description ? `<div class="chat-settings-hint" style="text-align:center">${esc(server.description)}</div>` : ''}
      <button class="chat-card-btn chat-card-btn-primary" style="width:auto;padding:8px 24px;margin-top:8px" onclick="this.closest('.chat-settings-overlay').remove()">Got it →</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.style.display = 'flex';
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function chatRenderSidebar() {
  if (!_chatReady) return;

  // Global unread badge
  const gu = chatRoomUnread['global'] || 0;
  const gb = chatEl('chat-unread-global');
  if (gb) { gb.textContent = gu; gb.style.display = gu ? '' : 'none'; }

  // DMs section
  const pendingIn = Object.values(chatPendingIn);
  const friends   = Object.values(chatFriendMap);
  const openDMs   = Object.values(chatDMInfo).filter(d => !chatFriendMap[d.uid]);
  const dmsEl     = chatEl('chat-dms-list');
  if (dmsEl) {
    let html = '';
    // Incoming requests
    for (const p of pendingIn) {
      const avHtml = p.avatarUrl
        ? `<img src="${esc(p.avatarUrl)}" class="chat-dm-req-av" alt="">`
        : `<div class="chat-dm-req-av chat-dm-req-av-init">${esc((p.name||'?').slice(0,2).toUpperCase())}</div>`;
      html += `<div class="chat-dm-req-item">
        ${avHtml}
        <div class="chat-dm-req-name">${esc(p.name)}</div>
        <div class="chat-dm-req-btns">
          <button class="chat-dm-req-btn chat-dm-req-accept" title="Accept" onclick="chatAcceptFriendReq('${p.id}')">✓</button>
          <button class="chat-dm-req-btn chat-dm-req-reject" title="Decline" onclick="chatRejectFriendReq('${p.id}')">✕</button>
        </div>
      </div>`;
    }
    // Friends as DM items
    for (const f of friends) {
      const dmRoom = 'dm:' + [deviceId, f.id].sort().join(':');
      const u = chatRoomUnread[dmRoom] || 0;
      const avHtml = f.avatarUrl
        ? `<div class="chat-room-icon"><img src="${esc(f.avatarUrl)}" alt="${esc(f.name)}"></div>`
        : `<div class="chat-room-icon" style="font-size:11px">${esc((f.name||'?').slice(0,2).toUpperCase())}</div>`;
      html += `<div class="chat-room-item${dmRoom === chatRoom ? ' active' : ''}" data-room="${dmRoom}" data-uid="${esc(f.id)}" data-name="${esc(f.name)}" data-av="${esc(f.avatarUrl||'')}" onclick="chatDmItemClick(this)">
        ${avHtml}
        <div class="chat-room-name">${esc(f.name)}</div>
        ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
      </div>`;
    }
    // Open DMs with non-friends
    for (const d of openDMs) {
      const dmRoom = 'dm:' + [deviceId, d.uid].sort().join(':');
      const u = chatRoomUnread[dmRoom] || 0;
      const avHtml = d.avatarUrl
        ? `<div class="chat-room-icon"><img src="${esc(d.avatarUrl)}" alt="${esc(d.name)}"></div>`
        : `<div class="chat-room-icon" style="font-size:11px">${esc((d.name||'?').slice(0,2).toUpperCase())}</div>`;
      html += `<div class="chat-room-item${dmRoom === chatRoom ? ' active' : ''}" data-room="${dmRoom}" data-uid="${esc(d.uid)}" data-name="${esc(d.name)}" data-av="${esc(d.avatarUrl||'')}" onclick="chatDmItemClick(this)">
        ${avHtml}
        <div class="chat-room-name">${esc(d.name)}</div>
        ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
      </div>`;
    }
    dmsEl.innerHTML = html;
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────
function chatRenderMessages() {
  if (!_chatReady) return;
  const container = chatEl('chat-messages-inner');
  const emptyEl   = chatEl('chat-empty');
  if (!container) return;

  const msgs = chatRoomMsgs[chatRoom] || [];
  if (!msgs.length) {
    container.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  let html = '';
  let lastDate = '';
  let lastFrom = '';
  for (const m of msgs) {
    const d = new Date(m.ts);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (dateStr !== lastDate) {
      html += `<div class="chat-date-divider"><span>${esc(dateStr)}</span></div>`;
      lastDate = dateStr;
      lastFrom = '';
    }
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    // Panel bot messages render as full-width announcements
    if (m.from === 'panel-bot' || m.isPanelMsg) {
      html += `<div class="chat-panel-msg">
        <div class="chat-panel-icon">📢</div>
        <div class="chat-panel-body">
          <div class="chat-panel-name">Server <span class="chat-panel-badge">ADMIN</span></div>
          <div class="chat-panel-bubble">${esc(m.text)}</div>
          <div class="chat-panel-time">${esc(timeStr)}</div>
        </div>
      </div>`;
      lastFrom = m.from;
      continue;
    }

    const own = m.from === deviceId;
    const showName = m.from !== lastFrom;
    lastFrom = m.from;
    // Role colour is stamped server-side on channel messages (see lib/chat.js) —
    // resolved once at send time, not re-derived here from the live roster.
    const nameStyle = m.roleColor ? ` style="color:${esc(m.roleColor)}"` : '';

    if (own) {
      html += `<div class="chat-msg own">
        <div class="chat-msg-body">
          ${showName ? `<div class="chat-msg-name"${nameStyle}>${esc(m.fromName)}</div>` : ''}
          <div class="chat-msg-own-row">
            <div class="chat-msg-bubble">${esc(m.text)}</div>
            ${avatarHtml(m.fromName, m.avatarUrl, 32, null)}
          </div>
          <div class="chat-msg-time">${esc(timeStr)}</div>
        </div>
      </div>`;
    } else {
      const clickData = { uid: m.from, name: m.fromName, av: m.avatarUrl || '' };
      html += `<div class="chat-msg">
        <div class="chat-msg-body">
          ${showName ? `<div class="chat-msg-name clickable" data-uid="${esc(m.from)}" data-name="${esc(m.fromName)}" data-av="${esc(m.avatarUrl||'')}" onclick="chatAvatarClick(event,this)"${nameStyle}>${esc(m.fromName)}</div>` : ''}
          <div class="chat-msg-own-row">
            ${avatarHtml(m.fromName, m.avatarUrl, 32, clickData)}
            <div class="chat-msg-bubble">${esc(m.text)}</div>
          </div>
          <div class="chat-msg-time">${esc(timeStr)}</div>
        </div>
      </div>`;
    }
  }
  container.innerHTML = html;

  // Scroll to bottom
  const el = chatEl('chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function chatAppendMessage(room, m) {
  if (!chatRoomMsgs[room]) chatRoomMsgs[room] = [];
  chatRoomMsgs[room].push(m);
  if (room === chatRoom && _chatReady) {
    const el = chatEl('chat-messages');
    const atBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 100) : true;
    chatRenderMessages();
    if (atBottom && el) el.scrollTop = el.scrollHeight;
  } else {
    chatRoomUnread[room] = (chatRoomUnread[room] || 0) + 1;
    chatRenderSidebar();
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────
function chatSend() {
  const inp = chatEl('chat-input');
  const text = (inp?.value || '').trim();
  if (!text || !wsReady) return;
  ws.send(JSON.stringify({ type: 'chat:msg', room: chatRoom, text }));
  if (inp) { inp.value = ''; inp.style.height = 'auto'; inp.focus(); }
}
window.chatSend = chatSend;

// ── Avatar click / User card ──────────────────────────────────────────────────
function chatAvatarClick(e, el) {
  const uid  = el.dataset.uid;
  const name = el.dataset.name;
  const av   = el.dataset.av || '';
  if (!uid || uid === deviceId) return;
  e.stopPropagation();
  chatShowUserCard(e, uid, name, av);
}
window.chatAvatarClick = chatAvatarClick;

function chatShowUserCard(e, uid, name, av) {
  document.getElementById('chat-user-card')?.remove();

  const card = document.createElement('div');
  card.id = 'chat-user-card';
  card.className = 'chat-user-card';

  const avContent = av
    ? `<img src="${esc(av)}" alt="${esc(name)}">`
    : esc((name || '?').slice(0, 2).toUpperCase());

  card.innerHTML = `
    <div class="chat-card-avatar">${avContent}</div>
    <div class="chat-card-name">${esc(name)}</div>
    <div class="chat-card-actions">
      <button class="chat-card-btn chat-card-btn-msg" id="chat-card-msg-btn">Message</button>
      <button class="chat-card-btn" id="chat-card-friend-btn"></button>
    </div>`;

  document.body.appendChild(card);

  // Position near cursor
  const rect = card.getBoundingClientRect();
  let x = e.clientX + 12;
  let y = e.clientY - Math.round(rect.height / 2);
  if (x + rect.width  > window.innerWidth  - 10) x = e.clientX - rect.width - 12;
  if (y + rect.height > window.innerHeight - 10) y = window.innerHeight - rect.height - 10;
  if (y < 10) y = 10;
  card.style.left = x + 'px';
  card.style.top  = y + 'px';

  card.querySelector('#chat-card-msg-btn').onclick = () => {
    chatOpenDM(uid, name, av);
    card.remove();
  };

  const friendBtn = card.querySelector('#chat-card-friend-btn');
  function refreshFriendBtn() {
    const isFriend     = !!chatFriendMap[uid];
    const isPendingOut = chatPendingOut.has(uid);
    const isPendingIn  = !!chatPendingIn[uid];
    if (isFriend) {
      friendBtn.textContent = '✓ Friends';
      friendBtn.className   = 'chat-card-btn chat-card-btn-friends';
      friendBtn.disabled    = true;
      friendBtn.onclick     = null;
    } else if (isPendingIn) {
      friendBtn.textContent = 'Accept Request';
      friendBtn.className   = 'chat-card-btn chat-card-btn-primary';
      friendBtn.disabled    = false;
      friendBtn.onclick     = () => { chatAcceptFriendReq(uid); refreshFriendBtn(); };
    } else if (isPendingOut) {
      friendBtn.textContent = 'Request Sent';
      friendBtn.className   = 'chat-card-btn chat-card-btn-muted';
      friendBtn.disabled    = true;
      friendBtn.onclick     = null;
    } else {
      friendBtn.textContent = 'Add Friend';
      friendBtn.className   = 'chat-card-btn chat-card-btn-primary';
      friendBtn.disabled    = false;
      friendBtn.onclick     = () => { chatDoSendFriendReq(uid, name, av); refreshFriendBtn(); };
    }
  }
  refreshFriendBtn();

  setTimeout(() => {
    document.addEventListener('click', function closeFn(ev) {
      if (!card.contains(ev.target)) {
        card.remove();
        document.removeEventListener('click', closeFn);
      }
    });
  }, 0);
}
window.chatShowUserCard = chatShowUserCard;

// ── DM helpers ────────────────────────────────────────────────────────────────
function chatDmItemClick(el) {
  chatOpenDM(el.dataset.uid, el.dataset.name, el.dataset.av || '');
}
window.chatDmItemClick = chatDmItemClick;

function chatOpenDM(uid, name, av) {
  const dmRoom = 'dm:' + [deviceId, uid].sort().join(':');
  if (!chatDMInfo[dmRoom]) chatDMInfo[dmRoom] = { uid, name, avatarUrl: av };
  chatOpenRoom(dmRoom);
  chatRenderSidebar();
}
window.chatOpenDM = chatOpenDM;

// ── Friend requests ───────────────────────────────────────────────────────────
function chatDoSendFriendReq(uid) {
  chatPendingOut.add(uid);
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:friend-req', targetId: uid })); } catch {}
  chatRenderSidebar();
}
window.chatDoSendFriendReq = chatDoSendFriendReq;

function chatAcceptFriendReq(uid) {
  const info = chatPendingIn[uid];
  if (info) { chatFriendMap[uid] = info; delete chatPendingIn[uid]; }
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:friend-accept', fromId: uid })); } catch {}
  chatRenderSidebar();
}
window.chatAcceptFriendReq = chatAcceptFriendReq;

function chatRejectFriendReq(uid) {
  delete chatPendingIn[uid];
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:friend-reject', fromId: uid })); } catch {}
  chatRenderSidebar();
}
window.chatRejectFriendReq = chatRejectFriendReq;

// ── Account settings ──────────────────────────────────────────────────────────
function chatOpenSettings() {
  let overlay = chatEl('chat-settings-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'chat-settings-overlay';
    overlay.id = 'chat-settings-overlay';
    overlay.innerHTML = `
      <div class="chat-settings-backdrop" onclick="chatCloseSettings()"></div>
      <div class="chat-settings-box">
        <div class="chat-settings-title">Account Settings</div>
        <div class="chat-settings-av-row">
          <div class="chat-settings-av-preview" id="chat-settings-av-preview" onclick="document.getElementById('chat-settings-file').click()" title="Click to upload" style="cursor:pointer"></div>
          <div style="flex:1;min-width:0">
            <label class="chat-settings-label">Avatar</label>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button class="chat-card-btn chat-card-btn-primary" style="font-size:.75rem;padding:5px 10px" onclick="document.getElementById('chat-settings-file').click()">Upload from PC</button>
              <input type="file" id="chat-settings-file" accept="image/*" style="display:none" onchange="chatHandleAvatarFile(this)">
            </div>
            <input class="chat-settings-input" id="chat-settings-avatar" type="url" maxlength="500" placeholder="Or paste image URL…" oninput="chatPreviewAvatar()">
            <div class="chat-settings-hint">Leave blank to use your Discord photo</div>
          </div>
        </div>
        <label class="chat-settings-label" style="margin-top:14px">Display name</label>
        <input class="chat-settings-input" id="chat-settings-name" type="text" maxlength="32" placeholder="Your display name…">
        <div class="chat-settings-hint">Overrides your Discord name in chat</div>
        <div class="chat-settings-actions">
          <button class="chat-card-btn" onclick="chatCloseSettings()">Cancel</button>
          <button class="chat-card-btn chat-card-btn-primary" id="chat-settings-save-btn" onclick="chatSaveSettings()">Save</button>
        </div>
        <div id="chat-settings-account-actions"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  _avUploading = false;
  const nameInp = chatEl('chat-settings-name');
  const avInp   = chatEl('chat-settings-avatar');
  if (nameInp) nameInp.value = chatMyName || '';
  if (avInp)   avInp.value  = chatMyCustomAvatar || '';
  chatPreviewAvatar();
  // Only Discord-linked accounts can be logged out / deleted here — a
  // Spotify-linked identity is managed from the Music tab's own connect flow.
  const actionsEl = chatEl('chat-settings-account-actions');
  if (actionsEl) {
    actionsEl.innerHTML = chatMyProvider === 'discord' ? `
      <div class="chat-settings-danger-zone">
        <button class="chat-card-btn chat-card-btn-muted" onclick="chatLogout()">Log out</button>
        <button class="chat-card-btn chat-card-btn-danger" onclick="chatDeleteAccount()">Delete account</button>
      </div>` : '';
  }
  overlay.style.display = 'flex';
}
window.chatOpenSettings = chatOpenSettings;

function chatCloseSettings() {
  const overlay = chatEl('chat-settings-overlay');
  if (overlay) overlay.style.display = 'none';
}
window.chatCloseSettings = chatCloseSettings;

function chatPreviewAvatar() {
  const preview = chatEl('chat-settings-av-preview');
  const inp     = chatEl('chat-settings-avatar');
  if (!preview) return;
  const url = (inp ? inp.value : '').trim() || chatMyAvatar;
  if (url) {
    preview.innerHTML = `<img src="${esc(url)}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='flex'"><div class="chat-settings-av-init" style="display:none">${esc((chatMyName||'?').slice(0,2).toUpperCase())}</div>`;
  } else {
    preview.innerHTML = `<div class="chat-settings-av-init">${esc((chatMyName||'?').slice(0,2).toUpperCase())}</div>`;
  }
}
window.chatPreviewAvatar = chatPreviewAvatar;

function chatSetAvUploadState(busy) {
  _avUploading = busy;
  const btn = chatEl('chat-settings-save-btn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Uploading…' : 'Save';
}

function chatResizeToDataUrl(dataUrl, maxPx, quality, cb) {
  const img = new Image();
  img.onload = () => {
    let w = img.width, h = img.height;
    if (w > maxPx || h > maxPx) {
      if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
      else        { w = Math.round(w * maxPx / h); h = maxPx; }
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    cb(c.toDataURL('image/jpeg', quality));
  };
  img.src = dataUrl;
}

function chatHandleAvatarFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const raw = e.target.result;
    // Show local preview immediately, then resize before uploading
    const preview = chatEl('chat-settings-av-preview');
    if (preview) preview.innerHTML = `<img src="${esc(raw)}" alt="">`;
    chatSetAvUploadState(true);
    chatResizeToDataUrl(raw, 400, 0.88, resized => {
      fetch(BASE_PATH + '/api/chat/upload-avatar?device=' + deviceId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: resized }),
      }).then(r => r.json()).then(d => {
        if (d.url) {
          const avInp = chatEl('chat-settings-avatar');
          if (avInp) avInp.value = d.url;
        }
        chatSetAvUploadState(false);
      }).catch(() => { chatSetAvUploadState(false); });
    });
  };
  reader.readAsDataURL(file);
  input.value = '';
}
window.chatHandleAvatarFile = chatHandleAvatarFile;

function chatSaveSettings() {
  if (_avUploading) return;
  const nameInp = chatEl('chat-settings-name');
  const avInp   = chatEl('chat-settings-avatar');
  const name    = (nameInp ? nameInp.value : '').trim();
  const avUrl   = (avInp   ? avInp.value   : '').trim();
  if (name && wsReady) try { ws.send(JSON.stringify({ type: 'chat:set-name', name })); } catch {}
  // Only send if avatar actually changed from what's currently saved
  if (avUrl !== (chatMyCustomAvatar || '') && wsReady) {
    try { ws.send(JSON.stringify({ type: 'chat:set-avatar', url: avUrl })); } catch {}
  }
  chatCloseSettings();
}
window.chatSaveSettings = chatSaveSettings;

function chatLogout() {
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:logout' })); } catch {}
}
window.chatLogout = chatLogout;

function chatDeleteAccount() {
  if (!confirm('Delete your chat account? This forgets your linked Discord identity and any custom name/avatar. Your messages stay in chat history, and friends/DMs are unaffected. This can\'t be undone — you\'d need to sign in again to get a chat identity back.')) return;
  if (wsReady) try { ws.send(JSON.stringify({ type: 'chat:delete-account' })); } catch {}
}
window.chatDeleteAccount = chatDeleteAccount;

// ── New DM ────────────────────────────────────────────────────────────────────
function chatKnownUsers() {
  const seen = {};
  for (const msgs of Object.values(chatRoomMsgs)) {
    for (const m of (msgs || [])) {
      if (m.from && m.from !== deviceId && m.from !== 'panel-bot' && m.name) {
        seen[m.from] = { uid: m.from, name: m.name, avatarUrl: m.avatarUrl || '' };
      }
    }
  }
  for (const f of Object.values(chatFriendMap)) {
    seen[f.id] = { uid: f.id, name: f.name, avatarUrl: f.avatarUrl || '' };
  }
  return Object.values(seen);
}

function chatShowNewDM() {
  let overlay = chatEl('chat-new-dm-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'chat-settings-overlay';
    overlay.id = 'chat-new-dm-overlay';
    overlay.innerHTML = `
      <div class="chat-settings-backdrop" onclick="chatCloseNewDM()"></div>
      <div class="chat-settings-box">
        <div class="chat-settings-title">New Message</div>
        <input class="chat-settings-input" id="chat-new-dm-search" type="text" placeholder="Search users…" oninput="chatFilterNewDM()">
        <div id="chat-new-dm-list" style="overflow-y:auto;max-height:220px;margin-top:8px;min-height:40px"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const inp = chatEl('chat-new-dm-search');
  if (inp) inp.value = '';
  chatFilterNewDM();
}
window.chatShowNewDM = chatShowNewDM;

function chatCloseNewDM() {
  const overlay = chatEl('chat-new-dm-overlay');
  if (overlay) overlay.style.display = 'none';
}
window.chatCloseNewDM = chatCloseNewDM;

function chatFilterNewDM() {
  const list  = chatEl('chat-new-dm-list');
  const query = (chatEl('chat-new-dm-search')?.value || '').toLowerCase();
  if (!list) return;
  const users = chatKnownUsers().filter(u => !query || u.name.toLowerCase().includes(query));
  if (!users.length) {
    list.innerHTML = `<div style="font-size:.78rem;color:var(--text-muted);padding:8px 6px">No users found. They need to have messaged in a room you've visited.</div>`;
    return;
  }
  list.innerHTML = users.map(u => {
    const av = u.avatarUrl
      ? `<img src="${esc(u.avatarUrl)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
      : `<div class="chat-avatar" style="width:28px;height:28px;font-size:11px">${esc(u.name.slice(0,2).toUpperCase())}</div>`;
    return `<div class="chat-new-dm-user" onclick="chatStartNewDM('${esc(u.uid)}','${esc(u.name)}','${esc(u.avatarUrl)}')">
      ${av}
      <div class="chat-new-dm-user-name">${esc(u.name)}</div>
    </div>`;
  }).join('');
}
window.chatFilterNewDM = chatFilterNewDM;

function chatStartNewDM(uid, name, av) {
  chatCloseNewDM();
  chatOpenDM(uid, name, av);
}
window.chatStartNewDM = chatStartNewDM;

// ── WS message dispatcher ─────────────────────────────────────────────────────
window.chatOnMessage = function (m) {
  if (m.type === 'chat:history') {
    chatRoomMsgs[m.room] = m.messages || [];
    if (m.room === chatRoom) { chatRenderMessages(); chatUpdateAnnouncementBar(); }
    return;
  }
  if (m.type === 'chat:msg') {
    chatAppendMessage(m.room, m);
    if (m.from === 'panel-bot' || m.isPanelMsg) chatUpdateAnnouncementBar();
    return;
  }
  if (m.type === 'chat:clear') {
    chatRoomMsgs[m.room] = [];
    if (m.room === chatRoom) chatRenderMessages();
    return;
  }
  if (m.type === 'chat:profile') {
    chatMyName         = m.name;
    chatMyAvatar       = m.avatarUrl;
    chatMyCustomAvatar = m.customAvatarUrl || null;
    chatMyProvider     = m.provider;
    chatMyAccountKey   = m.providerId || null;
    chatHideLogin();
    chatUpdateAccountRow();
    if (!chatRoomMsgs['global']) chatJoinRoom('global');
    return;
  }
  if (m.type === 'chat:logged-out') {
    chatMyName = ''; chatMyAvatar = null; chatMyCustomAvatar = null; chatMyProvider = null; chatMyAccountKey = null;
    chatCloseSettings();
    chatUpdateAccountRow();
    chatShowLogin();
    return;
  }
  if (m.type === 'chat:name-set') {
    chatMyName = m.name;
    chatUpdateAccountRow();
    return;
  }
  if (m.type === 'chat:avatar-set') {
    chatMyAvatar       = m.avatarUrl;
    chatMyCustomAvatar = m.customUrl || null;
    chatUpdateAccountRow();
    return;
  }
  if (m.type === 'chat:friends-list') {
    for (const f of (m.friends || [])) chatFriendMap[f.id] = f;
    chatRenderSidebar();
    return;
  }
  // Sent once on WS join/reconnect — server membership is account-keyed, so
  // (unlike Global/DMs) there's no other way this tab learns which servers
  // it belongs to.
  if (m.type === 'chat:my-servers') {
    for (const s of (m.servers || [])) chatServerMap[s.id] = s;
    chatRenderServerRail();
    return;
  }
  if (m.type === 'chat:server-created') {
    chatServerMap[m.server.id] = m.server;
    chatSwitchToServer(m.server.id);
    return;
  }
  if (m.type === 'chat:server-joined') {
    chatServerMap[m.server.id] = m.server;
    chatSwitchToServer(m.server.id);
    if (m.isNew) chatShowServerOnboarding(m.server);
    return;
  }
  if (m.type === 'chat:server-deleted') {
    delete chatServerMap[m.serverId];
    if (chatActiveServerId === m.serverId) chatGoHome();
    else chatRenderServerRail();
    return;
  }
  if (m.type === 'chat:channel-created') {
    const server = chatServerMap[m.serverId];
    if (server) {
      server.channels.push(m.channel);
      if (chatActiveServerId === m.serverId) { chatRenderChannelList(); chatRenderServerSettingsPanels(); }
    }
    return;
  }
  if (m.type === 'chat:role-created') {
    chatServerMap[m.serverId]?.roles.push(m.role);
    if (m.serverId === chatActiveServerId) chatRenderServerSettingsPanels();
    return;
  }
  // chat:members/chat:member-join both carry a full roster snapshot (not a
  // delta) — only chat:member-leave is delta-shaped (just the departing accountKey).
  if (m.type === 'chat:members' || m.type === 'chat:member-join') {
    if (m.serverId === chatActiveServerId) { chatMemberList = m.members || []; chatRenderMemberList(); chatRenderServerSettingsPanels(); }
    return;
  }
  if (m.type === 'chat:member-leave') {
    if (m.serverId === chatActiveServerId) {
      chatMemberList = chatMemberList.filter(x => x.accountKey !== m.accountKey);
      chatRenderMemberList();
      chatRenderServerSettingsPanels();
    }
    return;
  }
  if (m.type === 'chat:friend-req') {
    chatPendingIn[m.fromId] = { id: m.fromId, name: m.fromName, avatarUrl: m.avatarUrl || '' };
    chatRenderSidebar();
    return;
  }
  if (m.type === 'chat:friend-accepted') {
    chatFriendMap[m.byId] = { id: m.byId, name: m.byName, avatarUrl: m.byAvatarUrl || '' };
    chatPendingOut.delete(m.byId);
    delete chatPendingIn[m.byId];
    chatRenderSidebar();
    return;
  }
  if (m.type === 'chat:error') {
    const errEl = document.querySelector('#cs-err,#js-err,#af-err,#chat-login-err,#css-role-err,#css-channel-err');
    if (errEl) errEl.textContent = m.error;
    return;
  }
  // WebRTC
  if (m.type === 'chat:call-participants') {
    for (const p of m.participants || []) chatAddCallPeer(p);
    return;
  }
  if (m.type === 'chat:call-new-peer') {
    if (chatInCall && chatCallRoom === m.room) chatCreateOffer(m.peerId);
    return;
  }
  if (m.type === 'chat:call-joined') {
    if (chatInCall && chatCallRoom === m.room) chatAddCallPeer(m.participant);
    return;
  }
  if (m.type === 'chat:call-left') {
    chatRemoveCallPeer(m.participantId);
    return;
  }
  if (m.type === 'chat:signal') {
    chatHandleSignal(m.from, m.signal);
    return;
  }
};


// ── Calls (WebRTC) ────────────────────────────────────────────────────────────
function chatUpdateCallBar() {
  if (!_chatReady) return;
  const bar     = chatEl('chat-call-bar');
  const callBtn = chatEl('chat-call-btn');
  const active  = chatInCall && chatCallRoom === chatRoom;
  if (bar) bar.classList.toggle('vis', active);
  if (callBtn) {
    callBtn.textContent = active ? '📞 Leave' : '📞 Call';
    callBtn.classList.toggle('in-call', active);
  }
  if (active) {
    const peersEl = chatEl('chat-call-peers');
    if (peersEl) peersEl.innerHTML = Object.values(chatCallPeers).map(p => {
      const av = p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : '';
      return `<div class="chat-call-peer">${av}${esc(p.name)}</div>`;
    }).join('');
  }
}

async function chatToggleCall() {
  if (chatInCall && chatCallRoom === chatRoom) chatLeaveCall();
  else await chatJoinCall(chatRoom);
}
window.chatToggleCall = chatToggleCall;

async function chatJoinCall(room) {
  try {
    chatLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert('Microphone access required for calls: ' + e.message);
    return;
  }
  chatInCall = true; chatCallRoom = room;
  ws.send(JSON.stringify({ type: 'chat:call-join', room }));
  chatUpdateCallBar();
}

function chatLeaveCall() {
  if (!chatInCall) return;
  ws.send(JSON.stringify({ type: 'chat:call-leave', room: chatCallRoom }));
  for (const [id, p] of Object.entries(chatPeers)) {
    try { p.pc.close(); } catch {}
    if (p._audioEl) p._audioEl.remove();
    delete chatPeers[id];
  }
  for (const id of Object.keys(chatCallPeers)) delete chatCallPeers[id];
  if (chatLocalStream) { chatLocalStream.getTracks().forEach(t => t.stop()); chatLocalStream = null; }
  chatInCall = false; chatCallRoom = null; chatMuted = false;
  chatUpdateCallBar();
}
window.chatLeaveCall = chatLeaveCall;

function chatToggleMute() {
  chatMuted = !chatMuted;
  if (chatLocalStream) chatLocalStream.getAudioTracks().forEach(t => { t.enabled = !chatMuted; });
  const btn = chatEl('chat-mute-btn');
  if (btn) { btn.textContent = chatMuted ? 'Unmute' : 'Mute'; btn.classList.toggle('muted', chatMuted); }
}
window.chatToggleMute = chatToggleMute;

function chatAddCallPeer(p) {
  chatCallPeers[p.id] = p;
  chatUpdateCallBar();
}
function chatRemoveCallPeer(id) {
  delete chatCallPeers[id];
  if (chatPeers[id]) {
    try { chatPeers[id].pc.close(); } catch {}
    if (chatPeers[id]._audioEl) chatPeers[id]._audioEl.remove();
    delete chatPeers[id];
  }
  chatUpdateCallBar();
}
function chatMakePeerConn(peerId) {
  if (!chatPeers[peerId]) chatPeers[peerId] = {};
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (chatLocalStream) chatLocalStream.getTracks().forEach(t => pc.addTrack(t, chatLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'chat:signal', to: peerId, room: chatCallRoom, signal: { type: 'ice', candidate: e.candidate } }));
  };
  pc.ontrack = e => {
    const audio = document.createElement('audio');
    audio.srcObject = e.streams[0]; audio.autoplay = true; audio.style.display = 'none';
    document.body.appendChild(audio);
    chatPeers[peerId]._audioEl = audio;
  };
  chatPeers[peerId].pc = pc;
  return pc;
}
async function chatCreateOffer(peerId) {
  const pc = chatMakePeerConn(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'chat:signal', to: peerId, room: chatCallRoom, signal: { type: 'offer', sdp: pc.localDescription } }));
  } catch (e) { console.warn('[chat] offer', e); }
}
async function chatHandleSignal(fromId, signal) {
  if (!chatInCall) return;
  if (signal.type === 'offer') {
    if (!chatPeers[fromId]?.pc) chatMakePeerConn(fromId);
    const pc = chatPeers[fromId].pc;
    try {
      await pc.setRemoteDescription(signal.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({ type: 'chat:signal', to: fromId, room: chatCallRoom, signal: { type: 'answer', sdp: pc.localDescription } }));
    } catch (e) { console.warn('[chat] answer', e); }
  } else if (signal.type === 'answer') {
    const peer = chatPeers[fromId];
    if (peer?.pc) try { await peer.pc.setRemoteDescription(signal.sdp); } catch (e) { console.warn('[chat] setRemote', e); }
  } else if (signal.type === 'ice') {
    const peer = chatPeers[fromId];
    if (peer?.pc) try { await peer.pc.addIceCandidate(signal.candidate); } catch {}
  }
}

})();
