#!/usr/bin/env bash
set -euo pipefail

APP_KEY_NAME="UOA_BILLING_APP_KEY_NESSIE"
ACTOR_KEY_NAME="UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

IFS= read -r app_key
IFS= read -r actor_private_jwk
if [[ ! "$app_key" =~ ^uoa_app_[A-Za-z0-9_-]{16,}$ ]]; then
  echo "Refusing to install an invalid Nessie UOA billing app key" >&2
  exit 1
fi
if ((${#actor_private_jwk} < 512 || ${#actor_private_jwk} > 16384)) \
  || [[ "${actor_private_jwk:0:1}" != "{" ]] \
  || [[ "${actor_private_jwk: -1}" != "}" ]]; then
  echo "Refusing to install an invalid Nessie UOA billing actor key" >&2
  exit 1
fi
if IFS= read -r _unexpected_input; then
  echo "Refusing to install multiline Nessie UOA billing credentials" >&2
  exit 1
fi

umask 077
temp_file="$(mktemp "$SCRIPT_DIR/.env.tmp.XXXXXX")"
trap 'rm -f -- "$temp_file"' EXIT HUP INT TERM

if [[ -f "$ENV_FILE" ]]; then
  sed \
    -e "/^${APP_KEY_NAME}=/d" \
    -e "/^${ACTOR_KEY_NAME}=/d" \
    "$ENV_FILE" > "$temp_file"
fi
if [[ -s "$temp_file" && -n "$(tail -c 1 "$temp_file")" ]]; then
  printf '\n' >> "$temp_file"
fi
printf '%s=%s\n' "$APP_KEY_NAME" "$app_key" >> "$temp_file"
printf '%s=%s\n' "$ACTOR_KEY_NAME" "$actor_private_jwk" >> "$temp_file"
chmod 600 "$temp_file"
mv -f -- "$temp_file" "$ENV_FILE"
trap - EXIT HUP INT TERM

unset app_key actor_private_jwk ACTOR_PRIVATE_JWK
