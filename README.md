# Outie

A stateful AI agent that runs on Cloudflare Workers. Durable Object + SQLite for memory, Workers AI for chat, Sandbox and OpenCode for code execution.

## Inspiration

- [awesome-agents discord bot](https://github.com/cloudflare/awesome-agents/tree/main/agents/discord-agent) – Similar concept: a Discord bot with Letta-style persistent, self-editing memory blocks.
- [sandbox-sdk OpenCode example](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode) – Shows how to run OpenCode in a container. Outie wraps this with state management (branch tracking, session continuation) and integrates it as a tool.

It adds to these, scheduled reminders via DO Alarms, web search via Brave, and web fetch via the Browser Rendering API.

It is the counterpart to [Innie](https://github.com/ascorbic/innie), which runs locally on my Mac and uses MCP, skills and OpenCode plugins for memory and tool execution.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Worker (Hono)                                                  │
│  Web chat interface. Telegram bot.                              │
└─────────────────────────────────────────────────────────────────┘
                              │ RPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Outie DO (singleton)                                           │
│  ├── SQLite: memory blocks, journal, messages, reminders        │
│  ├── Chat: Gemini 2.5 Flash via AI Gateway                      │
│  ├── Thinking: Claude Opus 4 via AI Gateway (for reflections)   │
│  ├── Embeddings: bge-small-en-v1.5 (Workers AI)                 │
│  ├── DO Alarms: scheduled tasks & reminders                     │
│  └── Tools: memory, journal, scheduling, web search, fetch      │
└─────────────────────────────────────────────────────────────────┘
                              │ RPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  OutieSandbox DO (container)                                    │
│  ├── CF Sandbox container                                       │
│  ├── OpenCode + GLM-4.7 via Z.AI                                │
│  └── GitHub bot                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Memory Model

Letta-style architecture where the agent edits its own memory:

**Memory Blocks** – Small, editable text injected into every system prompt. Three blocks: `persona` (who the agent is), `human` (info about the user), `scratchpad` (working notes). The agent uses `memory_insert` and `memory_replace` tools to edit these.

**Journal** – Append-only log with semantic search. Agent writes observations with `journal_write`, searches with `journal_search`. Embeddings stored alongside entries, search is dot product over normalized vectors.

**Conversation** – Rolling context with summarization. When conversation gets long, older messages are summarized and pruned to stay within context limits.

## Tools

All tools run inside the Outie DO except `run_coding_task`, which delegates to the sandbox.

| Tool | Description |
|------|-------------|
| `memory_insert` | Insert text at a line in a memory block |
| `memory_replace` | Find/replace in a memory block |
| `journal_write` | Write an observation to the journal |
| `journal_search` | Semantic search over journal entries |
| `schedule_reminder` | Create a recurring reminder (cron syntax) |
| `schedule_once` | Create a one-time reminder |
| `cancel_reminder` / `list_reminders` | Manage reminders |
| `web_search` / `news_search` | Brave Search integration |
| `fetch_page` | Fetch a URL as markdown (Browser Rendering API) |
| `send_telegram` | Send a message to Telegram |
| `run_coding_task` | Delegate work to OpenCode in a container |

## Coding Tasks

The `run_coding_task` tool spins up OpenCode in a container sandbox. It:

1. Clones the repo (or fetches if already present)
2. Creates or continues on a feature branch
3. Runs OpenCode with the task prompt
4. Commits and pushes changes

State (branch, session ID) is persisted in SQLite so follow-up tasks continue where the last one left off. A custom commit-gate plugin prevents the session from ending until changes are committed.

Uses `@cloudflare/sandbox` with the Containers product. The container image is defined in `Dockerfile`.

## Vector Search

Journal entries are embedded with `@cf/baai/bge-small-en-v1.5` (384 dimensions). Per the BGE docs:
- Documents are embedded as-is
- Queries get a retrieval instruction prefix: `"Represent this sentence for searching relevant passages: "`
- Vectors are normalized at storage time
- Search is dot product (equivalent to cosine similarity for unit vectors, but faster)

It's brute-force O(n) but plenty fast for < 10k entries. Could swap in Cloudflare Vectorize or an in-DO HNSW index if it grows.

## Scheduling

Reminders use DO alarms. Each reminder has either a cron expression or a one-time datetime. When an alarm fires:

1. Find all reminders within 1 minute of now
2. For each, inject the payload into a chat turn
3. Send the response to Telegram
4. Delete one-time reminders, keep recurring ones
5. Schedule next alarm

## Interfaces

**Web UI** – Simple chat interface at `/`. Good for testing.

**Telegram Bot** – Webhook at `/telegram`. Allowlisted by user ID. Shows typing indicator while processing.

**HTTP API** – `POST /chat`, `GET /memory`, `GET /reminders`, `POST /reset`, `POST /code`

All routes go through the worker, which calls the DO via RPC (not fetch).

## Security

**Cloudflare Access** – The web UI and API endpoints are protected by Cloudflare Access. Configure an Access policy in the dashboard to restrict who can reach the worker.

**Telegram** – Two layers: webhook requests are verified using a secret token (`TELEGRAM_WEBHOOK_SECRET`), and user IDs are checked against an allowlist. Unauthorized users are silently ignored. Bot can only communicate with allowed users.

**URL allowlist** – The `fetch_page` tool can only fetch URLs that came from search results or user messages. Prevents the agent from being tricked into fetching arbitrary URLs and exfiltrating secrets.

**Security headers** – Standard headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.

**GitHub App** – Repo access uses a GitHub App with scoped permissions. The app is installed only on repos the agent should access.

## Setup

```bash
pnpm install
```

### Secrets

```bash
wrangler secret put CF_API_TOKEN          # For Browser Rendering + AI Gateway
wrangler secret put BRAVE_SEARCH_API_KEY  # Web search
wrangler secret put TELEGRAM_BOT_TOKEN    # From @BotFather
wrangler secret put TELEGRAM_CHAT_ID      # Your Telegram user ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put ZAI_API_KEY           # For OpenCode
wrangler secret put GITHUB_APP_ID         # GitHub App for repo access
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

### Deploy

```bash
pnpm run deploy
```

Then set up the Telegram webhook:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://outie.ascorbic.workers.dev/telegram&secret_token=<SECRET>"
```

## Project Structure

```
src/
├── index.ts          # Hono routes
├── outie/            # Main DO
│   ├── index.ts      # DO class, RPC methods, tool handlers
│   ├── config.ts     # Constants
│   ├── logger.ts     # Structured logging
│   ├── state.ts      # SQLite schema & CRUD
│   ├── embeddings.ts # Vector operations
│   ├── chat.ts       # System prompt, AI chat loop
│   ├── summarization.ts
│   └── coding.ts     # Coding task orchestration
├── tools.ts          # Tool definitions (Vercel AI SDK format)
├── sandbox.ts        # OpenCode container integration
├── telegram.ts       # Telegram API
├── web-search.ts     # Brave Search
├── web-fetch.ts      # Browser Rendering → markdown
└── github.ts         # GitHub App JWT auth
```

## Why "Outie"?

It's the external-facing counterpart to [Innie](https://github.com/ascorbic/innie), which runs locally via MCP. Same memory model, different runtime.
