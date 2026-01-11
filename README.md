# Outie

A stateful AI agent running on Cloudflare Workers with persistent memory.

## Features

- **Memory Blocks** - Letta-style in-context memory that the agent can edit
- **Journal** - Archival memory stored in SQLite
- **Scheduling** - DO alarms for reminders and recurring tasks
- **R2 Storage** - Persistent repo storage for coding tasks (coming soon)

## Setup

```bash
pnpm install
```

Create `.dev.vars` with your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Development

```bash
pnpm run dev
```

## Deploy

```bash
# Create R2 bucket first
wrangler r2 bucket create outie-repos

# Set secrets
wrangler secret put ANTHROPIC_API_KEY

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
    └── [Future] Sandbox for coding
```
