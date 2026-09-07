#!/usr/bin/env sh
set -eu

: "${DEEP_AGENT_READ_TOKEN:?Set DEEP_AGENT_READ_TOKEN for the install command.}"

ssh_dir="$(mktemp -d)"
trap 'rm -rf "$ssh_dir"' EXIT
askpass="$ssh_dir/askpass"
printf '%s\n' '#!/usr/bin/env sh' 'printf %s "$DEEP_AGENT_READ_TOKEN"' > "$askpass"
chmod 700 "$askpass"

GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0='url.https://github.com/UnlikeOtherAI/deep.agent.git.insteadOf' \
GIT_CONFIG_VALUE_0='ssh://git@github.com/UnlikeOtherAI/deep.agent.git' \
GIT_CONFIG_KEY_1='url.https://github.com/UnlikeOtherAI/deep.agent.git.insteadOf' \
GIT_CONFIG_VALUE_1='git@github.com:UnlikeOtherAI/deep.agent.git' \
"$@"
