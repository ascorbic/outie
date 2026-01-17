# Outie

A stateful AI agent running on Cloudflare Workers. It's the cloud counterpart to [Innie](https://github.com/ascorbic/innie), which runs locally.

## Architecture

Outie follows the "Orchestrator + OpenCode" pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│  Worker (Hono)                                                  │
│  Routes: /telegram webhook, /* web UI proxy                     │
└─────────────────────────────────────────────────────────────────┘
                              │ RPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Orchestrator DO                                                │
│  ├── SQLite: journal, topics, summaries, reminders, state       │
│  ├── Embeddings: bge-small-en-v1.5 (Workers AI)                 │
│  ├── DO Alarms: scheduled reminders                             │
│  └── MCP Server: memory, scheduling, telegram tools             │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sandbox Container                                              │
│  ├── OpenCode (X.ai GLM-4.7).                                   │
│  ├── MCP Bridge (localhost:8787 ↔ DO via WebSocket)             │
│  └── Git, Bun, development tools                                │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight**: The Orchestrator is a "dumb" coordinator. All reasoning happens in OpenCode. The DO just:
1. Builds context from state (conversation, journal, identity files)
2. Wakes the sandbox and sends prompts
3. Handles MCP tool calls (memory, scheduling, telegram)
4. Manages alarms for scheduled reminders

## MCP Bridge

OpenCode needs to call MCP tools that live in the DO (memory, scheduling). But the container can't directly reach the DO - it would have to go through the public URL which is blocked by Cloudflare Access.

Solution: **WebSocket bridge**

1. Container runs an MCP server on `localhost:8787`
2. Orchestrator DO connects to the container via WebSocket (DO-initiated, bypasses Access)
3. OpenCode calls MCP tools → bridge forwards over WS → DO handles → response flows back

```
OpenCode ──HTTP──▶ MCP Bridge (container:8787)
                        │
                        ▼ WebSocket (DO-initiated)
                   Orchestrator DO
                        │
                        ▼
                   SQLite / Workers AI
```

## Memory Model

Letta-style architecture where the agent edits its own memory:

- **Journal** – Append-only log with semantic search. Agent writes observations with `journal_write`, searches with `journal_search`.
- **Topics** – Distilled knowledge about concepts/tools. Small, actively updated files.
- **State files** – Identity, daily focus, user info. Injected into context each turn.
- **Conversation summaries** – Saved when context gets long, used for continuity.

## MCP Tools

| Tool | Description |
|------|-------------|
| `journal_write` | Write an observation to the journal |
| `journal_search` | Semantic search over journal entries |
| `topic_write` / `topic_get` / `topic_list` / `topic_search` | Manage topic files |
| `state_read` / `state_write` | Read/write state files |
| `schedule_reminder` | Create a recurring reminder (cron syntax) |
| `schedule_once` | Create a one-time reminder |
| `cancel_reminder` / `list_reminders` | Manage reminders |
| `send_telegram` | Send a message to Telegram |
| `save_conversation_summary` / `get_recent_summaries` | Manage conversation context |

## Scheduling

Reminders use DO alarms. Each reminder has either a cron expression or a one-time datetime. When an alarm fires, the payload is injected into a chat turn and OpenCode processes it.

## Interfaces

**Telegram Bot** – Primary interface. Webhook at `/telegram`. Allowlisted by user ID.

**Web UI** – Proxies to OpenCode's web interface at `/`. Protected by Cloudflare Access.

## Setup

```bash
pnpm install
```

### Secrets

```bash
wrangler secret put ANTHROPIC_KEY         # For OpenCode
wrangler secret put TELEGRAM_BOT_TOKEN    # From @BotFather
wrangler secret put TELEGRAM_CHAT_ID      # Your Telegram user ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### Deploy

```bash
pnpm run deploy
```

Set up Telegram webhook:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://outie.example.com/telegram&secret_token=<SECRET>"
```

## Project Structure

```
src/
├── worker.ts              # Hono routes, entry point
├── telegram.ts            # Telegram API
├── scheduling.ts          # Cron parsing
└── orchestrator/          # Orchestrator DO
    ├── index.ts           # DO class, invocation logic
    ├── state.ts           # SQLite schema & CRUD
    ├── context.ts         # System prompt, context building
    ├── mcp-server.ts      # MCP tool implementations
    ├── embeddings.ts      # Vector operations
    └── types.ts           # Type definitions

container/
├── mcp-bridge/            # MCP bridge server
│   └── index.ts           # HTTP + WebSocket bridge
└── .opencode/             # OpenCode configuration
    └── config.json        # MCP server config (localhost)

Dockerfile                 # Container image with OpenCode + bridge
```

## Why "Outie"?

It's the external-facing counterpart to [Innie](https://github.com/ascorbic/innie), which runs locally. Same memory model, different runtime.
