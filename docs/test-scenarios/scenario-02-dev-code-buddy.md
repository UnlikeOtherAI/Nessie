# Scenario 02 — Developer asks Code Buddy

**Personas:** Sam (dev), Morgan (second dev, needs membership first)
**Channel:** `dev-chatter`
**Agents bound:** `Code Buddy`
**Covers:** Direct `@mention`, plus channel-membership enforcement:
posting to a thread you are not a member of returns `THREAD_NOT_FOUND`.

## Steps

### 1. Log in as Sam

```bash
SAM_TOKEN=$(curl -s -X POST http://localhost:5454/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"sam.chen@orbitalfoundry.test","password":"nessie-test-pw"}' \
  | jq -r '.token')
```

### 2. Resolve channel + thread

```bash
CHANNEL_ID=$(curl -s http://localhost:5454/api/channels \
  -H "Authorization: Bearer $SAM_TOKEN" \
  | jq -r '.channels[] | select(.label=="dev-chatter") | .id')

THREAD_ID=$(curl -s "http://localhost:5454/api/channels/$CHANNEL_ID/threads" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  | jq -r '.threads[0].id')
```

### 3. Sam posts a technical question

```bash
curl -s -X POST "http://localhost:5454/api/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $SAM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Code Buddy what is a good Redis-backed idempotency key pattern for the webhook retry path — we are seeing duplicate charges on Stripe retry?"}'
```

Expect HTTP 200 and a completed run for Code Buddy (agent id
`512dfdd8-96bb-46b9-b739-3bffcc5f81be`).

### 4. Morgan (not a member) tries to post — should fail

```bash
MORGAN_TOKEN=$(curl -s -X POST http://localhost:5454/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"morgan.bale@orbitalfoundry.test","password":"nessie-test-pw"}' \
  | jq -r '.token')

curl -s -X POST "http://localhost:5454/api/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $MORGAN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Code Buddy chiming in"}'
```

Expect HTTP 404 `{"error":"THREAD_NOT_FOUND"}` — a non-member cannot
see the thread (access enforced via `channel_members` join in
`findThreadForUser`, see `api/src/services/message-read-state.ts`).

### 5. Alex (owner) adds Morgan to the channel

```bash
curl -s -X POST "http://localhost:5454/api/channels/$CHANNEL_ID/members" \
  -H "Authorization: Bearer $ALEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"447a6083-b618-4b31-b802-a3dd9e994f53","role":"member"}'
```

### 6. Morgan retries — succeeds

```bash
curl -s -X POST "http://localhost:5454/api/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $MORGAN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Code Buddy jumping in — would you recommend SETNX with TTL or SET NX EX for that lock?"}'
```

Expect HTTP 200 and a second completed run for Code Buddy.

## Pass criteria

- Sam's message yields a completed Code Buddy run + reply.
- Morgan's first attempt returns `THREAD_NOT_FOUND`.
- After membership is granted, Morgan's retry yields a second
  completed Code Buddy run + reply.
- Both replies reference Stripe/idempotency context, not generic text.

## Why this matters

Exercises two distinct enforcement layers (auth-level channel
membership, orchestrator `@mention` routing) in one flow.
