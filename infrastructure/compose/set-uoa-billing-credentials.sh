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
if ! ACTOR_PRIVATE_JWK="$actor_private_jwk" node -e '
  try {
    const { createPrivateKey } = require("node:crypto");
    const key = JSON.parse(process.env.ACTOR_PRIVATE_JWK ?? "");
    const valid = key.kty === "RSA"
      && typeof key.kid === "string" && key.kid.length > 0
      && typeof key.n === "string" && key.n.length > 0
      && typeof key.e === "string" && key.e.length > 0
      && typeof key.d === "string" && key.d.length > 0
      && (key.alg === undefined || key.alg === "RS256")
      && (key.use === undefined || key.use === "sig");
    if (!valid) process.exit(1);
    createPrivateKey({ format: "jwk", key });
    process.exit(0);
  } catch {
    process.exit(1);
  }
'; then
  echo "Refusing to install an invalid Nessie UOA billing actor key" >&2
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
