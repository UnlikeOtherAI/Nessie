#!/usr/bin/env sh
set -eu

: "${DEEP_AGENT_READ_TOKEN:?Set DEEP_AGENT_READ_TOKEN for the install command.}"

ssh_dir="$(mktemp -d)"
trap 'rm -rf "$ssh_dir"' EXIT
askpass="$ssh_dir/askpass"
printf '%s\n' '#!/usr/bin/env sh' 'case "$1" in "Password for '\''https://x-access-token@github.com'\''") printf %s "$DEEP_AGENT_READ_TOKEN" ;; *) exit 1 ;; esac' > "$askpass"
chmod 700 "$askpass"

LC_ALL=C LANG=C GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=3 \
GIT_CONFIG_KEY_0='url.https://x-access-token@github.com/UnlikeOtherAI/deep.agent.git.insteadOf' \
GIT_CONFIG_VALUE_0='ssh://git@github.com/UnlikeOtherAI/deep.agent.git' \
GIT_CONFIG_KEY_1='url.https://x-access-token@github.com/UnlikeOtherAI/deep.agent.git.insteadOf' \
GIT_CONFIG_VALUE_1='git@github.com:UnlikeOtherAI/deep.agent.git' \
GIT_CONFIG_KEY_2='credential.helper' GIT_CONFIG_VALUE_2='' \
"$@"
