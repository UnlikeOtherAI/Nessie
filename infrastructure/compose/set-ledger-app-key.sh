#!/usr/bin/env bash
set -euo pipefail

KEY_NAMES=("LEDGER_PROXY_TOKEN" "NESSIE_MODEL_API_KEY")
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

IFS= read -r app_key
if [[ ! "$app_key" =~ ^lk_[A-Za-z0-9_-]{20,}$ ]]; then
  echo "Refusing to install an invalid Nessie Ledger application key" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r name value || [[ -n "${name:-}${value:-}" ]]; do
    if [[ "$name" == "${KEY_NAMES[0]}" || "$name" == "${KEY_NAMES[1]}" ]]; then
      continue
    fi
    normalized_value="${value#"${value%%[![:space:]]*}"}"
    normalized_value="${normalized_value%"${normalized_value##*[![:space:]]}"}"
    if [[ "$normalized_value" == *[[:space:]]#* ]]; then
      normalized_value="${normalized_value%%[[:space:]]#*}"
      normalized_value="${normalized_value%"${normalized_value##*[![:space:]]}"}"
    fi
    if [[ ${#normalized_value} -ge 2 ]]; then
      first_character="${normalized_value:0:1}"
      last_character="${normalized_value: -1}"
      if [[ "$first_character" == "'" && "$last_character" == "'" ]] ||
        [[ "$first_character" == '"' && "$last_character" == '"' ]]; then
        normalized_value="${normalized_value:1:${#normalized_value}-2}"
      fi
    fi
    if [[ -n "$name" && "$normalized_value" == "$app_key" ]]; then
      echo "Refusing to reuse the Nessie Ledger application key as $name" >&2
      exit 1
    fi
  done < "$ENV_FILE"
fi

umask 077
temp_file="$(mktemp "$SCRIPT_DIR/.env.tmp.XXXXXX")"
trap 'rm -f -- "$temp_file"' EXIT HUP INT TERM

if [[ -f "$ENV_FILE" ]]; then
  sed \
    -e "/^${KEY_NAMES[0]}=/d" \
    -e "/^${KEY_NAMES[1]}=/d" \
    "$ENV_FILE" > "$temp_file"
fi
if [[ -s "$temp_file" && -n "$(tail -c 1 "$temp_file")" ]]; then
  printf '\n' >> "$temp_file"
fi
printf '%s=%s\n' "${KEY_NAMES[0]}" "$app_key" >> "$temp_file"
printf '%s=%s\n' "${KEY_NAMES[1]}" "$app_key" >> "$temp_file"
chmod 600 "$temp_file"
mv -f -- "$temp_file" "$ENV_FILE"
trap - EXIT HUP INT TERM

unset app_key
