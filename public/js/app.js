/* ── WotsApp frontend ── */

// ─── State ───────────────────────────────────────────────────────────────────

let contacts = [];
let groups = [];
let activeChats = { contacts: [], groups: [] };  // IDs the user has started chatting with
let account = null;

let activeChatId = null;
let activeChatIsGroup = false;
let activeChatPending = false;   // true = user opened but hasn't sent first msg yet

let unreadCounts = {};
let currentGroupTypers = {};   // chatId → Set of contactIds typing

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    account = await api('GET', '/api/account');
    launchApp();
  } catch {
    showSetupScreen();
  }
});

function showSetupScreen() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('setup-displayname').focus();
}

async function launchApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Show user's initials/name in avatar
  const initials = account.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('my-avatar').textContent = initials;
  document.getElementById('my-avatar').title = account.displayName;

  await Promise.all([loadContacts(), loadGroups(), loadActiveChats()]);
  renderChatList();
  connectSSE();
  setupEventListeners();
  checkSettings();
}

// ─── Account setup ────────────────────────────────────────────────────────────

document.getElementById('btn-create-account').addEventListener('click', createAccount);
document.getElementById('setup-displayname').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-username').focus();
});
document.getElementById('setup-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') createAccount();
});

async function createAccount() {
  const displayName = document.getElementById('setup-displayname').value.trim();
  const username = document.getElementById('setup-username').value.trim();
  if (!displayName) { document.getElementById('setup-displayname').focus(); return; }
  if (!username) { document.getElementById('setup-username').focus(); return; }
  try {
    account = await api('POST', '/api/account', { displayName, username });
    launchApp();
  } catch (err) {
    showToast(err.message, true);
  }
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

async function loadContacts() { contacts = await api('GET', '/api/contacts'); }
async function loadGroups() { groups = await api('GET', '/api/groups'); }
async function loadActiveChats() { activeChats = await api('GET', '/api/active-chats'); }

// ─── Chat list (only active chats) ───────────────────────────────────────────

async function renderChatList() {
  const list = document.getElementById('chat-list');
  const search = document.getElementById('search-input').value.toLowerCase();

  const activeContacts = contacts.filter(c => activeChats.contacts.includes(c.id));
  const activeGroups = groups.filter(g => activeChats.groups.includes(g.id));

  const allActive = [
    ...activeContacts.map(c => ({ ...c, isGroup: false, chatId: c.id })),
    ...activeGroups.map(g => ({ ...g, isGroup: true, chatId: g.id }))
  ];

  if (!allActive.length) {
    list.innerHTML = `<div class="empty-list">No conversations yet.<br>Tap <strong>New Chat</strong> to find someone to talk to.</div>`;
    return;
  }

  // Load last messages and sort by recency
  const previews = await Promise.all(allActive.map(async item => {
    const chat = await api('GET', `/api/chats/${item.chatId}`);
    const msgs = chat.messages;
    const last = msgs[msgs.length - 1] || null;
    return { ...item, lastMsg: last };
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
  for (const item of filtered) list.appendChild(buildChatItem(item));
}

function buildChatItem(item) {
  const div = document.createElement('div');
  div.className = 'chat-item' + (activeChatId === item.chatId ? ' active' : '');
  div.dataset.chatId = item.chatId;

  const unread = unreadCounts[item.chatId] || 0;
  const last = item.lastMsg;
  const timeStr = last ? formatTime(last.timestamp) : '';
  const preview = last ? truncate(last.text, 42) : (item.isGroup ? 'Group chat' : '');
  const isUnread = unread > 0;

  const initials = item.isGroup
    ? item.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : item.name.charAt(0).toUpperCase();

  const avatarStyle = item.isGroup ? '' : `background:${item.color}`;

  div.innerHTML = `
    <div class="chat-item-avatar ${item.isGroup ? 'group-avatar' : ''}" style="${avatarStyle}">${initials}</div>
    <div class="chat-item-body">
      <div class="chat-item-top">
        <span class="chat-item-name">${esc(item.name)}</span>${item.username ? `<span class="chat-item-handle">@${esc(item.username)}</span>` : ''}
        <span class="chat-item-time ${isUnread ? 'unread-time' : ''}">${timeStr}</span>
      </div>
      <div class="chat-item-bottom">
        <span class="chat-item-preview">${esc(preview)}</span>
        ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
      </div>
    </div>
  `;

  div.addEventListener('click', () => openChat(item.chatId, item.isGroup));
  return div;
}

// ─── New Chat directory panel ─────────────────────────────────────────────────

function openNewChatPanel() {
  document.getElementById('panel-new-chat').classList.remove('hidden');
  document.getElementById('directory-search').value = '';
  renderDirectory('');
  setTimeout(() => document.getElementById('directory-search').focus(), 60);
}

function closeNewChatPanel() {
  document.getElementById('panel-new-chat').classList.add('hidden');
}

function renderDirectory(search) {
  const list = document.getElementById('directory-list');
  const q = search.toLowerCase();

  const filteredContacts = contacts.filter(c =>
    !q || c.name.toLowerCase().includes(q) || (c.personality || '').toLowerCase().includes(q)
  );
  const filteredGroups = groups.filter(g =>
    !q || g.name.toLowerCase().includes(q)
  );

  if (!filteredContacts.length && !filteredGroups.length) {
    list.innerHTML = `<div class="dir-empty">No contacts found.<br>Add contacts via <a href="/manage" style="color:var(--accent)">the editor</a>.</div>`;
    return;
  }

  list.innerHTML = '';

  if (filteredContacts.length) {
    const label = document.createElement('div');
    label.className = 'dir-section-label';
    label.textContent = 'Contacts';
    list.appendChild(label);

    filteredContacts.forEach(c => {
      const isActive = activeChats.contacts.includes(c.id);
      const row = document.createElement('div');
      row.className = 'dir-item';
      row.innerHTML = `
        <div class="dir-item-avatar" style="background:${c.color}">${c.name.charAt(0).toUpperCase()}</div>
        <div class="dir-item-info">
          <div class="dir-item-name">${esc(c.name)}${c.username ? `<span style="font-size:13px;color:var(--text-sec);font-weight:400;margin-left:6px">@${esc(c.username)}</span>` : ''}</div>
          <div class="dir-item-bio">${esc(truncate(c.personality, 55))}</div>
        </div>
        ${isActive ? '<span class="dir-item-active">In chats</span>' : ''}
      `;
      row.addEventListener('click', () => {
        closeNewChatPanel();
        openChat(c.id, false);
      });
      list.appendChild(row);
    });
  }

  if (filteredGroups.length) {
    const label = document.createElement('div');
    label.className = 'dir-section-label';
    label.textContent = 'Groups';
    list.appendChild(label);

    filteredGroups.forEach(g => {
      const isActive = activeChats.groups.includes(g.id);
      const memberNames = (g.members || []).map(id => contacts.find(c => c.id === id)?.name).filter(Boolean).join(', ');
      const initials = g.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const row = document.createElement('div');
      row.className = 'dir-item';
      row.innerHTML = `
        <div class="dir-item-avatar" style="background:#6a7f8c">${initials}</div>
        <div class="dir-item-info">
          <div class="dir-item-name">${esc(g.name)}</div>
          <div class="dir-item-bio">${esc(truncate(memberNames, 55))}</div>
        </div>
        ${isActive ? '<span class="dir-item-active">In chats</span>' : ''}
      `;
      row.addEventListener('click', () => {
        closeNewChatPanel();
        openChat(g.id, true);
      });
      list.appendChild(row);
    });
  }
}

// ─── Open chat ────────────────────────────────────────────────────────────────

async function openChat(chatId, isGroup) {
  activeChatId = chatId;
  activeChatIsGroup = isGroup;
  activeChatPending = isGroup
    ? !activeChats.groups.includes(chatId)
    : !activeChats.contacts.includes(chatId);

  unreadCounts[chatId] = 0;

  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('main').classList.add('mobile-visible');

  const entity = isGroup ? groups.find(g => g.id === chatId) : contacts.find(c => c.id === chatId);
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
    : (entity.username ? `@${entity.username}` : 'AI contact');

  const chat = await api('GET', `/api/chats/${chatId}`);
  renderMessages(chat.messages, isGroup);

  document.querySelectorAll('.chat-item').forEach(el =>
    el.classList.toggle('active', el.dataset.chatId === chatId)
  );

  document.getElementById('message-input').focus();
  renderChatList();
}

// ─── Message rendering ────────────────────────────────────────────────────────

function renderMessages(messages, isGroup) {
  const container = document.getElementById('messages-container');
  container.innerHTML = '';
  removeTypingBubble(activeChatId);

  let lastDate = null;
  for (const msg of messages) {
    const msgDate = toDateString(msg.timestamp);
    if (msgDate !== lastDate) {
      container.appendChild(dateSeparator(msgDate));
      lastDate = msgDate;
    }
    const bubble = buildMsgBubble(msg, isGroup);
    bubble.dataset.ts = msg.timestamp;
    container.appendChild(bubble);
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

// ─── Typing indicator ─────────────────────────────────────────────────────────

function showTyping(chatId, contactId, isGroup) {
  if (chatId !== activeChatId) return;
  if (!currentGroupTypers[chatId]) currentGroupTypers[chatId] = new Set();
  currentGroupTypers[chatId].add(contactId);

  const contact = contacts.find(c => c.id === contactId);
  const name = contact ? contact.name : '';

  removeTypingBubble(chatId);

  const container = document.getElementById('messages-container');
  const bubble = document.createElement('div');
  bubble.className = 'typing-bubble';
  bubble.id = `typing-${chatId}`;

  const nameEl = (isGroup && name) ? `<span class="typing-name">${esc(name)}</span>` : '';
  bubble.innerHTML = `${nameEl}<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
  container.appendChild(bubble);

  const statusEl = document.getElementById('chat-header-status');
  if (statusEl) statusEl.textContent = isGroup ? `${name} is typing…` : 'typing…';

  scrollToBottom();
}

function stopTyping(chatId, contactId, isGroup) {
  if (currentGroupTypers[chatId]) {
    currentGroupTypers[chatId].delete(contactId);
    if (currentGroupTypers[chatId].size > 0) return;
  }
  removeTypingBubble(chatId);

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
  document.getElementById(`typing-${chatId}`)?.remove();
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

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
  es.onerror = () => setTimeout(connectSSE, 3000);
}

function handleIncomingMessage(chatId, message, isGroup) {
  removeTypingBubble(chatId);

  // If this chat just became active (offline message to a chat we own), reload active list
  const isKnownActive = isGroup
    ? activeChats.groups.includes(chatId)
    : activeChats.contacts.includes(chatId);

  if (chatId === activeChatId) {
    const container = document.getElementById('messages-container');
    const msgs = container.querySelectorAll('[data-msg-id]');
    const lastTs = msgs.length ? parseInt(msgs[msgs.length - 1].dataset.ts || '0') : 0;
    if (!lastTs || toDateString(lastTs) !== toDateString(message.timestamp)) {
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
  const ticks = bubble?.querySelector('.msg-ticks');
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

    // If this was a pending (first-time) chat, it's now active
    if (activeChatPending) {
      activeChatPending = false;
      await loadActiveChats();
    }

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

// ─── Settings modal ───────────────────────────────────────────────────────────

async function openSettingsModal() {
  try {
    const s = await api('GET', '/api/settings');
    document.getElementById('settings-provider').value = s.provider || 'openai';
    document.getElementById('settings-model').value = s.model || '';
    document.getElementById('settings-apikey').value = '';
    document.getElementById('settings-key-status').textContent = s.hasKey ? '✓ API key saved' : 'No API key saved yet';
    document.getElementById('modal-settings').classList.remove('hidden');
    setTimeout(() => document.getElementById('settings-apikey').focus(), 50);
  } catch (err) { showToast(err.message, true); }
}

async function saveSettings() {
  const provider = document.getElementById('settings-provider').value;
  const model = document.getElementById('settings-model').value.trim();
  const apiKey = document.getElementById('settings-apikey').value.trim();
  try {
    await api('POST', '/api/settings', { provider, model, apiKey: apiKey || undefined });
    document.getElementById('modal-settings').classList.add('hidden');
    showToast('Settings saved');
  } catch (err) { showToast(err.message, true); }
}

async function checkSettings() {
  try {
    const s = await api('GET', '/api/settings');
    if (!s.hasKey) setTimeout(() => showToast('Add your API key in Settings to enable AI replies'), 1000);
  } catch {}
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function setupEventListeners() {
  document.getElementById('search-input').addEventListener('input', renderChatList);

  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('message-input').addEventListener('input', function() { autoResize(this); });

  document.getElementById('btn-new-chat').addEventListener('click', openNewChatPanel);
  document.getElementById('btn-close-new-chat').addEventListener('click', closeNewChatPanel);
  document.getElementById('panel-new-chat').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeNewChatPanel();
  });
  document.getElementById('directory-search').addEventListener('input', e => {
    renderDirectory(e.target.value);
  });

  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);
  document.getElementById('btn-settings-cancel').addEventListener('click', () => {
    document.getElementById('modal-settings').classList.add('hidden');
  });
  document.getElementById('modal-settings').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  document.getElementById('btn-back').addEventListener('click', () => {
    document.getElementById('main').classList.remove('mobile-visible');
    activeChatId = null;
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeNewChatPanel();
      document.getElementById('modal-settings').classList.add('hidden');
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

function ticksSVG(status) {
  if (status === 'sent') return singleTick('#8696a0');
  if (status === 'delivered') return doubleTick('#8696a0');
  if (status === 'read') return doubleTick('#53bdeb');
  return '';
}

function singleTick(color) {
  return `<svg class="tick-svg" viewBox="0 0 16 11" fill="${color}"><path d="M11.071.643a.75.75 0 0 1 .043 1.06L5.8 7.976a.75.75 0 0 1-1.07.036L2.22 5.565a.75.75 0 0 1 1.06-1.06l2.003 2.003 4.73-5.822a.75.75 0 0 1 1.058-.043z"/></svg>`;
}

function doubleTick(color) {
  return `<svg class="tick-svg" viewBox="0 0 18 11" fill="${color}"><path d="M17.394.643a.75.75 0 0 1 .043 1.06l-5.316 6.273a.75.75 0 0 1-1.07.036L8.545 5.606a.75.75 0 0 1 1.06-1.06l1.998 1.997 4.73-5.857a.75.75 0 0 1 1.061-.043zM11.4.68a.75.75 0 0 1 .042 1.059L6.126 8.012a.75.75 0 0 1-1.07.036L2.55 5.606a.75.75 0 0 1 1.06-1.06l1.999 1.997 4.73-5.82A.75.75 0 0 1 11.4.68z"/></svg>`;
}

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
