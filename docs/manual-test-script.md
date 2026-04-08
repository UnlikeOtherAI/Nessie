# Memory System Manual Test Script

End-to-end verification of the memory system (thoughts, reasoning, outcome tracking, linking, experience stats) through the running API.

## Prerequisites

1. API running on `localhost:4317` with a PostgreSQL database that has the memory migrations applied
2. `OPENAI_API_KEY` set in environment (required for embeddings and extraction)
3. A valid session token (obtained via login)

### Get a session token

```bash
# Local auth login
TOKEN=$(curl -s http://localhost:4317/api/auth/session \
  -H 'Content-Type: application/json' \
  -d '{"email":"your@email.com","password":"your-password"}' \
  | jq -r '.data.token')

echo $TOKEN
```

All subsequent commands use `$TOKEN` in the Authorization header.

---

## 1. Capture a thought (basic)

**What to verify:** Thought is stored in DB, embedding and metadata are extracted, response includes `embeddingFailed: false`.

```bash
curl -s http://localhost:4317/api/thoughts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "We should use PostgreSQL with pgvector for semantic search because it keeps everything in one database and avoids the operational overhead of a separate vector store like Pinecone.",
    "visibility": "private"
  }' | jq .
```

**Expected response:**
```json
{
  "data": {
    "id": "<uuid>",
    "content": "We should use PostgreSQL...",
    "contentHash": "<sha256>",
    "metadata": {
      "topics": ["postgresql", "pgvector", "semantic-search", ...],
      "type": "decision",
      ...
    },
    "reasoning": {
      "hasReasoning": true,
      "reasoningType": "technical_decision",
      "alternatives": ["Pinecone", ...],
      "confidence": 0.8,
      "reasoningSummary": "...",
      ...
    },
    "isDuplicate": false,
    "embeddingFailed": false,
    "createdAt": "..."
  }
}
```

**DB check:**
```sql
-- Verify thought exists with embedding
SELECT id, content_hash, visibility, importance,
       embedding IS NOT NULL AS has_embedding,
       metadata IS NOT NULL AS has_metadata
FROM thoughts ORDER BY created_at DESC LIMIT 1;

-- Verify reasoning was extracted
SELECT id, reasoning_type, confidence, outcome, alternatives
FROM thought_reasonings ORDER BY created_at DESC LIMIT 1;

-- Verify audit log
SELECT action, actor_type FROM thought_audit_logs
ORDER BY created_at DESC LIMIT 2;
```

---

## 2. Duplicate detection

**What to verify:** Same content returns `isDuplicate: true` without creating a new record.

```bash
# Send the exact same content again
curl -s http://localhost:4317/api/thoughts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "We should use PostgreSQL with pgvector for semantic search because it keeps everything in one database and avoids the operational overhead of a separate vector store like Pinecone.",
    "visibility": "private"
  }' | jq .data.isDuplicate
```

**Expected:** `true`

**DB check:**
```sql
-- Should still be only 1 row with this hash
SELECT count(*) FROM thoughts
WHERE content_hash = (SELECT content_hash FROM thoughts ORDER BY created_at DESC LIMIT 1);
```

---

## 3. Capture a thought without reasoning

**What to verify:** A factual statement (no decision/trade-off) should have `reasoning: null` and no `thought_reasonings` row.

```bash
curl -s http://localhost:4317/api/thoughts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "The deployment pipeline runs on GitHub Actions and deploys to GCP Cloud Run.",
    "visibility": "private"
  }' | jq '.data | {reasoning, isDuplicate}'
```

**Expected:** `{ "reasoning": null, "isDuplicate": false }` (or reasoning with `hasReasoning: false`)

---

## 4. Semantic search

**What to verify:** Searching for related concepts returns the thought with a similarity score.

```bash
curl -s http://localhost:4317/api/thoughts/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "vector database options",
    "threshold": 0.3,
    "limit": 5,
    "includeReasoning": true
  }' | jq .
```

**Expected:** The PostgreSQL/pgvector thought should appear with similarity > 0.3 and its reasoning attached.

**Negative test — unrelated query:**
```bash
curl -s http://localhost:4317/api/thoughts/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "chocolate cake recipe",
    "threshold": 0.5,
    "limit": 5
  }' | jq '.data | length'
```

**Expected:** `0` (no results above threshold)

---

## 5. Record an outcome

**What to verify:** Pending reasoning transitions to a resolved outcome.

```bash
# Get the thought ID from step 1
THOUGHT_ID="<paste-thought-id-from-step-1>"

curl -s -X PUT "http://localhost:4317/api/thoughts/$THOUGHT_ID/outcome" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "outcome": "successful",
    "outcomeNotes": "pgvector worked well in production, no issues after 3 months"
  }' | jq .
```

**Expected:** `{ "data": { "ok": true } }`

**DB check:**
```sql
SELECT outcome, outcome_notes, outcome_at
FROM thought_reasonings WHERE thought_id = '<thought-id>';
-- Should show: outcome = 'successful', outcome_notes set, outcome_at not null

SELECT action, diff FROM thought_audit_logs
WHERE thought_id = '<thought-id>' AND action = 'outcome_recorded';
```

---

## 6. Record outcome on non-existent thought (authorization check)

**What to verify:** Returns 404 for a thought that doesn't exist or belongs to another org.

```bash
curl -s -X PUT "http://localhost:4317/api/thoughts/00000000-0000-0000-0000-000000000000/outcome" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"outcome": "failed"}' | jq .
```

**Expected:** `{ "error": { "code": "THOUGHT_NOT_FOUND", "message": "Thought not found" } }` with HTTP 404.

---

## 7. Link two thoughts

**What to verify:** A link is created between two thoughts with the specified relation.

```bash
# First, capture a second thought that supersedes the first
curl -s http://localhost:4317/api/thoughts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "After testing, we decided to add a dedicated Qdrant instance alongside pgvector for high-throughput search. pgvector handles storage, Qdrant handles real-time queries.",
    "visibility": "private"
  }' | jq .data.id

NEW_THOUGHT_ID="<paste-new-thought-id>"

# Create a supersedes link
curl -s -X POST "http://localhost:4317/api/thoughts/$NEW_THOUGHT_ID/link" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"targetId\": \"$THOUGHT_ID\",
    \"relation\": \"supersedes\"
  }" | jq .
```

**Expected:** `{ "data": { "linkId": "<uuid>" } }` with HTTP 201.

**DB check:**
```sql
-- Verify link exists
SELECT source_id, target_id, relation FROM thought_links
ORDER BY created_at DESC LIMIT 1;

-- Verify the old thought's reasoning was auto-superseded
SELECT outcome, outcome_notes FROM thought_reasonings
WHERE thought_id = '<old-thought-id>';
-- Should show: outcome = 'superseded', notes = 'Superseded by thought <new-id>'
```

---

## 8. Duplicate link (idempotency)

**What to verify:** Re-sending the same link returns `alreadyExists: true` without creating a duplicate.

```bash
# Same link request again
curl -s -X POST "http://localhost:4317/api/thoughts/$NEW_THOUGHT_ID/link" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"targetId\": \"$THOUGHT_ID\",
    \"relation\": \"supersedes\"
  }" | jq .
```

**Expected:** `{ "data": { "linkId": null, "alreadyExists": true } }` with HTTP 200.

---

## 9. Experience stats

**What to verify:** Aggregated decision quality metrics reflect the outcomes recorded.

```bash
curl -s "http://localhost:4317/api/experience/stats" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:**
```json
{
  "data": {
    "totalDecisions": 1,
    "successful": 1,
    "failed": 0,
    "pending": 1,
    "successRate": 1.0
  }
}
```

(Numbers depend on how many thoughts with reasoning you captured and which outcomes you recorded. The superseded reasoning from step 7 counts toward `totalDecisions` but not `successful`.)

---

## 10. Cross-org access denied

**What to verify:** A user in org A cannot access thoughts from org B.

This requires two user accounts in different organizations. If you have them:

```bash
# Login as user in org B
TOKEN_B=$(curl -s http://localhost:4317/api/auth/session \
  -H 'Content-Type: application/json' \
  -d '{"email":"other@org-b.com","password":"password"}' \
  | jq -r '.data.token')

# Try to record outcome on org A's thought
curl -s -X PUT "http://localhost:4317/api/thoughts/$THOUGHT_ID/outcome" \
  -H "Authorization: Bearer $TOKEN_B" \
  -H 'Content-Type: application/json' \
  -d '{"outcome": "failed"}' | jq .
```

**Expected:** HTTP 404 `THOUGHT_NOT_FOUND` (not 403, to avoid leaking existence).

---

## 11. Search scoping

**What to verify:** Semantic search respects visibility and org boundaries.

```bash
# Search with org B token should not return org A's private thoughts
curl -s http://localhost:4317/api/thoughts/search \
  -H "Authorization: Bearer $TOKEN_B" \
  -H 'Content-Type: application/json' \
  -d '{"query": "vector database options", "threshold": 0.1}' | jq '.data | length'
```

**Expected:** `0`

---

## MCP tool testing

If connected via MCP client (e.g. Claude Code):

1. **capture_thought** — Send a message with a decision and verify it appears in DB
2. **search_thoughts** — Search for related concepts
3. **record_outcome** — Mark a decision as successful/failed
4. **link_thoughts** — Link related decisions
5. **experience_stats** — View decision quality metrics

Note: The current MCP adapter returns stub errors directing callers to the API routes, since the legacy `src/` MCP server has no pg pool. Full MCP support requires connecting the MCP server to the database pool.

---

## Cleanup

```sql
-- Remove test data (run in psql)
DELETE FROM thought_audit_logs;
DELETE FROM thought_links;
DELETE FROM thought_reasonings;
DELETE FROM thoughts;
```
