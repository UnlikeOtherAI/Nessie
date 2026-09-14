#!/usr/bin/env bash
# Stage a dedicated at-rest encryption root before a version that requires it
# starts. The host-only .env is never printed and its values are never logged.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Encryption preflight requires the host Compose .env file." >&2
  exit 1
fi

dotenv_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ ${#value} -ge 2 ]; then
    local first="${value:0:1}"
    local last="${value: -1}"
    if { [ "$first" = "'" ] && [ "$last" = "'" ]; } || { [ "$first" = '"' ] && [ "$last" = '"' ]; }; then
      value="${value:1:${#value}-2}"
    fi
  fi
  if [[ "$value" == *[[:space:]]#* ]]; then
    value="${value%%[[:space:]]#*}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  printf '%s' "$value"
}

env_value() {
  local raw
  raw="$(awk -v name="$1" '
    index($0, name "=") == 1 {
      print substr($0, length(name) + 2)
      exit
    }
  ' "$ENV_FILE")"
  dotenv_value "$raw"
}

validate_configured_ring() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Encryption preflight cannot validate the configured at-rest key ring because python3 is unavailable." >&2
    exit 1
  fi

  if ! printf '%s\0%s\0%s' "$active_version" "$key_ring" "$legacy_key" | python3 -c '
import json
import re
import sys

active, raw_ring, legacy = sys.stdin.buffer.read().split(b"\0", 2)
version = re.compile(rb"^[A-Za-z0-9_-]{1,64}$")

try:
    ring = json.loads(raw_ring)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)

if (
    not version.fullmatch(active)
    or not isinstance(ring, dict)
    or active.decode() not in ring
    or any(
        not isinstance(key, str)
        or not version.fullmatch(key.encode())
        or not isinstance(value, str)
        or len(value) < 16
        for key, value in ring.items()
    )
    or (legacy and len(legacy.decode()) < 16)
):
    raise SystemExit(1)
'; then
    echo "Encryption preflight configured at-rest key ring does not meet the startup contract." >&2
    exit 1
  fi
}

active_version="$(env_value NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION)"
key_ring="$(env_value NESSIE_ENCRYPTION_KEY_RING)"
legacy_key="$(env_value NESSIE_ENCRYPTION_LEGACY_KEY)"

if [ -n "$active_version" ] || [ -n "$key_ring" ]; then
  if [ -z "$active_version" ] || [ -z "$key_ring" ]; then
    echo "Encryption preflight requires both NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION and NESSIE_ENCRYPTION_KEY_RING when either is set." >&2
    exit 1
  fi
  validate_configured_ring
  echo "Encryption preflight found a configured dedicated at-rest key ring."
  exit 0
fi

if [ -n "$legacy_key" ]; then
  echo "Encryption preflight found NESSIE_ENCRYPTION_LEGACY_KEY without a dedicated active key ring." >&2
  exit 1
fi

auth_secret="$(env_value NESSIE_AUTH_SECRET)"
if [ -z "$auth_secret" ]; then
  echo "Encryption preflight cannot stage a legacy root without NESSIE_AUTH_SECRET." >&2
  exit 1
fi

active_version="bootstrap-2026-09"
new_root="$(openssl rand -hex 32)"
if [ -z "$new_root" ]; then
  echo "Encryption preflight could not generate a dedicated at-rest root." >&2
  exit 1
fi

{
  printf '\n# At-rest encryption rotation bootstrap. Keep the legacy key only until\n'
  printf '# `pnpm --filter @nessie/api rotate:at-rest-secrets` reports zero conflicts.\n'
  printf 'NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION=%s\n' "$active_version"
  printf 'NESSIE_ENCRYPTION_KEY_RING={"%s":"%s"}\n' "$active_version" "$new_root"
  printf 'NESSIE_ENCRYPTION_LEGACY_KEY=%s\n' "$auth_secret"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Encryption preflight staged a dedicated at-rest key ring and retained the legacy root for rotation."
