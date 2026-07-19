#!/usr/bin/env bash
set -euo pipefail

KEY_NAME="LEDGER_BILLING_READ_APP_KEY_NESSIE"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

IFS= read -r app_key
if [[ ! "$app_key" =~ ^lk_[A-Za-z0-9_-]{20,}$ ]]; then
  echo "Refusing to install an invalid Nessie Ledger billing-reader key" >&2
  exit 1
fi

umask 077
temp_file="$(mktemp "$SCRIPT_DIR/.env.tmp.XXXXXX")"
trap 'rm -f -- "$temp_file"' EXIT HUP INT TERM

if [[ -f "$ENV_FILE" ]]; then
  sed "/^${KEY_NAME}=/d" "$ENV_FILE" > "$temp_file"
fi
printf '%s=%s\n' "$KEY_NAME" "$app_key" >> "$temp_file"
chmod 600 "$temp_file"
mv -f -- "$temp_file" "$ENV_FILE"
trap - EXIT HUP INT TERM

unset app_key
