#!/usr/bin/env sh
set -eu

: "${DEEP_AGENT_READ_KEY_PATH:?Set DEEP_AGENT_READ_KEY_PATH to the temporary deploy key.}"

ssh_dir="$(mktemp -d)"
trap 'rm -rf "$ssh_dir"' EXIT
cat > "$ssh_dir/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${DEEP_AGENT_READ_KEY_PATH}
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ${ssh_dir}/known_hosts
EOF
printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  > "$ssh_dir/known_hosts"
chmod 600 "$ssh_dir/config" "$ssh_dir/known_hosts" "$DEEP_AGENT_READ_KEY_PATH"

GIT_SSH_COMMAND="ssh -F $ssh_dir/config" "$@"
