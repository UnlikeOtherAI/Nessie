#!/usr/bin/env bash
# Stage a dedicated at-rest encryption root before a version that requires it
# starts. The host-only .env is never printed and its values are never logged.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Encryption preflight requires the host Compose .env file." >&2
  exit 1
fi

env_value() {
  awk -v name="$1" '
    index($0, name "=") == 1 {
      print substr($0, length(name) + 2)
      exit
    }
  ' "$ENV_FILE"
}

active_version="$(env_value NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION)"
key_ring="$(env_value NESSIE_ENCRYPTION_KEY_RING)"
legacy_key="$(env_value NESSIE_ENCRYPTION_LEGACY_KEY)"

if [ -n "$active_version" ] || [ -n "$key_ring" ]; then
  if [ -z "$active_version" ] || [ -z "$key_ring" ]; then
    echo "Encryption preflight requires both NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION and NESSIE_ENCRYPTION_KEY_RING when either is set." >&2
    exit 1
  fi
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
