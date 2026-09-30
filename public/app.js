let socket = null;
let me = null;
let selectedUser = null;
let users = [];
let conversations = new Map();
let messageCache = new Map();
let isTyping = false;
let typingTimer = null;
let soundEnabled = localStorage.getItem('mono-chat-sound') !== 'off';
let audioContext = null;

const $ = id => document.getElementById(id);
const els = {
  authView: $('authView'), chatView: $('chatView'), loginForm: $('loginForm'), registerForm: $('registerForm'),
  authError: $('authError'), meAvatar: $('meAvatar'), meName: $('meName'), meUsername: $('meUsername'),
  userSearch: $('userSearch'), peopleList: $('peopleList'), peopleCount: $('peopleCount'), emptyState: $('emptyState'),
  conversation: $('conversation'), chatAvatar: $('chatAvatar'), chatName: $('chatName'), chatStatus: $('chatStatus'),
  messages: $('messages'), messageForm: $('messageForm'), messageInput: $('messageInput'), charCount: $('charCount'),
  soundToggle: $('soundToggle'), logoutBtn: $('logoutBtn'), connectionDot: $('connectionDot'), connectionText: $('connectionText'),
  typingIndicator: $('typingIndicator'), typingText: $('typingText'), toast: $('toast'), emojiBtn: $('emojiBtn')
};

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function escapeHTML(text) {
  return String(text).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]);
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

function formatDay(date) {
  const d = new Date(date); const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined }).format(d);
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function setAuthError(text = '') { els.authError.textContent = text; }

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function setView(authenticated) {
  els.authView.classList.toggle('hidden', authenticated);
  els.chatView.classList.toggle('hidden', !authenticated);
}

function setConnection(online) {
  els.connectionDot.classList.toggle('live', online);
  els.connectionText.textContent = online ? 'Connected' : 'Offline';
}

async function init() {
  syncSoundButton();
  try {
    const result = await api('/api/auth/me');
    me = result.user;
    enterChat();
  } catch {
    setView(false);
  }
}

async function login(event) {
  event.preventDefault(); setAuthError('');
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: $('loginIdentifier').value, password: $('loginPassword').value }) });
    me = result.user; enterChat(); els.loginForm.reset();
  } catch (error) { setAuthError(error.message); }
}

async function register(event) {
  event.preventDefault(); setAuthError('');
  try {
    const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({
      name: $('registerName').value, username: $('registerUsername').value, email: $('registerEmail').value, password: $('registerPassword').value
    }) });
    me = result.user; enterChat(); els.registerForm.reset();
  } catch (error) { setAuthError(error.message); }
}

function enterChat() {
  setView(true);
  els.meAvatar.textContent = initials(me.name);
  els.meName.textContent = me.name;
  els.meUsername.textContent = `@${me.username}`;
  connectSocket();
  refreshUsers();
  refreshConversations();
}

function connectSocket() {
  socket?.disconnect();
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => setConnection(true));
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.on('presence:state', ({ userIds = [] }) => {
    const online = new Set(userIds.map(String));
    users.forEach(user => { user.online = online.has(user.id); });
    renderPeople();
    updateChatHeader();
  });
  socket.on('user:status', ({ userId, online }) => {
    const user = users.find(u => u.id === userId);
    if (user) { user.online = online; renderPeople(); updateChatHeader(); }
  });
  socket.on('message:new', message => handleIncomingMessage(message));
  socket.on('message:read', ({ byUserId, partnerId, readAt }) => {
    const cache = messageCache.get(partnerId); if (!cache) return;
    cache.forEach(msg => { if (msg.senderId === me.id && byUserId === partnerId) msg.readAt = readAt; });
    if (selectedUser?.id === partnerId) renderMessages();
    renderPeople();
  });
  socket.on('presence:request', () => {});
  socket.on('typing:start', ({ fromUserId }) => {
    if (selectedUser?.id === fromUserId) {
      els.typingText.textContent = `${selectedUser.name.split(' ')[0]} is typing…`;
      els.typingIndicator.classList.remove('hidden');
    }
  });
  socket.on('typing:stop', ({ fromUserId }) => {
    if (selectedUser?.id === fromUserId) els.typingIndicator.classList.add('hidden');
  });
}

async function refreshUsers() {
  try {
    const query = encodeURIComponent(els.userSearch.value.trim());
    const result = await api(`/api/users${query ? `?search=${query}` : ''}`);
    const existingOnline = new Map(users.map(u => [u.id, Boolean(u.online)]));
    users = result.users.map(u => ({ ...u, online: existingOnline.get(u.id) || false }));
    renderPeople();
    if (socket?.connected) socket.emit('presence:request');
  } catch (error) { showToast(error.message); }
}

async function refreshConversations() {
  try {
    const result = await api('/api/conversations');
    conversations = new Map(result.conversations.map(c => [c.partnerId, c]));
    renderPeople();
  } catch (error) { showToast(error.message); }
}

function renderPeople() {
  const sorted = [...users].sort((a, b) => {
    const ca = conversations.get(a.id)?.lastMessage?.createdAt || 0;
    const cb = conversations.get(b.id)?.lastMessage?.createdAt || 0;
    if (ca !== cb) return new Date(cb) - new Date(ca);
    return Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);
  });
  els.peopleCount.textContent = sorted.length;
  if (!sorted.length) { els.peopleList.innerHTML = '<div class="person-preview" style="padding:16px">No people found.</div>'; return; }
  els.peopleList.innerHTML = sorted.map(user => {
    const convo = conversations.get(user.id);
    const preview = convo?.lastMessage ? `${convo.lastMessage.senderId === me.id ? 'You: ' : ''}${convo.lastMessage.text}` : 'Start a conversation';
    const active = selectedUser?.id === user.id ? ' active' : '';
    return `<button class="person${active}" data-user-id="${user.id}" type="button">
      <div class="avatar">${escapeHTML(initials(user.name))}</div><span class="status-dot ${user.online ? 'online' : ''}"></span>
      <div class="person-info"><div class="person-line"><span class="person-name">${escapeHTML(user.name)}</span><span class="person-time">${convo?.lastMessage ? formatTime(convo.lastMessage.createdAt) : ''}</span></div><div class="person-preview">${escapeHTML(preview)}</div></div>
    </button>`;
  }).join('');
  els.peopleList.querySelectorAll('.person').forEach(btn => btn.addEventListener('click', () => selectUser(btn.dataset.userId)));
}

async function selectUser(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return;
  selectedUser = user;
  els.emptyState.classList.add('hidden'); els.conversation.classList.remove('hidden');
  els.typingIndicator.classList.add('hidden');
  renderPeople(); updateChatHeader();
  try {
    const result = await api(`/api/chats/${user.id}/messages?limit=100`);
    messageCache.set(user.id, result.messages);
    renderMessages(true);
    socket?.emit('message:markRead', { partnerId: user.id });
    await api(`/api/chats/${user.id}/read`, { method: 'POST' }).catch(() => {});
    if (conversations.has(user.id)) conversations.get(user.id).lastMessage.readAt = new Date().toISOString();
  } catch (error) { showToast(error.message); }
  els.messageInput.focus();
}

function updateChatHeader() {
  if (!selectedUser) return;
  els.chatAvatar.textContent = initials(selectedUser.name);
  els.chatName.textContent = selectedUser.name;
  els.chatStatus.textContent = selectedUser.online ? 'Online now' : `Last seen ${formatTime(selectedUser.lastSeen)}`;
}

function renderMessages(scrollToBottom = false) {
  if (!selectedUser) return;
  const messages = messageCache.get(selectedUser.id) || [];
  let html = ''; let lastDay = null;
  for (const msg of messages) {
    const day = new Date(msg.createdAt).toDateString();
    if (day !== lastDay) { html += `<div class="day-separator">${escapeHTML(formatDay(msg.createdAt))}</div>`; lastDay = day; }
    const mine = msg.senderId === me.id;
    const seen = mine && msg.readAt ? 'read' : '';
    html += `<div class="msg-row ${mine ? 'mine' : ''}"><div><div class="bubble">${escapeHTML(msg.text)}</div><div class="msg-meta ${seen}">${formatTime(msg.createdAt)}${mine ? (msg.readAt ? ' · Seen' : ' · Sent') : ''}</div></div></div>`;
  }
  els.messages.innerHTML = html || '<div class="empty-state" style="height:auto;margin:auto"><div class="empty-icon" style="width:54px;height:54px">＋</div><h2 style="font-size:17px">No messages yet</h2><p>Say hello and start the conversation.</p></div>';
  if (scrollToBottom) requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

function handleIncomingMessage(message) {
  const partnerId = message.senderId === me.id ? message.recipientId : message.senderId;
  if (!messageCache.has(partnerId)) messageCache.set(partnerId, []);
  const cache = messageCache.get(partnerId);
  if (!cache.some(msg => msg.id === message.id)) cache.push(message);
  conversations.set(partnerId, { partnerId, lastMessage: { id: message.id, text: message.text, createdAt: message.createdAt, senderId: message.senderId, readAt: message.readAt } });

  if (selectedUser?.id === partnerId) {
    renderMessages(true);
    if (message.senderId !== me.id) {
      socket?.emit('message:markRead', { partnerId });
      api(`/api/chats/${partnerId}/read`, { method: 'POST' }).catch(() => {});
    }
  } else if (message.senderId !== me.id) {
    showToast(`${users.find(u => u.id === partnerId)?.name || 'New message'} sent you a message`);
  }
  if (message.senderId !== me.id) playMessageSound();
  renderPeople();
}

function sendMessage(event) {
  event.preventDefault();
  if (!selectedUser || !socket?.connected) return showToast('Connect to the server before sending.');
  const text = els.messageInput.value.trim(); if (!text) return;
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  socket.emit('message:send', { recipientId: selectedUser.id, text, clientId }, result => {
    if (!result?.ok) return showToast(result?.error || 'Unable to send message.');
    els.messageInput.value = ''; updateComposer();
    stopTyping();
    if (!messageCache.has(selectedUser.id)) messageCache.set(selectedUser.id, []);
    if (!messageCache.get(selectedUser.id).some(m => m.id === result.message.id)) messageCache.get(selectedUser.id).push(result.message);
    conversations.set(selectedUser.id, { partnerId: selectedUser.id, lastMessage: { id: result.message.id, text: result.message.text, createdAt: result.message.createdAt, senderId: me.id, readAt: result.message.readAt } });
    renderMessages(true); renderPeople();
  });
}

function startTyping() {
  if (!selectedUser || !socket?.connected) return;
  if (!isTyping) { isTyping = true; socket.emit('typing:start', { recipientId: selectedUser.id }); }
  clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 1000);
}
function stopTyping() {
  clearTimeout(typingTimer); typingTimer = null;
  if (isTyping && selectedUser && socket?.connected) socket.emit('typing:stop', { recipientId: selectedUser.id });
  isTyping = false;
}
function updateComposer() {
  els.charCount.textContent = `${els.messageInput.value.length} / 4000`;
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(140, Math.max(36, els.messageInput.scrollHeight))}px`;
}

function beep() {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.05, audioContext.currentTime + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .18);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + .19);
  } catch {}
}
function playMessageSound() { if (soundEnabled) beep(); }
function syncSoundButton() {
  els.soundToggle.classList.toggle('active', soundEnabled);
  els.soundToggle.textContent = soundEnabled ? '♪' : '×';
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  socket?.disconnect(); socket = null; me = null; selectedUser = null; users = []; conversations.clear(); messageCache.clear(); setView(false); setAuthError('');
}

document.querySelectorAll('[data-auth-tab]').forEach(tab => tab.addEventListener('click', () => {
  const mode = tab.dataset.authTab;
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
  els.loginForm.classList.toggle('hidden', mode !== 'login');
  els.registerForm.classList.toggle('hidden', mode !== 'register');
  setAuthError('');
}));
els.loginForm.addEventListener('submit', login);
els.registerForm.addEventListener('submit', register);
els.logoutBtn.addEventListener('click', logout);
els.soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled; localStorage.setItem('mono-chat-sound', soundEnabled ? 'on' : 'off'); syncSoundButton();
  if (soundEnabled) beep();
});
els.messageForm.addEventListener('submit', sendMessage);
els.messageInput.addEventListener('input', () => { updateComposer(); startTyping(); });
els.messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); els.messageForm.requestSubmit(); }
});
els.emojiBtn.addEventListener('click', () => { els.messageInput.value += ' 🙂'; updateComposer(); els.messageInput.focus(); });
els.userSearch.addEventListener('input', refreshUsers);
document.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); els.userSearch.focus(); }
  if (event.key === 'Escape' && document.activeElement === els.userSearch) { els.userSearch.value = ''; refreshUsers(); els.userSearch.blur(); }
});

init();
