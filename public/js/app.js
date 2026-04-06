/* ── WotsApp frontend ── */

// ─── State ───────────────────────────────────────────────────────────────────

let contacts = [];
let groups = [];
let activeChatId = null;
let activeChatIsGroup = false;
let unreadCounts = {};         // chatId → count
let typingTimers = {};         // chatId → timeout handle
let currentGroupTypers = {};   // chatId → Set of contactIds currently typing

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadContacts(), loadGroups()]);
  renderChatList();
  connectSSE();
  setupEventListeners();
  checkSettings();
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

async function loadContacts() {
  contacts = await api('GET', '/api/contacts');
}

async function loadGroups() {
  groups = await api('GET', '/api/groups');
}

// ─── Chat list rendering ─────────────────────────────────────────────────────

async function renderChatList() {
  const list = document.getElementById('chat-list');
  const search = document.getElementById('search-input').value.toLowerCase();

  // Load previews for all chats
  const allChats = [
    ...contacts.map(c => ({ ...c, isGroup: false, chatId: c.id })),
    ...groups.map(g => ({ ...g, isGroup: true, chatId: g.id }))
  ];

  if (!allChats.length) {
    list.innerHTML = '<div class="empty-list">No contacts yet.<br>Tap the contact icon to add one.</div>';
    return;
  }

  // Load last messages and sort by time
  const previews = await Promise.all(allChats.map(async item => {
    const chat = await api('GET', `/api/chats/${item.chatId}`);
    const msgs = chat.messages;
    const last = msgs[msgs.length - 1] || null;
    return { ...item, lastMsg: last, msgCount: msgs.length };
  }));

  previews.sort((a, b) => {
    const ta = a.lastMsg ? a.lastMsg.timestamp : a.createdAt;
    const tb = b.lastMsg ? b.lastMsg.timestamp : b.createdAt;
    return tb - ta;
  });

  const filtered = search
    ? previews.filter(p => p.name.toLowerCase().includes(search))
    : previews;

  list.innerHTML = '';
  for (const item of filtered) {
    list.appendChild(buildChatItem(item));
  }
}

function buildChatItem(item) {
  const div = document.createElement('div');
  div.className = 'chat-item' + (activeChatId === item.chatId ? ' active' : '');
  div.dataset.chatId = item.chatId;
  div.dataset.isGroup = item.isGroup;

  const unread = unreadCounts[item.chatId] || 0;
  const last = item.lastMsg;
  const timeStr = last ? formatTime(last.timestamp) : '';
  const preview = last ? truncate(last.text, 42) : (item.isGroup ? 'Group chat' : item.personality ? truncate(item.personality, 42) : '');
  const isUnread = unread > 0;

  const initials = item.isGroup
    ? item.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : item.name.charAt(0).toUpperCase();

  const avatarStyle = item.isGroup ? '' : `background:${item.color}`;

  div.innerHTML = `
    <div class="chat-item-avatar ${item.isGroup ? 'group-avatar' : ''}" style="${avatarStyle}">${initials}</div>
    <div class="chat-item-body">
      <div class="chat-item-top">
        <span class="chat-item-name">${esc(item.name)}</span>
        <span class="chat-item-time ${isUnread ? 'unread-time' : ''}">${timeStr}</span>
      </div>
      <div class="chat-item-bottom">
        ${last && !last.fromUser && !last.isGroup ? ticksSVG(last.status) : ''}
        <span class="chat-item-preview">${esc(preview)}</span>
        ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
      </div>
    </div>
  `;

  div.addEventListener('click', () => openChat(item.chatId, item.isGroup));
  return div;
}

// ─── Open chat ───────────────────────────────────────────────────────────────

async function openChat(chatId, isGroup) {
  activeChatId = chatId;
  activeChatIsGroup = isGroup;
  unreadCounts[chatId] = 0;

  document.getElementById('welcome-screen').classList.add('hidden');
  const chatView = document.getElementById('chat-view');
  chatView.classList.remove('hidden');

  // Mobile: show main panel
  document.getElementById('main').classList.add('mobile-visible');

  // Header
  const entity = isGroup
    ? groups.find(g => g.id === chatId)
    : contacts.find(c => c.id === chatId);

  if (!entity) return;

  const initials = isGroup
    ? entity.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : entity.name.charAt(0).toUpperCase();

  const headerAvatar = document.getElementById('chat-header-avatar');
  headerAvatar.textContent = initials;
  headerAvatar.style.background = isGroup ? '#6a7f8c' : entity.color;

  document.getElementById('chat-header-name').textContent = entity.name;
  document.getElementById('chat-header-status').textContent = isGroup
    ? entity.members.map(id => contacts.find(c => c.id === id)?.name).filter(Boolean).join(', ')
    : 'AI contact';

  // Load messages
  const chat = await api('GET', `/api/chats/${chatId}`);
  renderMessages(chat.messages, isGroup);

  // Highlight in list
  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', el.dataset.chatId === chatId);
  });

  // Focus input
  document.getElementById('message-input').focus();

  // Re-render chat list to update unread counts
  renderChatList();
}

// ─── Message rendering ───────────────────────────────────────────────────────

function renderMessages(messages, isGroup) {
  const container = document.getElementById('messages-container');
  container.innerHTML = '';
  // Remove any stale typing bubble
  removeTypingBubble(activeChatId);

  let lastDate = null;
  for (const msg of messages) {
    const msgDate = toDateString(msg.timestamp);
    if (msgDate !== lastDate) {
      container.appendChild(dateSeparator(msgDate));
      lastDate = msgDate;
    }
    container.appendChild(buildMsgBubble(msg, isGroup));
  }
  scrollToBottom();
}

function buildMsgBubble(msg, isGroup) {
  const div = document.createElement('div');
  const isOut = msg.fromUser || msg.senderId === 'user';
  div.className = 'msg-bubble ' + (isOut ? 'out' : (isGroup ? 'group-in' : 'in'));
  div.dataset.msgId = msg.id;

  let senderHTML = '';
  if (isGroup && !isOut && msg.senderName) {
    const color = msg.senderColor || '#8696a0';
    senderHTML = `<div class="msg-sender" style="color:${color}">${esc(msg.senderName)}</div>`;
  }

  const tickHTML = isOut ? `<span class="msg-ticks">${ticksSVG(msg.status)}</span>` : '';

  div.innerHTML = `
    ${senderHTML}
    <span class="msg-text">${esc(msg.text)}</span>
    <span class="msg-meta">
      <span class="msg-time">${formatTime(msg.timestamp)}</span>
      ${tickHTML}
    </span>
  `;
  return div;
}

function dateSeparator(dateStr) {
  const el = document.createElement('div');
  el.className = 'date-sep';
  el.innerHTML = `<span>${esc(dateStr)}</span>`;
  return el;
}

// ─── Typing indicator ────────────────────────────────────────────────────────

function showTyping(chatId, contactId, isGroup) {
  if (chatId !== activeChatId) return;

  // Track group typers
  if (!currentGroupTypers[chatId]) currentGroupTypers[chatId] = new Set();
  currentGroupTypers[chatId].add(contactId);

  const contact = contacts.find(c => c.id === contactId);
  const name = contact ? contact.name : '';

  // Remove existing typing bubble for this chat
  removeTypingBubble(chatId);

  const container = document.getElementById('messages-container');
  const bubble = document.createElement('div');
  bubble.className = 'typing-bubble';
  bubble.id = `typing-${chatId}`;

  const nameEl = (isGroup && name) ? `<span class="typing-name">${esc(name)}</span>` : '';
  bubble.innerHTML = `${nameEl}<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
  container.appendChild(bubble);

  // Update header status
  const statusEl = document.getElementById('chat-header-status');
  if (statusEl) {
    statusEl.textContent = isGroup ? `${name} is typing…` : 'typing…';
  }

  scrollToBottom();
}

function stopTyping(chatId, contactId, isGroup) {
  if (currentGroupTypers[chatId]) {
    currentGroupTypers[chatId].delete(contactId);
    if (currentGroupTypers[chatId].size > 0) return; // others still typing
  }

  removeTypingBubble(chatId);

  // Reset header status
  if (chatId === activeChatId) {
    const statusEl = document.getElementById('chat-header-status');
    const entity = activeChatIsGroup
      ? groups.find(g => g.id === chatId)
      : contacts.find(c => c.id === chatId);
    if (statusEl && entity) {
      statusEl.textContent = activeChatIsGroup
        ? entity.members.map(id => contacts.find(c => c.id === id)?.name).filter(Boolean).join(', ')
        : 'AI contact';
    }
  }
}

function removeTypingBubble(chatId) {
  const el = document.getElementById(`typing-${chatId}`);
  if (el) el.remove();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('message', e => {
    const { chatId, message, isGroup } = JSON.parse(e.data);
    handleIncomingMessage(chatId, message, isGroup);
  });

  es.addEventListener('typing', e => {
    const { chatId, contactId, isGroup, stop } = JSON.parse(e.data);
    if (stop) stopTyping(chatId, contactId, isGroup);
    else showTyping(chatId, contactId, isGroup);
  });

  es.addEventListener('messageStatus', e => {
    const { chatId, messageId, status } = JSON.parse(e.data);
    updateMessageStatus(chatId, messageId, status);
  });

  es.addEventListener('error', e => {
    const { chatId, error } = JSON.parse(e.data);
    showToast(error, true);
    stopTyping(chatId, null, false);
  });

  es.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

function handleIncomingMessage(chatId, message, isGroup) {
  removeTypingBubble(chatId);

  if (chatId === activeChatId) {
    const container = document.getElementById('messages-container');
    // Check date separator
    const msgs = container.querySelectorAll('[data-msg-id]');
    const lastMsg = msgs[msgs.length - 1];
    const lastTime = lastMsg ? parseInt(lastMsg.dataset.ts || '0') : 0;
    if (!lastTime || toDateString(lastTime) !== toDateString(message.timestamp)) {
      container.appendChild(dateSeparator(toDateString(message.timestamp)));
    }
    const bubble = buildMsgBubble(message, isGroup);
    bubble.dataset.ts = message.timestamp;
    container.appendChild(bubble);
    scrollToBottom();
  } else {
    unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
  }

  renderChatList();
}

function updateMessageStatus(chatId, messageId, status) {
  if (chatId !== activeChatId) return;
  const bubble = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!bubble) return;
  const ticks = bubble.querySelector('.msg-ticks');
  if (ticks) ticks.innerHTML = ticksSVG(status);
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !activeChatId) return;

  input.value = '';
  autoResize(input);

  try {
    const endpoint = activeChatIsGroup
      ? `/api/groups/${activeChatId}/send`
      : `/api/chats/${activeChatId}/send`;

    const msg = await api('POST', endpoint, { text });

    // Optimistically render
    const container = document.getElementById('messages-container');
    const bubble = buildMsgBubble(msg, activeChatIsGroup);
    bubble.dataset.ts = msg.timestamp;
    container.appendChild(bubble);
    scrollToBottom();
    renderChatList();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Contact modal
let editingContactId = null;

function openContactModal(contact = null) {
  editingContactId = contact ? contact.id : null;
  document.getElementById('modal-contact-title').textContent = contact ? 'Edit Contact' : 'Add Contact';
  document.getElementById('contact-name').value = contact ? contact.name : '';
  document.getElementById('contact-personality').value = contact ? contact.personality : '';
  openModal('modal-contact');
  setTimeout(() => document.getElementById('contact-name').focus(), 50);
}

async function saveContact() {
  const name = document.getElementById('contact-name').value.trim();
  const personality = document.getElementById('contact-personality').value.trim();
  if (!name) { showToast('Name is required', true); return; }
  if (!personality) { showToast('Personality is required', true); return; }

  try {
    if (editingContactId) {
      await api('PUT', `/api/contacts/${editingContactId}`, { name, personality });
    } else {
      await api('POST', '/api/contacts', { name, personality });
    }
    closeModal('modal-contact');
    await loadContacts();
    renderChatList();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Group modal
async function openGroupModal() {
  await loadContacts();
  const list = document.getElementById('group-member-list');
  list.innerHTML = '';
  if (!contacts.length) {
    list.innerHTML = '<div style="color:var(--text-sec);font-size:13px">Add contacts first</div>';
  } else {
    contacts.forEach(c => {
      const label = document.createElement('label');
      label.className = 'member-check';
      label.innerHTML = `<input type="checkbox" value="${c.id}" /><span>${esc(c.name)}</span>`;
      list.appendChild(label);
    });
  }
  document.getElementById('group-name').value = '';
  openModal('modal-group');
  setTimeout(() => document.getElementById('group-name').focus(), 50);
}

async function saveGroup() {
  const name = document.getElementById('group-name').value.trim();
  const members = [...document.querySelectorAll('#group-member-list input:checked')].map(i => i.value);
  if (!name) { showToast('Group name is required', true); return; }
  if (members.length < 2) { showToast('Select at least 2 members', true); return; }

  try {
    await api('POST', '/api/groups', { name, members });
    closeModal('modal-group');
    await loadGroups();
    renderChatList();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Settings modal
async function openSettingsModal() {
  try {
    const s = await api('GET', '/api/settings');
    document.getElementById('settings-provider').value = s.provider || 'openai';
    document.getElementById('settings-model').value = s.model || '';
    document.getElementById('settings-apikey').value = '';
    document.getElementById('settings-key-status').textContent = s.hasKey ? '✓ API key saved' : 'No API key saved yet';
    openModal('modal-settings');
    setTimeout(() => document.getElementById('settings-apikey').focus(), 50);
  } catch (err) { showToast(err.message, true); }
}

async function saveSettings() {
  const provider = document.getElementById('settings-provider').value;
  const model = document.getElementById('settings-model').value.trim();
  const apiKey = document.getElementById('settings-apikey').value.trim();
  try {
    await api('POST', '/api/settings', { provider, model, apiKey: apiKey || undefined });
    closeModal('modal-settings');
    showToast('Settings saved');
  } catch (err) { showToast(err.message, true); }
}

// ─── Settings check on load ──────────────────────────────────────────────────

async function checkSettings() {
  try {
    const s = await api('GET', '/api/settings');
    if (!s.hasKey) {
      // Show a gentle hint after 1 second
      setTimeout(() => showToast('Add your API key in Settings to enable AI replies'), 1000);
    }
  } catch {}
}

// ─── Event listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
  // Search
  document.getElementById('search-input').addEventListener('input', renderChatList);

  // Send
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('message-input').addEventListener('input', function() { autoResize(this); });

  // Buttons
  document.getElementById('btn-new-contact').addEventListener('click', () => openContactModal());
  document.getElementById('btn-new-group').addEventListener('click', openGroupModal);
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-back').addEventListener('click', () => {
    document.getElementById('main').classList.remove('mobile-visible');
    activeChatId = null;
  });

  // Contact modal
  document.getElementById('btn-contact-save').addEventListener('click', saveContact);
  document.getElementById('btn-contact-cancel').addEventListener('click', () => closeModal('modal-contact'));

  // Group modal
  document.getElementById('btn-group-save').addEventListener('click', saveGroup);
  document.getElementById('btn-group-cancel').addEventListener('click', () => closeModal('modal-group'));

  // Settings modal
  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);
  document.getElementById('btn-settings-cancel').addEventListener('click', () => closeModal('modal-settings'));

  // Close modals on overlay click
  ['modal-contact', 'modal-group', 'modal-settings'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      if (e.target.classList.contains('modal-overlay')) closeModal(id);
    });
  });

  // Keyboard escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['modal-contact', 'modal-group', 'modal-settings'].forEach(closeModal);
    }
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function toDateString(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str || '';
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

// ─── Tick SVGs ────────────────────────────────────────────────────────────────

function ticksSVG(status) {
  if (status === 'sent') return singleTick('#8696a0');
  if (status === 'delivered') return doubleTick('#8696a0');
  if (status === 'read') return doubleTick('#53bdeb');
  return '';
}

function singleTick(color) {
  return `<svg class="tick-svg" viewBox="0 0 16 11" fill="${color}" xmlns="http://www.w3.org/2000/svg"><path d="M11.071.643a.75.75 0 0 1 .043 1.06L5.8 7.976a.75.75 0 0 1-1.07.036L2.22 5.565a.75.75 0 0 1 1.06-1.06l2.003 2.003 4.73-5.822a.75.75 0 0 1 1.058-.043z"/></svg>`;
}

function doubleTick(color) {
  return `<svg class="tick-svg" viewBox="0 0 18 11" fill="${color}" xmlns="http://www.w3.org/2000/svg"><path d="M17.394.643a.75.75 0 0 1 .043 1.06l-5.316 6.273a.75.75 0 0 1-1.07.036L8.545 5.606a.75.75 0 0 1 1.06-1.06l1.998 1.997 4.73-5.857a.75.75 0 0 1 1.061-.043zM11.4.68a.75.75 0 0 1 .042 1.059L6.126 8.012a.75.75 0 0 1-1.07.036L2.55 5.606a.75.75 0 0 1 1.06-1.06l1.999 1.997 4.73-5.82A.75.75 0 0 1 11.4.68z"/></svg>`;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
