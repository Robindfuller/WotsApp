const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');
const ACTIVE_CHATS_FILE = path.join(DATA_DIR, 'active-chats.json');

// Ensure data dirs exist
[DATA_DIR, CHATS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE clients ────────────────────────────────────────────────────────────

const sseClients = new Set();

function pushEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── File helpers ────────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getChatFile(chatId) {
  return path.join(CHATS_DIR, `${chatId}.json`);
}

function readChat(chatId) {
  return readJSON(getChatFile(chatId), { messages: [] });
}

function writeChat(chatId, data) {
  writeJSON(getChatFile(chatId), data);
}

function appendMessage(chatId, msg) {
  const chat = readChat(chatId);
  chat.messages.push(msg);
  writeChat(chatId, chat);
  return msg;
}

// ─── AI helpers ──────────────────────────────────────────────────────────────

async function getAIReply(systemPrompt, history) {
  const settings = readJSON(SETTINGS_FILE, {});
  const provider = settings.provider || process.env.AI_PROVIDER || 'openai';
  const apiKey = settings.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  const messages = history.map(m => ({
    role: m.fromUser ? 'user' : 'assistant',
    content: m.text
  }));

  if (!apiKey) throw new Error('No API key configured. Go to Settings to add one.');

  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    const model = settings.model || 'claude-haiku-4-5-20251001';
    const resp = await client.messages.create({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages
    });
    return resp.content[0].text.trim();
  } else {
    const OpenAI = require('openai');
    const client = new OpenAI.default({ apiKey });
    const model = settings.model || 'gpt-4o-mini';
    const resp = await client.chat.completions.create({
      model,
      max_tokens: 512,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });
    return resp.choices[0].message.content.trim();
  }
}

function typingDelay(text) {
  // 40ms per character, min 800ms, max 5000ms
  return Math.min(5000, Math.max(800, text.length * 40));
}

// ─── Contacts ────────────────────────────────────────────────────────────────

app.get('/api/contacts', (req, res) => {
  res.json(readJSON(CONTACTS_FILE, []));
});

app.post('/api/contacts', (req, res) => {
  const contacts = readJSON(CONTACTS_FILE, []);
  const contact = {
    id: uuidv4(),
    name: req.body.name,
    username: req.body.username ? req.body.username.replace(/^@/, '').toLowerCase() : '',
    personality: req.body.personality,
    avatar: req.body.avatar || null,
    color: req.body.color || randomColor(),
    createdAt: Date.now()
  };
  contacts.push(contact);
  writeJSON(CONTACTS_FILE, contacts);
  res.json(contact);
});

app.put('/api/contacts/:id', (req, res) => {
  const contacts = readJSON(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  contacts[idx] = { ...contacts[idx], ...req.body, id: contacts[idx].id };
  writeJSON(CONTACTS_FILE, contacts);
  res.json(contacts[idx]);
});

app.delete('/api/contacts/:id', (req, res) => {
  let contacts = readJSON(CONTACTS_FILE, []);
  contacts = contacts.filter(c => c.id !== req.params.id);
  writeJSON(CONTACTS_FILE, contacts);
  res.json({ ok: true });
});

// ─── 1-to-1 chats ────────────────────────────────────────────────────────────

app.get('/api/chats/:contactId', (req, res) => {
  res.json(readChat(req.params.contactId));
});

app.post('/api/chats/:contactId/send', async (req, res) => {
  const { contactId } = req.params;
  const contacts = readJSON(CONTACTS_FILE, []);
  const contact = contacts.find(c => c.id === contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const userMsg = {
    id: uuidv4(),
    text: req.body.text,
    fromUser: true,
    timestamp: Date.now(),
    status: 'sent'
  };

  appendMessage(contactId, userMsg);
  activateChat('contact', contactId);
  res.json(userMsg);

  // Show typing indicator
  pushEvent('typing', { chatId: contactId, contactId, isGroup: false });

  // Deliver tick after short delay
  setTimeout(() => {
    userMsg.status = 'delivered';
    pushEvent('messageStatus', { chatId: contactId, messageId: userMsg.id, status: 'delivered' });
  }, 600);

  // Generate AI reply
  try {
    const chat = readChat(contactId);
    const systemPrompt = buildSystemPrompt(contact);
    const replyText = await getAIReply(systemPrompt, chat.messages);
    const delay = typingDelay(replyText);

    setTimeout(() => {
      const replyMsg = {
        id: uuidv4(),
        text: replyText,
        fromUser: false,
        contactId,
        timestamp: Date.now(),
        status: 'read'
      };
      appendMessage(contactId, replyMsg);
      // Mark user msg as read
      markRead(contactId, userMsg.id);
      pushEvent('message', { chatId: contactId, message: replyMsg, isGroup: false });
      pushEvent('typing', { chatId: contactId, contactId, isGroup: false, stop: true });
    }, delay);
  } catch (err) {
    pushEvent('typing', { chatId: contactId, contactId, isGroup: false, stop: true });
    pushEvent('error', { chatId: contactId, error: err.message });
  }
});

function markRead(chatId, messageId) {
  const chat = readChat(chatId);
  const msg = chat.messages.find(m => m.id === messageId);
  if (msg) {
    msg.status = 'read';
    writeChat(chatId, chat);
    pushEvent('messageStatus', { chatId, messageId, status: 'read' });
  }
}

// ─── Groups ──────────────────────────────────────────────────────────────────

app.get('/api/groups', (req, res) => {
  res.json(readJSON(GROUPS_FILE, []));
});

app.post('/api/groups', (req, res) => {
  const groups = readJSON(GROUPS_FILE, []);
  const group = {
    id: uuidv4(),
    name: req.body.name,
    members: req.body.members || [],   // array of contact IDs
    description: req.body.description || '',
    createdAt: Date.now()
  };
  groups.push(group);
  writeJSON(GROUPS_FILE, groups);
  res.json(group);
});

app.put('/api/groups/:id', (req, res) => {
  const groups = readJSON(GROUPS_FILE, []);
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  groups[idx] = { ...groups[idx], ...req.body, id: groups[idx].id };
  writeJSON(GROUPS_FILE, groups);
  res.json(groups[idx]);
});

app.delete('/api/groups/:id', (req, res) => {
  let groups = readJSON(GROUPS_FILE, []);
  groups = groups.filter(g => g.id !== req.params.id);
  writeJSON(GROUPS_FILE, groups);
  res.json({ ok: true });
});

app.post('/api/groups/:groupId/send', async (req, res) => {
  const { groupId } = req.params;
  const groups = readJSON(GROUPS_FILE, []);
  const group = groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const contacts = readJSON(CONTACTS_FILE, []);
  const members = group.members.map(id => contacts.find(c => c.id === id)).filter(Boolean);

  const userMsg = {
    id: uuidv4(),
    text: req.body.text,
    fromUser: true,
    senderId: 'user',
    senderName: 'You',
    timestamp: Date.now(),
    status: 'sent'
  };

  appendMessage(groupId, userMsg);
  activateChat('group', groupId);
  res.json(userMsg);

  // Decide which members reply (1–all, weighted random)
  const repliers = pickGroupRepliers(members, req.body.text);

  let cumDelay = 600;
  for (const member of repliers) {
    const memberDelay = cumDelay;
    cumDelay += typingDelay('x'.repeat(60)) + 400; // stagger replies

    setTimeout(async () => {
      pushEvent('typing', { chatId: groupId, contactId: member.id, isGroup: true });
      try {
        const chat = readChat(groupId);
        const systemPrompt = buildGroupSystemPrompt(member, group, members);
        const replyText = await getAIReply(systemPrompt, chat.messages.map(m => ({
          ...m,
          fromUser: m.fromUser || m.senderId === 'user',
          // include sender context in text for group chats
          text: m.fromUser || m.senderId === 'user' ? m.text : `[${m.senderName}]: ${m.text}`
        })));

        const innerDelay = typingDelay(replyText);
        setTimeout(() => {
          const replyMsg = {
            id: uuidv4(),
            text: replyText,
            fromUser: false,
            senderId: member.id,
            senderName: member.name,
            senderColor: member.color,
            timestamp: Date.now(),
            status: 'delivered'
          };
          appendMessage(groupId, replyMsg);
          pushEvent('message', { chatId: groupId, message: replyMsg, isGroup: true });
          pushEvent('typing', { chatId: groupId, contactId: member.id, isGroup: true, stop: true });
        }, innerDelay);
      } catch (err) {
        pushEvent('typing', { chatId: groupId, contactId: member.id, isGroup: true, stop: true });
      }
    }, memberDelay);
  }

  // Occasionally let members chat among themselves after user message
  if (Math.random() < 0.35 && members.length >= 2) {
    scheduleInterMemberChat(groupId, members, cumDelay + 2000);
  }
});

function scheduleInterMemberChat(groupId, members, baseDelay) {
  const contacts = readJSON(CONTACTS_FILE, []);
  // pick two different members to have a quick exchange
  const shuffled = [...members].sort(() => Math.random() - 0.5);
  const [a, b] = shuffled;
  if (!a || !b || a.id === b.id) return;

  setTimeout(async () => {
    pushEvent('typing', { chatId: groupId, contactId: a.id, isGroup: true });
    try {
      const chat = readChat(groupId);
      const history = chat.messages.slice(-10).map(m => ({
        fromUser: m.fromUser || m.senderId === 'user',
        text: m.fromUser || m.senderId === 'user' ? m.text : `[${m.senderName}]: ${m.text}`
      }));
      const systemPrompt = buildGroupSystemPrompt(a, { name: 'group' }, members) +
        `\n\nYou are now initiating a side conversation with ${b.name}. Keep it short and natural.`;
      const replyText = await getAIReply(systemPrompt, history);
      const delay = typingDelay(replyText);

      setTimeout(() => {
        const msg = {
          id: uuidv4(),
          text: replyText,
          fromUser: false,
          senderId: a.id,
          senderName: a.name,
          senderColor: a.color,
          timestamp: Date.now(),
          status: 'delivered'
        };
        appendMessage(groupId, msg);
        pushEvent('message', { chatId: groupId, message: msg, isGroup: true });
        pushEvent('typing', { chatId: groupId, contactId: a.id, isGroup: true, stop: true });
      }, delay);
    } catch {}
  }, baseDelay);
}

function pickGroupRepliers(members, text) {
  if (members.length === 0) return [];
  // Always at least 1, up to all members, with some randomness
  const count = members.length === 1 ? 1 : Math.ceil(Math.random() * Math.min(members.length, 3));
  return [...members].sort(() => Math.random() - 0.5).slice(0, count);
}

// ─── Account ─────────────────────────────────────────────────────────────────

app.get('/api/account', (req, res) => {
  const account = readJSON(ACCOUNT_FILE, null);
  if (!account) return res.status(404).json({ error: 'No account' });
  res.json(account);
});

app.post('/api/account', (req, res) => {
  const { displayName, username } = req.body;
  if (!displayName || !username) return res.status(400).json({ error: 'displayName and username required' });
  const account = { displayName: displayName.trim(), username: username.trim().toLowerCase(), createdAt: Date.now() };
  writeJSON(ACCOUNT_FILE, account);
  res.json(account);
});

// ─── Active chats ─────────────────────────────────────────────────────────────

function readActiveChats() {
  return readJSON(ACTIVE_CHATS_FILE, { contacts: [], groups: [] });
}

function activateChat(type, id) {
  const ac = readActiveChats();
  const key = type === 'group' ? 'groups' : 'contacts';
  if (!ac[key].includes(id)) {
    ac[key].push(id);
    writeJSON(ACTIVE_CHATS_FILE, ac);
  }
}

app.get('/api/active-chats', (req, res) => {
  res.json(readActiveChats());
});

// ─── Settings ────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  // Never send API key to client
  res.json({ provider: s.provider || 'openai', model: s.model || '', hasKey: !!s.apiKey });
});

app.post('/api/settings', (req, res) => {
  const existing = readJSON(SETTINGS_FILE, {});
  const updated = { ...existing };
  if (req.body.provider) updated.provider = req.body.provider;
  if (req.body.model !== undefined) updated.model = req.body.model;
  if (req.body.apiKey) updated.apiKey = req.body.apiKey;
  writeJSON(SETTINGS_FILE, updated);
  res.json({ ok: true, provider: updated.provider, model: updated.model, hasKey: !!updated.apiKey });
});

// ─── Offline messages ────────────────────────────────────────────────────────

async function generateOfflineMessages() {
  const allContacts = readJSON(CONTACTS_FILE, []);
  if (!allContacts.length) return;

  // Only message contacts the user has already chatted with
  const activeIds = readActiveChats().contacts;
  const contacts = allContacts.filter(c => activeIds.includes(c.id));
  if (!contacts.length) return;

  // Pick 1-2 random contacts
  const count = Math.random() < 0.5 ? 1 : 2;
  const picked = [...contacts].sort(() => Math.random() - 0.5).slice(0, count);

  for (const contact of picked) {
    const chatFile = getChatFile(contact.id);
    const chat = readJSON(chatFile, { messages: [] });
    if (!chat.messages.length) continue; // Only send if there's prior history

    const lastMsg = chat.messages[chat.messages.length - 1];
    const timeSince = Date.now() - lastMsg.timestamp;
    if (timeSince < 60 * 1000) continue; // Don't spam if they just spoke

    try {
      const systemPrompt = buildSystemPrompt(contact) +
        `\n\nThe user has been away for a while. Send them a short, casual message as if you just thought of them or something came up. Keep it to 1-2 sentences, no need to explain the absence gap.`;

      const replyText = await getAIReply(systemPrompt, chat.messages.slice(-6));
      const msg = {
        id: uuidv4(),
        text: replyText,
        fromUser: false,
        contactId: contact.id,
        timestamp: Date.now() - Math.floor(Math.random() * 15 * 60 * 1000), // 0-15 min ago
        status: 'delivered',
        offline: true
      };
      appendMessage(contact.id, msg);
      console.log(`[offline] ${contact.name}: ${replyText}`);
    } catch (err) {
      // Silently skip if no API key yet
    }
  }
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildContactRoster() {
  const allContacts = readJSON(CONTACTS_FILE, []);
  const account = readJSON(ACCOUNT_FILE, null);

  const lines = allContacts.map(c => {
    const handle = c.username ? `@${c.username}` : c.name;
    return `- ${handle} (${c.name}): ${c.personality}`;
  });

  const userLine = account
    ? `The person you are messaging is ${account.displayName}${account.username ? ` (@${account.username})` : ''}.`
    : '';

  return `People in this messaging app:\n${lines.join('\n')}\n\n${userLine}`.trim();
}

function buildSystemPrompt(contact) {
  const handle = contact.username ? `@${contact.username} (${contact.name})` : contact.name;
  const roster = buildContactRoster();
  return `You are ${handle}, a person with the following personality:\n${contact.personality}\n\n${roster}\n\nWhen personality descriptions reference @usernames, those are real people in this contact list — use that context naturally. You are chatting via a messaging app. Keep replies conversational, natural, and in character. Don't be overly formal. Keep most replies fairly short (1-4 sentences) unless the conversation calls for more. Never break character or acknowledge you are an AI.`;
}

function buildGroupSystemPrompt(contact, group, allMembers) {
  const handle = contact.username ? `@${contact.username} (${contact.name})` : contact.name;
  const others = allMembers
    .filter(m => m.id !== contact.id)
    .map(m => m.username ? `@${m.username} (${m.name})` : m.name)
    .join(', ');
  const roster = buildContactRoster();
  return `You are ${handle}, a person with the following personality:\n${contact.personality}\n\n${roster}\n\nYou are in a group chat called "${group.name}" with ${others} and the user. Keep replies conversational and natural. In group chats, sometimes reply to specific people (use their name or @handle), sometimes address the group. Keep it short and realistic. Never acknowledge you are an AI.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomColor() {
  const colors = ['#e74c3c','#e67e22','#f39c12','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ─── Editor page ─────────────────────────────────────────────────────────────

app.get('/manage', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'manage.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WotsApp running at http://localhost:${PORT}`);
  // Generate offline messages a few seconds after startup
  setTimeout(generateOfflineMessages, 4000);
});
