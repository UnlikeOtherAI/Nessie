# Scenario 03 — Boss + Executive Assistant with two agents

**Personas:** Jordan (exec), Morgan (assistant)
**Channels:** `exec-briefings`, `ea-workroom`
**Agents bound:** `Executive Brief` (in exec-briefings), `Calendar Keeper` (in ea-workroom)
**Covers:** Two humans, two channels, two agents — concurrent activity
across unrelated channels must not cross-talk.

## Steps

### 1. Log in as both personas

```bash
JORDAN_TOKEN=$(curl -s -X POST http://localhost:5554/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"jordan.park@orbitalfoundry.test","password":"nessie-test-pw"}' \
  | jq -r '.token')

MORGAN_TOKEN=$(curl -s -X POST http://localhost:5554/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"morgan.bale@orbitalfoundry.test","password":"nessie-test-pw"}' \
  | jq -r '.token')
```

### 2. Jordan drives Executive Brief

```bash
EXEC_CH=$(curl -s http://localhost:5554/api/channels \
  -H "Authorization: Bearer $JORDAN_TOKEN" \
  | jq -r '.channels[] | select(.label=="exec-briefings") | .id')
EXEC_TH=$(curl -s "http://localhost:5554/api/channels/$EXEC_CH/threads" \
  -H "Authorization: Bearer $JORDAN_TOKEN" \
  | jq -r '.threads[0].id')

curl -s -X POST "http://localhost:5554/api/threads/$EXEC_TH/messages" \
  -H "Authorization: Bearer $JORDAN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Executive Brief give me a 4-bullet monday brief on the Stripe webhook retries incident and the sprint 34 plan — I am about to walk into the investor sync."}'
```

### 3. Morgan drives Calendar Keeper (in parallel)

```bash
EA_CH=$(curl -s http://localhost:5554/api/channels \
  -H "Authorization: Bearer $MORGAN_TOKEN" \
  | jq -r '.channels[] | select(.label=="ea-workroom") | .id')
EA_TH=$(curl -s "http://localhost:5554/api/channels/$EA_CH/threads" \
  -H "Authorization: Bearer $MORGAN_TOKEN" \
  | jq -r '.threads[0].id')

curl -s -X POST "http://localhost:5554/api/threads/$EA_TH/messages" \
  -H "Authorization: Bearer $MORGAN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Calendar Keeper Jordan needs a 30m sync with the Stripe engineering team before Wednesday EOD — check Jordan'"'"'s afternoon availability and propose two slots."}'
```

### 4. Verify both runs independent

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT r.status, a.name, r.channel_id, r.created_at
    FROM runs r
    JOIN agents a ON a.id = r.agent_id
   WHERE r.created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
     AND a.name IN ('Executive Brief','Calendar Keeper')
   ORDER BY r.created_at DESC;
"
```

Expect two rows, both `completed`, with distinct `channel_id` values.

### 5. Verify replies landed in the right thread

```bash
psql -h localhost -U dictator -d nessie -c "
  SELECT m.thread_id, a.name, left(m.content, 100) AS preview
    FROM messages m
    LEFT JOIN agents a ON a.id = m.agent_id
   WHERE m.created_at > NOW() AT TIME ZONE 'UTC' - INTERVAL '2 minutes'
     AND m.role = 'assistant'
   ORDER BY m.created_at;
"
```

Executive Brief's reply must be in `$EXEC_TH`; Calendar Keeper's in
`$EA_TH`. Neither agent should post in the other's thread.

## Pass criteria

- Two `completed` runs, one per agent, in the same 2-minute window.
- Each reply lands in the originating thread only.
- Reply content is topically relevant (Stripe/sprint for Executive
  Brief; calendar availability for Calendar Keeper).
