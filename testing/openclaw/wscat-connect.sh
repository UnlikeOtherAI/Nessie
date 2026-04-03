#!/usr/bin/env bash
# wscat-connect.sh — Connect to an OpenClaw Gateway as an operator via wscat
#
# Prerequisites:
#   npm install -g wscat
#
# Usage:
#   ./wscat-connect.sh [ws://host:port] [token]
#
# Examples:
#   ./wscat-connect.sh
#   ./wscat-connect.sh ws://localhost:18789
#   ./wscat-connect.sh wss://gateway.example.com:18789 "my-token"
#
# Note: This script requires wscat >= 7.0 (for --auth support).
# If your version doesn't support --auth, set OPENCLAW_TOKEN env var
# and use the manual connect flow described below.

set -euo pipefail

WS_URL="${1:-ws://localhost:18789}"
TOKEN="${2:-${OPENCLAW_TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: No token provided. Set OPENCLAW_TOKEN env var or pass as second argument." >&2
  echo "  Usage: $0 [ws://host:port] [token]" >&2
  exit 1
fi

echo "Connecting to $WS_URL ..."
echo "Paste the connect JSON below when connected, then press Enter:"
echo ""
echo "NOTE: If wscat supports --auth, you can also run:"
echo "  wscat -c \"$WS_URL\" --auth \"Bearer $TOKEN\""
echo ""

# Try with --auth first (newer wscat), fall back to manual
if wscat --help 2>&1 | grep -q 'auth'; then
  exec wscat -c "$WS_URL" --auth "Bearer $TOKEN"
else
  echo "wscat does not support --auth. Running with manual connect flow..."
  echo "Paste this JSON as your first message after connecting:"
  echo ""
  cat << 'TEMPLATE'
{
  "type": "req",
  "id": 1,
  "method": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,
    "client": {
      "id": "wscat-manual",
      "version": "1.0.0",
      "platform": "cli",
      "mode": "cli"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": {
      "token": "PASTE_YOUR_TOKEN_HERE"
    }
  }
}
TEMPLATE
  echo ""
  echo "Press Enter to connect..."
  read -r
  exec wscat -c "$WS_URL"
fi
