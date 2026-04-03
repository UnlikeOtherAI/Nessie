#!/usr/bin/env bash
# http-examples.sh — HTTP API examples for OpenClaw Gateway
#
# Usage:
#   export GATEWAY_URL="http://localhost:18789"
#   export GATEWAY_TOKEN="your-token"
#   ./http-examples.sh
#
# Or inline:
#   GATEWAY_URL=http://localhost:18789 GATEWAY_TOKEN=xxx ./http-examples.sh

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
TOKEN="${GATEWAY_TOKEN:-${OPENCLAW_AUTH_TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Set GATEWAY_TOKEN env var." >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"
CONTENT_JSON="Content-Type: application/json"
GW="$GATEWAY_URL"

# ─── Helper ────────────────────────────────────────────────────────────────────
req() {
  echo ""
  echo "==> $1"
  echo "    $2 $GW$3"
  shift 3
  curl -s -X "$1" "$GW$2" \
    -H "$AUTH_HEADER" \
    -H "$CONTENT_JSON" \
    "$@" | jq --indent 2 '.' 2>/dev/null || curl -s -X "$1" "$GW$2" \
    -H "$AUTH_HEADER" \
    -H "$CONTENT_JSON" \
    "$@"
}

# ─── 1. Health check ───────────────────────────────────────────────────────────
echo ""
echo "=== OpenClaw Gateway HTTP API Examples ==="
req "Health check" GET "/health"

# ─── 2. OpenAI-compatible Chat Completions ─────────────────────────────────────
req "Chat Completions (non-streaming)" POST "/v1/chat/completions" \
  -d '{
    "model": "openclaw:main",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'

req "Chat Completions (streaming)" POST "/v1/chat/completions" \
  -N \
  -d '{
    "model": "openclaw:main",
    "messages": [{"role": "user", "content": "Count to 3."}],
    "stream": true
  }'

# ─── 3. OpenResponses-compatible ───────────────────────────────────────────────
req "OpenResponses (streaming)" POST "/v1/responses" \
  -N \
  -d '{
    "model": "openclaw:main",
    "input": [{"role": "user", "content": "What is 2+2?"}],
    "stream": true
  }'

# ─── 4. Session history (paginated) ────────────────────────────────────────────
# First, get a list of sessions to find a valid session key
SESSION_KEY="agent:main:tui:local"  # default local session key — may not exist

req "List sessions" GET "/api/sessions?limit=5"

req "Session history (first page)" GET "/sessions/${SESSION_KEY}/history?limit=10"

# With cursor (replace cursor value from previous response)
# req "Session history (next page)" GET "/sessions/${SESSION_KEY}/history?limit=10&cursor=\"eyJsYXN0IjoxfQ==\""

# SSE follow mode (real-time transcript updates)
echo ""
echo "==> Session history with SSE follow (Ctrl+C to stop)"
curl -s -X GET "$GW/sessions/${SESSION_KEY}/history?follow=1" \
  -H "$AUTH_HEADER" \
  -N

# ─── 5. Tools invoke ────────────────────────────────────────────────────────────
req "Invoke 'message' tool" POST "/tools/invoke" \
  -d '{
    "name": "message",
    "params": {
      "action": "send",
      "target": "12345",
      "message": "Hello from the HTTP API"
    }
  }'

# ─── 6. Hooks ───────────────────────────────────────────────────────────────────
HOOK_TOKEN="${OPENCLAW_HOOK_TOKEN:-hook-secret}"

req "Wake hook" POST "/hooks/wake" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -d '{}'

req "Agent hook (new session)" POST "/hooks/agent" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -d '{
    "message": "Hello from the webhook. What time is it?"
  }'

req "Agent hook (specific session)" POST "/hooks/agent" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -d '{
    "message": "Follow up on our last conversation.",
    "sessionKey": "agent:main:hook:continuation"
  }'

echo ""
echo "=== Done ==="
