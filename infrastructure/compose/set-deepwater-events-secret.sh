#!/usr/bin/env bash
set -euo pipefail

# DEEPWATER_EVENTS_SECRET: the HMAC key DeepWater signs its research events to
# Nessie with (DeepWater holds the same value as NESSIE_EVENTS_SIGNING_SECRET).
# Optional: the deploy pipes the GitHub Actions secret of the same name on
# standard input. A value is validated and installed into the host-only
# Compose .env; an empty line removes the key, so the host follows the secret
# and the receiver answers 503 while DeepWater keeps retrying and the watch
# through Ledger serves alone. An absent secret never fails the deploy; a
# malformed one does, because it can only be a mistake.

KEY_NAME="DEEPWATER_EVENTS_SECRET"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

IFS= read -r secret || true
if [[ -n "$secret" && ! "$secret" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo "Refusing to install a DeepWater events secret that is not 32-128 URL-safe characters" >&2
  exit 1
fi

if [[ -z "$secret" && ! -f "$ENV_FILE" ]]; then
  echo "DeepWater research events: no key set, so the receiver answers 503 and the Ledger watch serves alone"
  exit 0
fi

umask 077
temp_file="$(mktemp "$SCRIPT_DIR/.env.tmp.XXXXXX")"
trap 'rm -f -- "$temp_file"' EXIT HUP INT TERM

if [[ -f "$ENV_FILE" ]]; then
  sed "/^${KEY_NAME}=/d" "$ENV_FILE" > "$temp_file"
fi
if [[ -n "$secret" ]]; then
  if [[ -s "$temp_file" && -n "$(tail -c 1 "$temp_file")" ]]; then
    printf '\n' >> "$temp_file"
  fi
  printf '%s=%s\n' "$KEY_NAME" "$secret" >> "$temp_file"
  echo "DeepWater research events: the receiver key is installed"
else
  echo "DeepWater research events: no key set, so the receiver answers 503 and the Ledger watch serves alone"
fi
chmod 600 "$temp_file"
mv -f -- "$temp_file" "$ENV_FILE"
trap - EXIT HUP INT TERM

unset secret
