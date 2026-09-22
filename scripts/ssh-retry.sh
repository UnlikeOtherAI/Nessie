#!/usr/bin/env bash
# Retry an ssh (or rsync-over-ssh) command whose failure was the connection,
# not the command.
#
# ssh returns 255 for a connection-level failure — "kex_exchange_identification:
# read: Connection reset by peer" is what the production host answers when its
# sshd is under a brute-force wave and random-early-drops new connections. A
# remote command's own failure is any other code and is returned at once, so a
# redeploy that ran and failed is never re-run by this script.
#
# --stdin-var NAME re-pipes the named variable's value on every attempt: a
# piped stdin is consumed by the first attempt, and a docker login retried
# with an empty password is not a retry.
set -u
stdin_var=""
if [ "${1:-}" = "--stdin-var" ]; then
  stdin_var="$2"
  shift 2
fi
if [ "${1:-}" = "--" ]; then
  shift
fi
attempts="${SSH_RETRY_ATTEMPTS:-5}"
for attempt in $(seq 1 "$attempts"); do
  if [ -n "$stdin_var" ]; then
    printf '%s\n' "${!stdin_var}" | "$@"
    code=$?
  else
    "$@"
    code=$?
  fi
  if [ "$code" -ne 255 ]; then
    exit "$code"
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "ssh: connection failed on every attempt ($attempts)" >&2
    exit 255
  fi
  delay=$((attempt * 5))
  echo "ssh: connection failed (exit 255); retrying in ${delay}s (attempt $attempt of $attempts)" >&2
  sleep "$delay"
done
