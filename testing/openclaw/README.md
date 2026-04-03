# OpenClaw Testing Playground

Runnable infrastructure for experimenting with the OpenClaw Gateway protocol and APIs without a full deployment.

## Contents

| File | Purpose |
|---|---|
| `docker-compose.yml` | Spin up a local OpenClaw Gateway with persistent state |
| `wscat-connect.sh` | Connect to the Gateway as an operator via WebSocket |
| `http-examples.sh` | `curl` commands for every HTTP endpoint |
| `mock-gateway-server.ts` | Minimal mock WS server for contract testing (no real Gateway needed) |

## Quick Start

### Option 1: Real Gateway via Docker

```bash
cd testing/openclaw

# Start the Gateway
docker compose up -d

# Wait for it to be healthy
sleep 5

# Get the auth token
docker compose exec openclaw-gateway cat /root/.openclaw/openclaw.json \
  | grep -A5 '"auth"'

# Connect via WebSocket
chmod +x wscat-connect.sh
OPENCLAW_TOKEN=your-token ./wscat-connect.sh ws://localhost:18789

# Or run HTTP examples
chmod +x http-examples.sh
GATEWAY_URL=http://localhost:18789 GATEWAY_TOKEN=your-token ./http-examples.sh

# Tear down
docker compose down
```

### Option 2: Mock Gateway (no real OpenClaw needed)

```bash
cd testing/openclaw

# Install dependencies
npm install ws
# or: pnpm add ws

# Run the mock server
npx ts-node mock-gateway-server.ts
# or: node --loader ts-node/esm mock-gateway-server.ts

# In another terminal, connect using the mock URL
OPENCLAW_TOKEN=test ./wscat-connect.sh ws://localhost:18790
```

The mock server implements:
- `connect.challenge` → `connect` handshake (with `deviceToken` in `hello-ok`)
- `chat.history`, `chat.send` (streams 3 mock delta events + final), `chat.abort`
- `sessions.list` (with search filter), `sessions.preview`
- `sessions.messages.subscribe` / `sessions.messages.unsubscribe` (with simulated message)
- `sessions.patch`
- `config.apply` / `config.patch`
- `device.pair`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_URL` | `http://localhost:18789` | Gateway HTTP URL |
| `OPENCLAW_TOKEN` | (none) | Gateway auth token |
| `OPENCLAW_HOOK_TOKEN` | `hook-secret` | Hook auth token |
| `OPENCLAW_GW_URL` | `ws://localhost:18789` | Gateway WS URL (for mock testing) |
