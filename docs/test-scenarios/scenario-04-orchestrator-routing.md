# Scenario 04 — Orchestrator routing (no @mentions)

**Personas:** Sam, Alex
**Channel:** `dev-chatter` (Code Buddy bound)
**Covers:** LLM-path in `decideAgentEngagement`. Messages without any
`@` — the orchestrator calls gpt-5-mini and decides whether any bound
agent should reply, acknowledge with an emoji, or stay silent.

## Why this path exists

`api/src/services/orchestrator.ts` has three branches:

1. `@agent` fast-path — regex-matched agents are enqueued directly.
2. `@user` (non-agent mention) — return silently; it's a user ping.
3. No `@` — ask the LLM to pick one of: reply / acknowledge / none.

This scenario only exercises branch 3.

## Steps

### 1. Sam posts a user-to-user message (no mention at all)

```bash
curl -s -X POST "http://localhost:5554/api/threads/$DEV_TH/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Alex, I just pushed the retry fix — could you let the support team know the dashboard should stabilise within the hour?"}'
```

Expect HTTP 200. No run should be created — this is a human→human
message.

Verify:

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT count(*) FROM runs
   WHERE channel_id = '$DEV_CH'
     AND created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '60 seconds';
"
```

Expect `0`.

### 2. Sam posts an engineering question with no mention

```bash
curl -s -X POST "http://localhost:5554/api/threads/$DEV_TH/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick sanity check — is Redis SETNX idempotent against a partitioned master, or do we need RedLock for the Stripe replay job?"}'
```

Here the LLM orchestrator MAY decide Code Buddy should reply. Either
outcome is valid; what matters is that it does not crash.

### 3. Confirm the LLM call didn't error

```bash
grep -i "orchestrator" /tmp/nessie_api.log | tail -20
```

Expect decision lines like `orchestrator_decision action=none`
or `action=reply`. Do NOT accept any `ProviderInvocationError`,
`temperature`, or `400` errors.

### 4. Acknowledge path (optional observation)

Post a short social message:

```bash
curl -s -X POST "http://localhost:5554/api/threads/$DEV_TH/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"thanks everyone — ending my day now, see you tomorrow"}'
```

The orchestrator may return `{action:'acknowledge', emoji:'...'}`. If
so, a `message_reactions` row is inserted, not a new assistant message.
If it returns `none`, that is also acceptable — the system prompt
explicitly says "when in doubt, return none".

Verify reactions:

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT r.emoji, a.name
    FROM message_reactions r
    LEFT JOIN agents a ON a.id = r.agent_id
   WHERE r.created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '60 seconds';
"
```

## Pass criteria

- No crash or provider error in the window.
- User-to-user statement (#1) produces zero runs.
- Technical question (#2) produces 0 or 1 runs, never more.
- If acknowledgement happens (#4), exactly one reaction is inserted.

## What this validates about the orchestrator

- `decideAgentEngagement` always returns an array (even when empty).
- The gpt-5-mini temperature fix is load-bearing — without it, every
  LLM path call would 400.
- The "stay silent on human conversations" rule is honoured by the
  system prompt.
