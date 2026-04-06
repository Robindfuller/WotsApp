const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR        = path.join(__dirname, 'data');
const ACCOUNTS_DIR    = path.join(DATA_DIR, 'accounts');
const ACTIVE_DIR      = path.join(DATA_DIR, 'active-chats');
const CHATS_DIR       = path.join(DATA_DIR, 'chats');
const CONTACTS_FILE   = path.join(DATA_DIR, 'contacts.json');   // bots
const GROUPS_FILE     = path.join(DATA_DIR, 'groups.json');
const SETTINGS_FILE   = path.join(DATA_DIR, 'settings.json');

[DATA_DIR, ACCOUNTS_DIR, ACTIVE_DIR, CHATS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── File helpers ─────────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function readAccount(username) {
  return readJSON(path.join(ACCOUNTS_DIR, `${username}.json`), null);
}
function writeAccount(username, data) {
  writeJSON(path.join(ACCOUNTS_DIR, `${username}.json`), data);
}
function allAccounts() {
  return fs.readdirSync(ACCOUNTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJSON(path.join(ACCOUNTS_DIR, f), null))
    .filter(Boolean);
}

function readActiveChats(username) {
  return readJSON(path.join(ACTIVE_DIR, `${username}.json`), { contacts: [], groups: [], dms: [] });
}
function writeActiveChats(username, data) {
  writeJSON(path.join(ACTIVE_DIR, `${username}.json`), data);
}
function activateChat(username, type, chatId) {
  const ac = readActiveChats(username);
  const key = type === 'group' ? 'groups' : type === 'dm' ? 'dms' : 'contacts';
  if (!ac[key]) ac[key] = [];
  if (!ac[key].includes(chatId)) {
    ac[key].push(chatId);
    writeActiveChats(username, ac);
  }
}

// Chat file resolution
function resolveChatFile(chatId, username) {
  if (chatId.startsWith('dm--')) return path.join(CHATS_DIR, `${chatId}.json`);
  const groups = readJSON(GROUPS_FILE, []);
  if (groups.find(g => g.id === chatId)) return path.join(CHATS_DIR, `${chatId}.json`);
  return path.join(CHATS_DIR, `${username}--${chatId}.json`);
}
function makeDmChatId(a, b) { return 'dm--' + [a, b].sort().join('--'); }

function readChat(chatId, username) {
  return readJSON(resolveChatFile(chatId, username), { messages: [] });
}
function appendMessage(chatId, username, msg) {
  const chat = readChat(chatId, username);
  chat.messages.push(msg);
  writeJSON(resolveChatFile(chatId, username), chat);
  return msg;
}
function getChatType(chatId) {
  if (chatId.startsWith('dm--')) return 'dm';
  const groups = readJSON(GROUPS_FILE, []);
  if (groups.find(g => g.id === chatId)) return 'group';
  return 'bot';
}

// ─── Migration ────────────────────────────────────────────────────────────────

function runMigration() {
  const legacyAccount = readJSON(path.join(DATA_DIR, 'account.json'), null);
  if (!legacyAccount?.username) return;

  const username = legacyAccount.username;
  const accountDest = path.join(ACCOUNTS_DIR, `${username}.json`);
  if (!fs.existsSync(accountDest)) {
    writeJSON(accountDest, { ...legacyAccount, color: legacyAccount.color || randomColor() });
    console.log(`[migrate] account → accounts/${username}.json`);
  }

  const legacyAC = readJSON(path.join(DATA_DIR, 'active-chats.json'), null);
  const activeDest = path.join(ACTIVE_DIR, `${username}.json`);
  if (legacyAC && !fs.existsSync(activeDest)) {
    writeJSON(activeDest, { contacts: legacyAC.contacts || [], groups: legacyAC.groups || [], dms: [] });
    console.log(`[migrate] active-chats → active-chats/${username}.json`);
  }

  // Rename bare bot chat files → {username}--{chatId}.json
  const groups = readJSON(GROUPS_FILE, []);
  const groupIds = new Set(groups.map(g => g.id));
  try {
    for (const file of fs.readdirSync(CHATS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const chatId = file.slice(0, -5);
      if (chatId.startsWith('dm--') || chatId.includes('--')) continue;
      if (groupIds.has(chatId)) continue;
      const dst = path.join(CHATS_DIR, `${username}--${chatId}.json`);
      if (!fs.existsSync(dst)) {
        fs.renameSync(path.join(CHATS_DIR, file), dst);
        console.log(`[migrate] chats/${file} → ${username}--${chatId}.json`);
      }
    }
  } catch {}
}

runMigration();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getUser(req) {
  const username = req.cookies?.wotsapp_user;
  if (!username) return null;
  const acc = readAccount(username);
  return acc || null;
}
function requireUser(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.currentUser = user;
  next();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Map();  // username → Set<res>

function addClient(username, res) {
  if (!sseClients.has(username)) sseClients.set(username, new Set());
  sseClients.get(username).add(res);
}
function removeClient(username, res) {
  sseClients.get(username)?.delete(res);
  if (sseClients.get(username)?.size === 0) sseClients.delete(username);
}
function pushTo(username, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of (sseClients.get(username) || [])) {
    try { res.write(payload); } catch {}
  }
}
function pushToMany(usernames, event, data) {
  usernames.forEach(u => pushTo(u, event, data));
}
function getOnline() { return [...sseClients.keys()]; }
function broadcastPresence() {
  const online = getOnline();
  for (const [username] of sseClients) {
    pushTo(username, 'presence', { online });
  }
}

app.get('/api/events', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  addClient(user.username, res);
  broadcastPresence();
  req.on('close', () => {
    removeClient(user.username, res);
    broadcastPresence();
  });
});

// ─── Account ──────────────────────────────────────────────────────────────────

app.get('/api/account', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'No account' });
  res.json(user);
});

app.post('/api/account', (req, res) => {
  const { displayName, username } = req.body;
  if (!displayName || !username) return res.status(400).json({ error: 'displayName and username required' });
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean.length < 2) return res.status(400).json({ error: 'Username too short or invalid' });
  if (readAccount(clean)) return res.status(409).json({ error: 'Username already taken' });

  const account = { displayName: displayName.trim(), username: clean, color: randomColor(), createdAt: Date.now() };
  writeAccount(clean, account);
  writeActiveChats(clean, { contacts: [], groups: [], dms: [] });

  res.cookie('wotsapp_user', clean, { httpOnly: true, maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json(account);
});

// ─── Users & presence ────────────────────────────────────────────────────────

app.get('/api/users', requireUser, (req, res) => {
  const all = allAccounts().filter(a => a.username !== req.currentUser.username);
  res.json(all);
});

app.get('/api/presence', requireUser, (req, res) => {
  res.json({ online: getOnline() });
});

// ─── Directory ────────────────────────────────────────────────────────────────

app.get('/api/directory', requireUser, (req, res) => {
  const bots = readJSON(CONTACTS_FILE, []);
  const users = allAccounts().filter(a => a.username !== req.currentUser.username);
  const groups = readJSON(GROUPS_FILE, []);
  res.json({ bots, users, groups });
});

// ─── Active chats ─────────────────────────────────────────────────────────────

app.get('/api/active-chats', requireUser, (req, res) => {
  res.json(readActiveChats(req.currentUser.username));
});

// ─── Bot contacts (admin) ─────────────────────────────────────────────────────

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
  const contacts = readJSON(CONTACTS_FILE, []).filter(c => c.id !== req.params.id);
  writeJSON(CONTACTS_FILE, contacts);
  res.json({ ok: true });
});

// ─── Chat history ─────────────────────────────────────────────────────────────

app.get('/api/chats/:chatId', requireUser, (req, res) => {
  res.json(readChat(req.params.chatId, req.currentUser.username));
});

// ─── Unified send ─────────────────────────────────────────────────────────────

app.post('/api/chats/:chatId/send', requireUser, async (req, res) => {
  const chatId = req.params.chatId;
  const sender = req.currentUser;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });

  const type = getChatType(chatId);

  if (type === 'dm') {
    await handleDmSend(chatId, sender, text, res);
  } else if (type === 'group') {
    await handleGroupSend(chatId, sender, text, res);
  } else {
    await handleBotSend(chatId, sender, text, res);
  }
});

// ── DM send ────────────────────────────────────────────────────────────────────

async function handleDmSend(chatId, sender, text, res) {
  // Parse the other user from dm--{a}--{b}
  const parts = chatId.slice(4).split('--');  // strip 'dm--'
  const recipientUsername = parts.find(u => u !== sender.username);
  if (!recipientUsername) return res.status(400).json({ error: 'Invalid DM chatId' });

  const msg = {
    id: uuidv4(),
    text,
    senderId: sender.username,
    senderName: sender.displayName,
    fromUser: true,
    timestamp: Date.now(),
    status: 'sent'
  };

  appendMessage(chatId, sender.username, msg);

  // Activate for both participants
  activateChat(sender.username, 'dm', chatId);
  activateChat(recipientUsername, 'dm', chatId);

  res.json(msg);

  // Deliver to recipient via SSE
  pushTo(recipientUsername, 'message', { chatId, message: msg, isDM: true });

  // Update status
  setTimeout(() => {
    const isOnline = sseClients.has(recipientUsername);
    const newStatus = isOnline ? 'read' : 'delivered';
    msg.status = newStatus;
    pushTo(sender.username, 'messageStatus', { chatId, messageId: msg.id, status: newStatus });
  }, 600);
}

// ── Bot send ───────────────────────────────────────────────────────────────────

async function handleBotSend(chatId, sender, text, res) {
  const bots = readJSON(CONTACTS_FILE, []);
  const bot = bots.find(c => c.id === chatId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  const userMsg = {
    id: uuidv4(),
    text,
    senderId: sender.username,
    fromUser: true,
    timestamp: Date.now(),
    status: 'sent'
  };

  appendMessage(chatId, sender.username, userMsg);
  activateChat(sender.username, 'contact', chatId);
  res.json(userMsg);

  pushTo(sender.username, 'typing', { chatId, contactId: chatId, isGroup: false });

  setTimeout(() => {
    pushTo(sender.username, 'messageStatus', { chatId, messageId: userMsg.id, status: 'delivered' });
  }, 600);

  try {
    const chat = readChat(chatId, sender.username);
    const systemPrompt = buildSystemPrompt(bot, sender);
    const replyText = await getAIReply(systemPrompt, chat.messages);
    const delay = typingDelay(replyText);

    setTimeout(() => {
      const replyMsg = {
        id: uuidv4(),
        text: replyText,
        senderId: chatId,
        fromUser: false,
        timestamp: Date.now(),
        status: 'read'
      };
      appendMessage(chatId, sender.username, replyMsg);
      // Mark user message as read
      markBotChatRead(chatId, sender.username, userMsg.id);
      pushTo(sender.username, 'message', { chatId, message: replyMsg, isGroup: false });
      pushTo(sender.username, 'typing', { chatId, contactId: chatId, isGroup: false, stop: true });
    }, delay);
  } catch (err) {
    pushTo(sender.username, 'typing', { chatId, contactId: chatId, isGroup: false, stop: true });
    pushTo(sender.username, 'error', { chatId, error: err.message });
  }
}

function markBotChatRead(chatId, username, messageId) {
  const chat = readChat(chatId, username);
  const msg = chat.messages.find(m => m.id === messageId);
  if (msg) {
    msg.status = 'read';
    writeJSON(resolveChatFile(chatId, username), chat);
    pushTo(username, 'messageStatus', { chatId, messageId, status: 'read' });
  }
}

// ── Group send ─────────────────────────────────────────────────────────────────

async function handleGroupSend(chatId, sender, text, res) {
  const groups = readJSON(GROUPS_FILE, []);
  const group = groups.find(g => g.id === chatId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const userMsg = {
    id: uuidv4(),
    text,
    senderId: sender.username,
    senderName: sender.displayName,
    fromUser: false,  // false so other users don't see it as "their own" outgoing
    isUserMessage: true,
    timestamp: Date.now(),
    status: 'sent'
  };

  appendMessage(chatId, sender.username, userMsg);
  activateChat(sender.username, 'group', chatId);
  res.json(userMsg);

  // Resolve members into bots and real users
  const bots = readJSON(CONTACTS_FILE, []);
  const botMembers = group.members
    .filter(m => !m.startsWith('user:'))
    .map(id => bots.find(b => b.id === id))
    .filter(Boolean);

  const realUsernames = group.members
    .filter(m => m.startsWith('user:'))
    .map(m => m.slice(5))
    .filter(u => u !== sender.username);

  // Push to all other real users in this group
  activateGroupForUsers(chatId, realUsernames);
  pushToMany(realUsernames, 'message', { chatId, message: userMsg, isGroup: true });

  // AI replies from bot members
  const repliers = pickGroupRepliers(botMembers, text);
  let cumDelay = 600;

  for (const bot of repliers) {
    const myDelay = cumDelay;
    cumDelay += typingDelay('x'.repeat(60)) + 400;

    setTimeout(async () => {
      const allRecipients = [sender.username, ...realUsernames];
      pushToMany(allRecipients, 'typing', { chatId, contactId: bot.id, isGroup: true });
      try {
        const chat = readChat(chatId, sender.username);
        const allBotMembers = botMembers;
        const systemPrompt = buildGroupSystemPrompt(bot, group, allBotMembers, sender);
        const history = chat.messages.slice(-20).map(m => ({
          fromUser: m.isUserMessage || m.fromUser,
          text: (m.isUserMessage || m.fromUser) ? `[${m.senderName || m.senderId}]: ${m.text}` : `[${getBotName(m.senderId, bots)}]: ${m.text}`
        }));
        const replyText = await getAIReply(systemPrompt, history);
        const innerDelay = typingDelay(replyText);

        setTimeout(() => {
          const replyMsg = {
            id: uuidv4(),
            text: replyText,
            senderId: bot.id,
            senderName: bot.name,
            senderColor: bot.color,
            fromUser: false,
            timestamp: Date.now(),
            status: 'delivered'
          };
          appendMessage(chatId, sender.username, replyMsg);
          pushToMany(allRecipients, 'message', { chatId, message: replyMsg, isGroup: true });
          pushToMany(allRecipients, 'typing', { chatId, contactId: bot.id, isGroup: true, stop: true });
        }, innerDelay);
      } catch {
        pushToMany([sender.username, ...realUsernames], 'typing', { chatId, contactId: bot.id, isGroup: true, stop: true });
      }
    }, myDelay);
  }

  // Occasional inter-bot chat
  if (Math.random() < 0.35 && botMembers.length >= 2) {
    scheduleInterBotChat(chatId, botMembers, [sender.username, ...realUsernames], cumDelay + 2000);
  }
}

function activateGroupForUsers(chatId, usernames) {
  usernames.forEach(u => activateChat(u, 'group', chatId));
}

function getBotName(senderId, bots) {
  return bots.find(b => b.id === senderId)?.name || senderId;
}

function scheduleInterBotChat(chatId, bots, recipients, baseDelay) {
  const [a, b] = [...bots].sort(() => Math.random() - 0.5);
  if (!a || !b || a.id === b.id) return;

  setTimeout(async () => {
    pushToMany(recipients, 'typing', { chatId, contactId: a.id, isGroup: true });
    try {
      const allBots = readJSON(CONTACTS_FILE, []);
      const chat = readChat(chatId, recipients[0]);
      const history = chat.messages.slice(-10).map(m => ({
        fromUser: m.isUserMessage || m.fromUser,
        text: m.isUserMessage || m.fromUser ? m.text : `[${getBotName(m.senderId, allBots)}]: ${m.text}`
      }));
      const sp = buildGroupSystemPrompt(a, { name: 'group' }, bots, null) +
        `\n\nYou are initiating a side comment to ${b.name}. Keep it short and natural.`;
      const replyText = await getAIReply(sp, history);
      const delay = typingDelay(replyText);
      setTimeout(() => {
        const msg = {
          id: uuidv4(),
          text: replyText,
          senderId: a.id,
          senderName: a.name,
          senderColor: a.color,
          fromUser: false,
          timestamp: Date.now(),
          status: 'delivered'
        };
        appendMessage(chatId, recipients[0], msg);
        pushToMany(recipients, 'message', { chatId, message: msg, isGroup: true });
        pushToMany(recipients, 'typing', { chatId, contactId: a.id, isGroup: true, stop: true });
      }, delay);
    } catch {}
  }, baseDelay);
}

function pickGroupRepliers(bots, text) {
  if (!bots.length) return [];
  const count = bots.length === 1 ? 1 : Math.ceil(Math.random() * Math.min(bots.length, 3));
  return [...bots].sort(() => Math.random() - 0.5).slice(0, count);
}

// ─── Groups ───────────────────────────────────────────────────────────────────

app.get('/api/groups', (req, res) => {
  res.json(readJSON(GROUPS_FILE, []));
});

app.post('/api/groups', (req, res) => {
  const groups = readJSON(GROUPS_FILE, []);
  const group = {
    id: uuidv4(),
    name: req.body.name,
    members: req.body.members || [],
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
  const groups = readJSON(GROUPS_FILE, []).filter(g => g.id !== req.params.id);
  writeJSON(GROUPS_FILE, groups);
  res.json({ ok: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
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

// ─── AI helpers ───────────────────────────────────────────────────────────────

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
    const resp = await client.messages.create({ model, max_tokens: 512, system: systemPrompt, messages });
    return resp.content[0].text.trim();
  } else {
    const OpenAI = require('openai');
    const client = new OpenAI.default({ apiKey });
    const model = settings.model || 'gpt-4o-mini';
    const resp = await client.chat.completions.create({
      model, max_tokens: 512,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });
    return resp.choices[0].message.content.trim();
  }
}

function typingDelay(text) {
  return Math.min(5000, Math.max(800, text.length * 40));
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildContactRoster(senderAccount) {
  const bots = readJSON(CONTACTS_FILE, []);
  const users = allAccounts();

  const botLines = bots.map(c => {
    const handle = c.username ? `@${c.username}` : c.name;
    return `- ${handle} (${c.name}) [AI bot]: ${c.personality}`;
  });

  const userLines = users.map(u =>
    `- @${u.username} (${u.displayName}) [real person]`
  );

  const you = senderAccount
    ? `The person messaging you is ${senderAccount.displayName} (@${senderAccount.username}).`
    : '';

  return `People in this app:\n${[...botLines, ...userLines].join('\n')}\n\n${you}`.trim();
}

function buildSystemPrompt(bot, senderAccount) {
  const handle = bot.username ? `@${bot.username} (${bot.name})` : bot.name;
  const roster = buildContactRoster(senderAccount);
  return `You are ${handle}, a person with the following personality:\n${bot.personality}\n\n${roster}\n\nWhen personality descriptions reference @usernames, those are real people — use that context naturally. You are chatting via a messaging app. Keep replies conversational, natural, and in character. Most replies should be short (1-4 sentences). Never break character or acknowledge you are an AI.`;
}

function buildGroupSystemPrompt(bot, group, allBots, senderAccount) {
  const handle = bot.username ? `@${bot.username} (${bot.name})` : bot.name;
  const others = allBots.filter(m => m.id !== bot.id)
    .map(m => m.username ? `@${m.username} (${m.name})` : m.name).join(', ');
  const roster = buildContactRoster(senderAccount);
  return `You are ${handle}, a person with the following personality:\n${bot.personality}\n\n${roster}\n\nYou are in a group chat called "${group.name}" with ${others} and other people. Keep replies short and natural. Sometimes address specific people by name. Never acknowledge you are an AI.`;
}

// ─── Offline messages ─────────────────────────────────────────────────────────

async function generateOfflineMessages() {
  const accounts = allAccounts();
  for (const account of accounts) {
    const ac = readActiveChats(account.username);
    const bots = readJSON(CONTACTS_FILE, []).filter(b => ac.contacts.includes(b.id));
    if (!bots.length) continue;

    const count = Math.random() < 0.5 ? 1 : 2;
    const picked = [...bots].sort(() => Math.random() - 0.5).slice(0, count);

    for (const bot of picked) {
      const chat = readChat(bot.id, account.username);
      if (!chat.messages.length) continue;
      const last = chat.messages[chat.messages.length - 1];
      if (Date.now() - last.timestamp < 60 * 1000) continue;

      try {
        const sp = buildSystemPrompt(bot, account) +
          '\n\nThe user has been away for a while. Send a short casual message — 1-2 sentences.';
        const replyText = await getAIReply(sp, chat.messages.slice(-6));
        const msg = {
          id: uuidv4(),
          text: replyText,
          senderId: bot.id,
          fromUser: false,
          timestamp: Date.now() - Math.floor(Math.random() * 15 * 60 * 1000),
          status: 'delivered',
          offline: true
        };
        appendMessage(bot.id, account.username, msg);
        pushTo(account.username, 'message', { chatId: bot.id, message: msg, isGroup: false });
        console.log(`[offline] @${account.username} ← ${bot.name}: ${replyText}`);
      } catch {}
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomColor() {
  const colors = ['#e74c3c','#e67e22','#f39c12','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ─── Editor page ──────────────────────────────────────────────────────────────

app.get('/manage', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'manage.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WotsApp running at http://localhost:${PORT}`);
  setTimeout(generateOfflineMessages, 4000);
});
