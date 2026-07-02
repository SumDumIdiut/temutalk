// Chat tab — executes once at page load; DOM ops deferred until chatInit()
(function () {
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _chatReady     = false;
let chatRoom       = 'global';
let chatMyName     = localStorage.getItem('chatName') || '';
const chatFriendMap  = {};   // id → name
const chatGroupMap   = {};   // id → { id, name }
const chatRoomUnread = {};   // room → count
const chatRoomMsgs   = {};   // room → [msg, ...]

// Call state
let chatInCall       = false;
let chatCallRoom     = null;
const chatPeers      = {};   // peerId → { pc }
let chatLocalStream  = null;
let chatMuted        = false;
const chatCallPeers  = {};   // peerId → { id, name }
const ICE_SERVERS    = [{ urls: 'stun:stun.l.google.com:19302' }];

// ── Tiny utils ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function chatEl(id) { return document.getElementById(id); }

// ── Init (called from navigate() after view.html is injected) ─────────────────
function chatInit() {
  if (_chatReady) return;
  _chatReady = true;

  // Show device ID chip
  const chip = chatEl('chat-did-chip');
  if (chip) {
    chip.textContent = 'ID: ' + deviceId.slice(0, 16) + '…';
    chip.title = 'Click to copy your full Device ID';
    chip.onclick = () => {
      navigator.clipboard.writeText(deviceId).catch(() => {});
      chip.textContent = 'Copied!';
      setTimeout(() => { chip.textContent = 'ID: ' + deviceId.slice(0, 16) + '…'; }, 1500);
    };
  }

  if (chatMyName) {
    chatEl('chat-name-overlay').style.display = 'none';
    if (wsReady) {
      ws.send(JSON.stringify({ type: 'chat:set-name', name: chatMyName }));
      ws.send(JSON.stringify({ type: 'chat:join', room: 'global' }));
    }
  }
  chatRenderSidebar();
  chatRenderMessages();
}
window.chatInit = chatInit;

// ── Name setup ────────────────────────────────────────────────────────────────
function chatSaveName() {
  const inp = chatEl('chat-name-inp');
  const name = (inp?.value || '').trim();
  if (!name) { inp?.focus(); return; }
  chatMyName = name;
  localStorage.setItem('chatName', name);
  if (wsReady) {
    ws.send(JSON.stringify({ type: 'chat:set-name', name }));
    ws.send(JSON.stringify({ type: 'chat:join', room: 'global' }));
  }
  chatEl('chat-name-overlay').style.display = 'none';
}
window.chatSaveName = chatSaveName;

// ── Room helpers ──────────────────────────────────────────────────────────────
function chatRoomLabel(room) {
  if (room === 'global') return 'Global';
  if (room.startsWith('group:')) return chatGroupMap[room]?.name || 'Group';
  if (room.startsWith('dm:')) {
    const otherId = room.slice(3).split(':').find(id => id !== deviceId);
    return chatFriendMap[otherId] || 'DM';
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
  chatEl('chat-input')?.focus();
}

function chatOpenRoom(room) {
  if (room === chatRoom && _chatReady) return;
  chatJoinRoom(room);
  document.querySelectorAll('.chat-room-item').forEach(el => {
    el.classList.toggle('active', el.dataset.room === room);
  });
}
window.chatOpenRoom = chatOpenRoom;

// ── Sidebar ───────────────────────────────────────────────────────────────────
function chatRenderSidebar() {
  if (!_chatReady) return;

  // Friends
  const friendEl = chatEl('chat-friends-list');
  if (friendEl) {
    const entries = Object.entries(chatFriendMap);
    if (!entries.length) {
      friendEl.innerHTML = '<div style="font-size:.7rem;color:#444;padding:3px 8px">No friends yet</div>';
    } else {
      friendEl.innerHTML = entries.map(([id, name]) => {
        const room = 'dm:' + [deviceId, id].sort().join(':');
        const u = chatRoomUnread[room] || 0;
        return `<div class="chat-room-item${room === chatRoom ? ' active' : ''}" data-room="${room}" onclick="chatOpenRoom('${room}')">
          <div class="chat-room-icon" style="font-size:11px">${esc(name.slice(0,2).toUpperCase())}</div>
          <div class="chat-room-name">${esc(name)}</div>
          ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
        </div>`;
      }).join('');
    }
  }

  // Groups
  const groupEl = chatEl('chat-groups-list');
  if (groupEl) {
    const groups = Object.values(chatGroupMap);
    if (!groups.length) {
      groupEl.innerHTML = '<div style="font-size:.7rem;color:#444;padding:3px 8px">No groups yet</div>';
    } else {
      groupEl.innerHTML = groups.map(g => {
        const u = chatRoomUnread[g.id] || 0;
        return `<div class="chat-room-item${g.id === chatRoom ? ' active' : ''}" data-room="${g.id}" onclick="chatOpenRoom('${g.id}')">
          <div class="chat-room-icon" style="font-size:12px">#</div>
          <div class="chat-room-name">${esc(g.name)}</div>
          ${u ? `<div class="chat-room-badge">${u}</div>` : ''}
        </div>`;
      }).join('');
    }
  }

  // Global badge
  const gu = chatRoomUnread['global'] || 0;
  const gb = chatEl('chat-unread-global');
  if (gb) { gb.textContent = gu; gb.style.display = gu ? '' : 'none'; }
}

// ── Messages ──────────────────────────────────────────────────────────────────
function chatRenderMessages() {
  if (!_chatReady) return;
  const el = chatEl('chat-messages');
  if (!el) return;
  const msgs = chatRoomMsgs[chatRoom] || [];
  const empty = chatEl('chat-empty');

  if (!msgs.length) {
    el.innerHTML = '';
    if (empty) el.appendChild(empty);
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  let html = '';
  let lastDate = '';
  for (const m of msgs) {
    const d = new Date(m.ts);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (dateStr !== lastDate) {
      html += `<div class="chat-date-divider"><span>${esc(dateStr)}</span></div>`;
      lastDate = dateStr;
    }
    const own = m.from === deviceId;
    const initials = esc((m.fromName || '?').slice(0, 2).toUpperCase());
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    html += `<div class="chat-msg${own ? ' own' : ''}">
      <div class="chat-msg-avatar" title="${esc(m.fromName)}">${initials}</div>
      <div style="min-width:0">
        ${!own ? `<span class="chat-msg-name">${esc(m.fromName)}</span>` : ''}
        <div class="chat-msg-bubble">${esc(m.text)}</div>
        <span class="chat-msg-time">${esc(timeStr)}</span>
      </div>
    </div>`;
  }
  el.innerHTML = html;
  if (empty) el.appendChild(empty);
  el.scrollTop = el.scrollHeight;
}

function chatAppendMessage(room, m) {
  if (!chatRoomMsgs[room]) chatRoomMsgs[room] = [];
  chatRoomMsgs[room].push(m);
  if (room === chatRoom && _chatReady) {
    const el = chatEl('chat-messages');
    const atBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 80) : false;
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
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
}
window.chatSend = chatSend;

// ── WS message dispatcher (registered in index.html) ─────────────────────────
window.chatOnMessage = function (m) {
  if (m.type === 'chat:history') {
    chatRoomMsgs[m.room] = m.messages || [];
    if (m.room === chatRoom) chatRenderMessages();
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
  if (m.type === 'chat:name-set') {
    chatMyName = m.name;
    return;
  }
  if (m.type === 'chat:friend-req') {
    chatShowFriendReq(m.fromId, m.fromName);
    return;
  }
  if (m.type === 'chat:friend-accepted') {
    chatFriendMap[m.byId] = m.byName;
    chatRenderSidebar();
    return;
  }
  if (m.type === 'chat:group-created') {
    chatGroupMap[m.group.id] = m.group;
    chatRenderSidebar();
    return;
  }
  if (m.type === 'chat:error') {
    const errEl = document.getElementById('chat-modal-err') || document.getElementById('cg-err') || document.getElementById('jg-err') || document.getElementById('jg-err2');
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

// ── Friend request UI ─────────────────────────────────────────────────────────
function chatShowFriendReq(fromId, fromName) {
  const el = chatEl('chat-friend-reqs');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-notif';
  div.dataset.fromId = fromId;
  div.innerHTML = `<div class="chat-notif-text"><b>${esc(fromName)}</b> wants to be friends</div>
    <button class="chat-notif-btn" style="color:#3ddc84" onclick="chatAcceptFriend('${fromId}',this)">✓</button>
    <button class="chat-notif-btn" style="color:#ff6060" onclick="chatRejectFriend('${fromId}',this)">✕</button>`;
  el.appendChild(div);
}

function chatAcceptFriend(fromId, btn) {
  ws.send(JSON.stringify({ type: 'chat:friend-accept', fromId }));
  btn.closest('.chat-notif')?.remove();
}
window.chatAcceptFriend = chatAcceptFriend;

function chatRejectFriend(fromId, btn) {
  ws.send(JSON.stringify({ type: 'chat:friend-reject', fromId }));
  btn.closest('.chat-notif')?.remove();
}
window.chatRejectFriend = chatRejectFriend;

// ── Add friend modal ──────────────────────────────────────────────────────────
function chatShowAddFriend() {
  const m = document.createElement('div');
  m.className = 'chat-modal-overlay';
  m.innerHTML = `<div class="chat-modal">
    <h3>Add Friend</h3>
    <div style="font-size:.76rem;color:#8b93a3">Paste their Device ID (they can find it in the Chat sidebar)</div>
    <input class="chat-modal-inp" id="af-id-inp" placeholder="Device ID…" autocomplete="off"
      onkeydown="if(event.key==='Enter')chatSendFriendReq()">
    <div class="chat-modal-err" id="af-err"></div>
    <div class="chat-modal-row">
      <button class="chat-modal-btn chat-modal-btn-cancel" onclick="this.closest('.chat-modal-overlay').remove()">Cancel</button>
      <button class="chat-modal-btn chat-modal-btn-primary" onclick="chatSendFriendReq()">Send Request</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('#af-id-inp').focus();
}
window.chatShowAddFriend = chatShowAddFriend;

function chatSendFriendReq() {
  const targetId = (document.getElementById('af-id-inp')?.value || '').trim();
  const errEl = document.getElementById('af-err');
  if (!targetId) { if (errEl) errEl.textContent = 'Enter a device ID'; return; }
  ws.send(JSON.stringify({ type: 'chat:friend-req', targetId }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatSendFriendReq = chatSendFriendReq;

// ── Group modals ──────────────────────────────────────────────────────────────
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
    if (!d.groups?.length) { el.innerHTML = '<div style="font-size:.76rem;color:#556">No groups exist yet. Create one!</div>'; return; }
    el.innerHTML = '<div class="chat-group-list">' + d.groups.map(g => `
      <div class="chat-group-row" onclick="chatJoinGroupFromList('${g.id}','${esc(g.name)}')">
        <div class="chat-group-row-name">${esc(g.name)}</div>
        <div class="chat-group-row-count">${g.memberCount} member${g.memberCount !== 1 ? 's' : ''}</div>
        ${g.hasCall ? '<div style="font-size:.72rem;color:#3ddc84">📞</div>' : ''}
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
    <input class="chat-modal-inp" id="cg-name" placeholder="Group name…" maxlength="50" autocomplete="off"
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
    <input class="chat-modal-inp" id="jg-id" placeholder="Group ID (starts with group:)…" autocomplete="off"
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
  const errEl    = document.getElementById('jg-err');
  if (!groupId || !password) { if (errEl) errEl.textContent = 'ID and password required'; return; }
  ws.send(JSON.stringify({ type: 'chat:group-join', groupId, password }));
  document.querySelector('.chat-modal-overlay')?.remove();
}
window.chatDoJoinGroup = chatDoJoinGroup;

function chatDoJoinGroup2(groupId) {
  const password = (document.getElementById('jg-pass2')?.value || '').trim();
  const errEl    = document.getElementById('jg-err2');
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
    if (peersEl) peersEl.innerHTML = Object.values(chatCallPeers)
      .map(p => `<div class="chat-call-peer">${esc(p.name)}</div>`).join('');
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
    alert('Mic access required for calls: ' + e.message);
    return;
  }
  chatInCall   = true;
  chatCallRoom = room;
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
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (chatLocalStream) chatLocalStream.getTracks().forEach(t => pc.addTrack(t, chatLocalStream));
  pc.onicecandidate = e => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'chat:signal', to: peerId, room: chatCallRoom, signal: { type: 'ice', candidate: e.candidate } }));
  };
  pc.ontrack = e => {
    const audio = document.createElement('audio');
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    chatPeers[peerId]._audioEl = audio;
  };
  chatPeers[peerId] = { pc };
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
    if (!chatPeers[fromId]) chatMakePeerConn(fromId);
    const pc = chatPeers[fromId].pc;
    try {
      await pc.setRemoteDescription(signal.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({ type: 'chat:signal', to: fromId, room: chatCallRoom, signal: { type: 'answer', sdp: pc.localDescription } }));
    } catch (e) { console.warn('[chat] answer', e); }
  } else if (signal.type === 'answer') {
    const peer = chatPeers[fromId];
    if (peer) try { await peer.pc.setRemoteDescription(signal.sdp); } catch (e) { console.warn('[chat] setRemote', e); }
  } else if (signal.type === 'ice') {
    const peer = chatPeers[fromId];
    if (peer) try { await peer.pc.addIceCandidate(signal.candidate); } catch {}
  }
}

})();
