// Chat tab — executes once at page load; DOM ops deferred until chatInit()
(function () {
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _chatReady     = false;
let chatRoom       = 'global';
let chatMyName     = '';
let chatMyAvatar   = null;
let chatMyProvider = null;
const chatGroupMap   = {};   // id → { id, name }
const chatRoomUnread = {};   // room → count
const chatRoomMsgs   = {};   // room → [msg, ...]
const chatFriendMap  = {};   // uid → { id, name, avatarUrl }
const chatPendingIn  = {};   // uid → { id, name, avatarUrl }  (incoming requests)
const chatPendingOut = new Set(); // uids I've sent requests to
const chatDMInfo     = {};   // dmRoomId → { uid, name, avatarUrl }

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
  if (_chatReady) return;
  _chatReady = true;

  // Move login overlay to document.body so parent transforms don't clip it
  const _ov = chatEl('chat-login-overlay');
  if (_ov && _ov.parentElement !== document.body) document.body.appendChild(_ov);

  // Check Spotify link; show overlay if not linked
  fetch('/api/chat/me?device=' + deviceId).then(r => r.json()).then(profile => {
    if (profile.authenticated) {
      chatMyName     = profile.name;
      chatMyAvatar   = profile.avatarUrl;
      chatMyProvider = 'spotify';
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

  chatRenderSidebar();
}
window.chatInit = chatInit;

// ── Login ─────────────────────────────────────────────────────────────────────
function chatShowLogin() {
  const el = chatEl('chat-login-overlay');
  if (el) el.style.display = '';
}
function chatHideLogin() {
  const el = chatEl('chat-login-overlay');
  if (el) el.style.display = 'none';
}

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
  const bar  = chatEl('chat-ann-bar');
  const text = chatEl('chat-ann-text');
  const time = chatEl('chat-ann-time');
  if (!bar) return;
  const msgs = chatRoomMsgs[chatRoom] || [];
  const latest = [...msgs].reverse().find(m => m.from === 'panel-bot' || m.isPanelMsg);
  if (!latest) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  if (text) text.textContent = latest.text;
  if (time) time.textContent = new Date(latest.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Room ──────────────────────────────────────────────────────────────────────
function chatRoomLabel(room) {
  if (room === 'global') return 'Global';
  if (room.startsWith('group:')) return chatGroupMap[room]?.name || 'Group';
  if (room.startsWith('dm:')) {
    if (chatDMInfo[room]) return chatDMInfo[room].name;
    const otherId = room.slice(3).split(':').find(id => id !== deviceId);
    return chatFriendMap[otherId]?.name || 'DM';
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
  chatEl('chat-input')?.focus();
}

function chatOpenRoom(room) {
  chatJoinRoom(room);
  document.querySelectorAll('.chat-room-item').forEach(el => {
    el.classList.toggle('active', el.dataset.room === room);
  });
}
window.chatOpenRoom = chatOpenRoom;

// ── Sidebar ───────────────────────────────────────────────────────────────────
function chatRenderSidebar() {
  if (!_chatReady) return;

  // Groups
  const groupEl = chatEl('chat-groups-list');
  if (groupEl) {
    const groups = Object.values(chatGroupMap);
    groupEl.innerHTML = groups.map(g => {
      const u = chatRoomUnread[g.id] || 0;
      return `<div class="chat-room-item${g.id === chatRoom ? ' active' : ''}" data-room="${g.id}" onclick="chatOpenRoom('${g.id}')">
        <div class="chat-room-icon" style="font-size:14px">#</div>
        <div class="chat-room-name">${esc(g.name)}</div>
        ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Global unread badge
  const gu = chatRoomUnread['global'] || 0;
  const gb = chatEl('chat-unread-global');
  if (gb) { gb.textContent = gu; gb.style.display = gu ? '' : 'none'; }

  // DMs section
  const pendingIn = Object.values(chatPendingIn);
  const friends   = Object.values(chatFriendMap);
  const openDMs   = Object.values(chatDMInfo).filter(d => !chatFriendMap[d.uid]);
  const dmsLabel  = chatEl('chat-dms-label');
  const dmsEl     = chatEl('chat-dms-list');
  if (dmsLabel) dmsLabel.style.display = (pendingIn.length || friends.length || openDMs.length) ? '' : 'none';
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
    const showName = !own && m.from !== lastFrom;
    lastFrom = m.from;
    const clickData = own ? null : { uid: m.from, name: m.fromName, av: m.avatarUrl || '' };
    const nameAttrs = own ? '' : ` class="chat-msg-name clickable" data-uid="${esc(m.from)}" data-name="${esc(m.fromName)}" data-av="${esc(m.avatarUrl||'')}" onclick="chatAvatarClick(event,this)"`;

    html += `<div class="chat-msg${own ? ' own' : ''}">
      ${avatarHtml(m.fromName, m.avatarUrl, 32, clickData)}
      <div class="chat-msg-body">
        ${showName ? `<div${own ? ' class="chat-msg-name"' : nameAttrs}>${esc(m.fromName)}</div>` : ''}
        <div class="chat-msg-bubble">${esc(m.text)}</div>
        <div class="chat-msg-time">${esc(timeStr)}</div>
      </div>
    </div>`;
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
    if (m.from === 'panel-bot' || m.isPanelMsg) chatUpdateAnnouncementBar();
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
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
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
  ws.send(JSON.stringify({ type: 'chat:friend-req', targetId: uid }));
  chatRenderSidebar();
}
window.chatDoSendFriendReq = chatDoSendFriendReq;

function chatAcceptFriendReq(uid) {
  const info = chatPendingIn[uid];
  if (info) { chatFriendMap[uid] = info; delete chatPendingIn[uid]; }
  ws.send(JSON.stringify({ type: 'chat:friend-accept', fromId: uid }));
  chatRenderSidebar();
}
window.chatAcceptFriendReq = chatAcceptFriendReq;

function chatRejectFriendReq(uid) {
  delete chatPendingIn[uid];
  ws.send(JSON.stringify({ type: 'chat:friend-reject', fromId: uid }));
  chatRenderSidebar();
}
window.chatRejectFriendReq = chatRejectFriendReq;

// ── WS message dispatcher ─────────────────────────────────────────────────────
window.chatOnMessage = function (m) {
  if (m.type === 'chat:history') {
    chatRoomMsgs[m.room] = m.messages || [];
    if (m.room === chatRoom) { chatRenderMessages(); chatUpdateAnnouncementBar(); }
    return;
  }
  if (m.type === 'chat:msg') {
    chatAppendMessage(m.room, m);
    return;
  }
  if (m.type === 'chat:clear') {
    chatRoomMsgs[m.room] = [];
    if (m.room === chatRoom) chatRenderMessages();
    return;
  }
  if (m.type === 'chat:profile') {
    chatMyName     = m.name;
    chatMyAvatar   = m.avatarUrl;
    chatMyProvider = m.provider;
    chatHideLogin();
    chatUpdateAccountRow();
    if (!chatRoomMsgs['global']) chatJoinRoom('global');
    return;
  }
  if (m.type === 'chat:group-created') {
    chatGroupMap[m.group.id] = m.group;
    chatRenderSidebar();
    return;
  }
  if (m.type === 'chat:friends-list') {
    for (const f of (m.friends || [])) chatFriendMap[f.id] = f;
    chatRenderSidebar();
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
    const errEl = document.querySelector('#cg-err,#jg-err,#jg-err2,#af-err,#chat-login-err');
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


function chatShowGroupMenu() {
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.id = 'chat-group-modal';
  m.innerHTML = `<div class="chat-modal">
    <h3>Groups</h3>
    <div style="display:flex;gap:8px">
      <button class="chat-modal-btn chat-modal-btn-primary" style="font-size:.78rem" onclick="chatShowCreateGroup()">+ Create</button>
      <button class="chat-modal-btn chat-modal-btn-cancel" style="font-size:.78rem" onclick="chatShowJoinGroup()">Join by ID</button>
    </div>
    <div id="group-list-area"><div style="font-size:.78rem;color:#8b93a3">Loading…</div></div>
    <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Close</button>
  </div>`;
  document.body.appendChild(m);
  fetch('/api/chat/groups?device=' + deviceId).then(r => r.json()).then(d => {
    const el = document.getElementById('group-list-area');
    if (!el) return;
    if (!d.groups?.length) { el.innerHTML = '<div style="font-size:.76rem;color:#556">No groups yet. Create one!</div>'; return; }
    el.innerHTML = '<div class="chat-group-list">' + d.groups.map(g =>
      `<div class="chat-group-row" onclick="chatJoinGroupFromList('${g.id}','${esc(g.name)}')">
        <div class="chat-group-row-name">${esc(g.name)}</div>
        <div class="chat-group-row-count">${g.memberCount} member${g.memberCount !== 1 ? 's' : ''}</div>
        ${g.hasCall ? '<span style="font-size:.72rem;color:#3ddc84">📞</span>' : ''}
      </div>`).join('') + '</div>';
  }).catch(() => {});
}
window.chatShowGroupMenu = chatShowGroupMenu;

function chatShowCreateGroup() {
  document.getElementById('chat-group-modal')?.remove();
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Create Group</h3>
    <input class="chat-modal-inp" id="cg-name" placeholder="Group name…" maxlength="50"
      onkeydown="if(event.key==='Enter')document.getElementById('cg-pass').focus()">
    <input class="chat-modal-inp" id="cg-pass" type="password" placeholder="Password (share with members)…"
      onkeydown="if(event.key==='Enter')chatCreateGroup()">
    <div class="chat-modal-err" id="cg-err"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatCreateGroup()">Create</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('#cg-name').focus();
}
window.chatShowCreateGroup = chatShowCreateGroup;

function chatCreateGroup() {
  const name = (document.getElementById('cg-name')?.value || '').trim();
  const password = (document.getElementById('cg-pass')?.value || '').trim();
  const errEl = document.getElementById('cg-err');
  if (!name || !password) { if (errEl) errEl.textContent = 'Name and password required'; return; }
  ws.send(JSON.stringify({ type: 'chat:group-create', name, password }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatCreateGroup = chatCreateGroup;

function chatShowJoinGroup() {
  document.getElementById('chat-group-modal')?.remove();
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Join Group by ID</h3>
    <input class="chat-modal-inp" id="jg-id" placeholder="Group ID…"
      onkeydown="if(event.key==='Enter')document.getElementById('jg-pass').focus()">
    <input class="chat-modal-inp" id="jg-pass" type="password" placeholder="Password…"
      onkeydown="if(event.key==='Enter')chatDoJoinGroup()">
    <div class="chat-modal-err" id="jg-err"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatDoJoinGroup()">Join</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('#jg-id').focus();
}
window.chatShowJoinGroup = chatShowJoinGroup;

function chatJoinGroupFromList(groupId, name) {
  document.querySelector('.chat-modal-overlay')?.remove();
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Join "${esc(name)}"</h3>
    <input class="chat-modal-inp" id="jg-pass2" type="password" placeholder="Password…"
      onkeydown="if(event.key==='Enter')chatDoJoinGroup2('${groupId}')">
    <div class="chat-modal-err" id="jg-err2"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatDoJoinGroup2('${groupId}')">Join</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('#jg-pass2').focus();
}
window.chatJoinGroupFromList = chatJoinGroupFromList;

function chatDoJoinGroup() {
  const groupId  = (document.getElementById('jg-id')?.value || '').trim();
  const password = (document.getElementById('jg-pass')?.value || '').trim();
  const errEl = document.getElementById('jg-err');
  if (!groupId || !password) { if (errEl) errEl.textContent = 'ID and password required'; return; }
  ws.send(JSON.stringify({ type: 'chat:group-join', groupId, password }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatDoJoinGroup = chatDoJoinGroup;

function chatDoJoinGroup2(groupId) {
  const password = (document.getElementById('jg-pass2')?.value || '').trim();
  const errEl = document.getElementById('jg-err2');
  if (!password) { if (errEl) errEl.textContent = 'Password required'; return; }
  ws.send(JSON.stringify({ type: 'chat:group-join', groupId, password }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatDoJoinGroup2 = chatDoJoinGroup2;

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
