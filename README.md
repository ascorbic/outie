# Outie

A stateful AI agent running on Cloudflare Workers with persistent memory.

## Features

- **Memory Blocks** - Letta-style in-context memory that the agent can edit
- **Journal** - Archival memory stored in SQLite
- **Scheduling** - DO alarms for reminders and recurring tasks
- **Workers AI** - Uses Cloudflare Workers AI for chat
- **R2 Storage** - Persistent repo storage for coding tasks (coming soon)
- **Sandbox** - OpenCode in container for coding (coming soon, uses AI Gateway)

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm run dev
```

## Deploy

```bash
# Create R2 bucket first
wrangler r2 bucket create outie-repos

# If using OpenCode in sandbox, set AI Gateway token
wrangler secret put CF_AIG_TOKEN

# Deploy
pnpm run deploy
```

## API

### Chat

```bash
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### Get Memory

```bash
curl http://localhost:8787/memory
```

### Get Reminders

```bash
curl http://localhost:8787/reminders
```

## Architecture

```
Worker (Hono)
└── Outie DO
    ├── Memory Blocks (SQLite)
    ├── Journal (SQLite)
    ├── Scheduling (DO Alarms)
    ├── Workers AI (chat)
    └── [Future] Sandbox + OpenCode (coding)
        └── Uses AI Gateway with CF_AIG_TOKEN
```

## Stack

- **DO Chat**: Workers AI (llama-3.3-70b)
- **Sandbox Coding**: OpenCode via Cloudflare AI Gateway
- **Storage**: DO SQLite + R2 for repos
