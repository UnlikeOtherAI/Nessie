#!/usr/bin/env sh
set -eu

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
askpass_path="$tmp/askpass-path"
credential="$tmp/credential"

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' GIT_CONFIG_VALUE_0='AUTHORIZATION: bearer inherited' \
DEEP_AGENT_READ_TOKEN=sentinel scripts/with-deep-agent-token.sh sh -c '
  set -eu
  cd /tmp
  printf %s "$GIT_ASKPASS" > "$1"
  printf "protocol=https\\nhost=github.com\\nusername=x-access-token\\n\\n" | git credential fill > "$2"
  "$GIT_ASKPASS" "Username for '\''https://github.com'\'':" > "$3" 2>/dev/null && exit 1
  test ! -s "$3"
  "$GIT_ASKPASS" "Password for '\''https://x-access-token@evil.example'\'':" > "$3" 2>/dev/null && exit 1
  test ! -s "$3"
  test "$GIT_CONFIG_KEY_2" = credential.helper
  test -z "$GIT_CONFIG_VALUE_2"
  test "$GIT_CONFIG_KEY_3" = http.https://github.com/.extraheader
  test -z "$GIT_CONFIG_VALUE_3"
' sh "$askpass_path" "$credential" "$tmp/rejected"

grep -Fx 'password=sentinel' "$credential" >/dev/null
test ! -e "$(cat "$askpass_path")"
