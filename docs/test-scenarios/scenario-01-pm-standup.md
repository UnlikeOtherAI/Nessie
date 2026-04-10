# Scenario 01 — PM Standup with Sprint Scribe

**Personas:** Alex (PM)
**Channel:** `sprint-planning`
**Agents bound:** `Sprint Scribe`
**Covers:** Single-user, single-agent `@mention` fast-path.

## Setup assumptions

- API on `5554`, worker running, postgres reachable.
- Personas exist and have password `nessie-test-pw`.
- `sprint-planning` channel exists with Sprint Scribe bound.
- Alex is a member of `sprint-planning`.

## Steps

### 1. Log in as Alex

```bash
ALEX_TOKEN=$(curl -s -X POST http://localhost:5554/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex.rivera@orbitalfoundry.test","password":"nessie-test-pw"}' \
  | jq -r '.token')
```

Expect `ALEX_TOKEN` to be a non-empty JWT.

### 2. Resolve the sprint-planning channel + its default thread

```bash
CHANNEL_ID=$(curl -s http://localhost:5554/api/channels \
  -H "Authorization: Bearer $ALEX_TOKEN" \
  | jq -r '.channels[] | select(.label=="sprint-planning") | .id')

THREAD_ID=$(curl -s "http://localhost:5554/api/channels/$CHANNEL_ID/threads" \
  -H "Authorization: Bearer $ALEX_TOKEN" \
  | jq -r '.threads[0].id')
```

### 3. Post the standup prompt

```bash
curl -s -X POST "http://localhost:5554/api/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $ALEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Sprint Scribe can you draft the sprint 34 standup notes for the Stripe team — we shipped the retry fix yesterday and are now on the webhook replay work."}'
```

Expect HTTP 200. The response contains the newly created user message.

### 4. Verify orchestrator enqueued a run

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT status, agent_id, created_at
    FROM runs
   WHERE channel_id = '$CHANNEL_ID'
     AND created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
   ORDER BY created_at DESC;
"
```

Expect one row, `status = 'completed'` within ~5 seconds, `agent_id`
matching Sprint Scribe (`f56fc408-4345-4936-8e3e-0973246daa4c`).

### 5. Verify reply message written

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT role, agent_id IS NOT NULL AS from_agent,
         left(content, 120) AS preview
    FROM messages
   WHERE thread_id = '$THREAD_ID'
     AND created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
   ORDER BY created_at;
"
```

Expect two rows: the user message, then an `assistant` row with
`from_agent = t` and a non-empty preview.

## Pass criteria

- Run row reaches `completed`.
- A non-empty assistant message is inserted back into the thread.
- No `error` rows in `runs` for this channel in the same window.

## Failure modes observed

- If `OPENAI_API_KEY` isn't loaded into the worker, the run stays
  `pending` or becomes `error` with a provider failure — fix by
  confirming `--env-file=../.env` is in `worker/package.json`.
- If the worker is not running, the run row stays `pending`. Start it
  with `pnpm --filter @nessie/worker dev`.
