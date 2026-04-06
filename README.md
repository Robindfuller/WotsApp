# WotsApp

A WhatsApp Web clone where every contact is an AI-powered character. Chat with fully personalised AI personalities, create group chats where the AIs talk to each other, and come back to find messages waiting for you.

## Features

- **WhatsApp Web UI** — dark/green theme, typing indicators, blue ticks, timestamps
- **AI contacts** — each contact has a personality; the AI stays in character across conversations
- **Group chats** — multiple AI contacts interact with each other, not just you
- **Offline messages** — contacts message you while you're away
- **Persistent history** — conversations saved to disk and included as context
- **OpenAI & Claude support** — switch providers in Settings
- **Mobile responsive**

## Quick start

```bash
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000)

## Configuration

Go to **Settings** (gear icon) in the app and enter your API key. Supports:

| Provider | Default model |
|---|---|
| OpenAI | `gpt-4o-mini` |
| Anthropic (Claude) | `claude-haiku-4-5-20251001` |

You can override the model in the settings field (e.g. `gpt-4o`, `claude-sonnet-4-6`).

Alternatively, set environment variables before starting:

```bash
OPENAI_API_KEY=sk-...  node server.js
# or
ANTHROPIC_API_KEY=sk-ant-...  AI_PROVIDER=anthropic  node server.js
```

## Adding contacts

Click the **contact icon** (top of sidebar) and give your contact a name and personality description. The personality description is the system prompt — be as detailed or as creative as you like.

Example personalities:
- *"A retired astronaut who casually drops space facts into every conversation and misses zero-gravity more than anything."*
- *"A medieval peasant who somehow got a smartphone and is constantly confused and terrified by modernity."*
- *"An overly competitive personal trainer who turns every conversation into a pep talk."*

## Group chats

Click the **group icon** (top of sidebar), name the group, and select 2+ contacts. The AI members will reply to you and occasionally banter with each other.

## Data storage

All data is stored in the `data/` directory:

```
data/
  contacts.json     — contact definitions
  groups.json       — group definitions
  settings.json     — API key & provider (gitignored)
  chats/            — one JSON file per chat (gitignored)
```

## Project structure

```
WotsApp/
  server.js         — Express backend, AI integration, SSE
  public/
    index.html
    css/style.css
    js/app.js
  data/             — persistent storage
```
