# Scenario 05 — Cross-channel mention + multi-agent fan-out

**Personas:** Sam
**Channel:** `dev-chatter` (only Code Buddy bound)
**Covers:** Two subtle behaviours regressed and fixed on 2026-04-10:

1. `@mention` an agent that is NOT bound to the current channel — the
   structured identity must produce an invitation for that exact agent.
2. `@mention` multiple agents in a single message — all of them must
   reply, not just the first.

## Prior bugs

### Bug A — greedy regex in `messages.ts`

Original code:

```ts
const mentionRe = /@([\w][\w\s]*[\w]|[\w]+)/g
```

For `"hi @Code Buddy what think"` it captured
`"Code Buddy what think"` as the name, which matched nothing. Agent
names can contain spaces, so the regex cannot split names out of free
text correctly without also matching the name list.

**Historical fix** — legacy plain-text API requests iterate candidate agents,
use the same per-name escape that `orchestrator.ts` uses, and test each against
the content. Composer messages now include exact agent ids, so this fallback is
not used for interactive mentions:

```ts
for (const agent of candidates) {
  const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
  if (mentionRe.test(input.content)) channelAgents.push(agent)
}
```

### Bug B — single-decision return type in `orchestrator.ts`

The fast-path returned on the first matching agent:

```ts
return { action: 'reply', agentId: agent.id }   // wrong — single
```

Multi-@mention messages only triggered the first matched agent. The
fix changes the signature to `OrchestratorDecision[]`, collects every
matched agent, and the POST handler iterates.

## Test

### 1. Cross-channel @mention

Sprint Scribe is bound only to `sprint-planning`, but Sam `@mentions`
it from `dev-chatter`:

```bash
curl -s -X POST "http://localhost:5454/api/threads/$DEV_TH/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Sprint Scribe please record: the Stripe webhook retry fix shipped to production today at 14:30 UTC.","agentMentions":[{"type":"agent","agentId":"'"$SPRINT_AGENT_ID"'"}]}'
```

Expected: `pendingAgentInvites` contains exactly Sprint Scribe and no run starts
until the person accepts **Invite & reply**. Acceptance binds the agent, replays
the exact structured mention, and produces a completed run tied to `$DEV_CH`.

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT r.status, a.name, r.channel_id = '$DEV_CH' AS in_dev_channel
    FROM runs r JOIN agents a ON a.id = r.agent_id
   WHERE r.created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
     AND a.name = 'Sprint Scribe';
"
```

### 2. Multi-agent @mention

```bash
curl -s -X POST "http://localhost:5454/api/threads/$DEV_TH/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Multi-agent test — @Code Buddy please sanity check the idempotency approach one more time, and @Sprint Scribe please record this as the shipping milestone for the Stripe fix.","agentMentions":[{"type":"agent","agentId":"'"$CODE_AGENT_ID"'"},{"type":"agent","agentId":"'"$SPRINT_AGENT_ID"'"}]}'
```

Expected: TWO `completed` runs in the same window, one per agent, and
TWO assistant messages in `$DEV_TH`.

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT a.name, r.status, m.role, left(m.content, 80) AS preview
    FROM runs r
    JOIN agents a ON a.id = r.agent_id
    LEFT JOIN messages m ON m.run_id = r.id
   WHERE r.created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
     AND r.channel_id = '$DEV_CH'
   ORDER BY r.created_at;
"
```

Expect 2 rows minimum: `Code Buddy` and `Sprint Scribe`, both
`completed`.

### 3. Live verification output from first run (2026-04-10)

- Sprint Scribe: completed `14:58:44.056`, reply at `14:58:50.951`.
- Code Buddy: completed `14:58:44.018`, reply at `14:58:48.688`.

Both replies arrived in `$DEV_TH` from a single POST.

## Pass criteria

- #1 produces exactly one Sprint Scribe run in `$DEV_CH`.
- #2 produces two distinct runs (one per `@mention`) in the same
  channel, both `completed`, each with an assistant reply.
- No `NOT_FOUND` or `500` responses on the POST.

## What this validates

- `message-create.ts` and `orchestrator.ts` preserve the same id-keyed mention
  identities end-to-end; duplicate names cannot widen the target set.
- A cross-channel mention requires an explicit invitation before the agent is
  invoked; accepting it replays only that selected identity.
- The orchestrator fan-out supports `N` agents per user message.
