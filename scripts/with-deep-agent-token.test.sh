#!/usr/bin/env sh
set -eu

DEEP_AGENT_READ_TOKEN=sentinel scripts/with-deep-agent-token.sh sh -c '
  test "$GIT_CONFIG_COUNT" = 3
  test "$GIT_CONFIG_KEY_0" = "url.https://x-access-token@github.com/UnlikeOtherAI/deep.agent.git.insteadOf"
  test "$GIT_CONFIG_VALUE_0" = "ssh://git@github.com/UnlikeOtherAI/deep.agent.git"
  test "$GIT_CONFIG_KEY_2" = credential.helper
  test -z "$GIT_CONFIG_VALUE_2"
'
grep -F "Password for '\''https://x-access-token@github.com'\'':" scripts/with-deep-agent-token.sh >/dev/null
! grep -F '*Password*' scripts/with-deep-agent-token.sh >/dev/null
