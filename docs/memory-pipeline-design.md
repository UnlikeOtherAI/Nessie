# Memory Pipeline Design

How Nessie extracts, assigns, stores, and retrieves memories — structured around the four pipeline stages where complexity lives, not around features.

Builds on:
- [memory-reasoning-and-experience.md](memory-reasoning-and-experience.md) — reasoning model, outcome tracking
- [memory-security-and-scoping.md](memory-security-and-scoping.md) — multi-tenant visibility, org hard boundaries

Research backing (deep research papers informing this design):
- [research/memory-retrieval-and-reranking-in-multi-agent-systems.md](research/memory-retrieval-and-reranking-in-multi-agent-systems.md) — retrieval architectures, reranking, cold start, negative mining, implicit feedback
- [research/reasoning-provenance-and-decision-traceability.md](research/reasoning-provenance-and-decision-traceability.md) — 30 years of design rationale research, argumentation models, artifact linking, knowledge decay
- [research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md](research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md) — information flow control, DLM, membership inference, embedding security, need-to-know

---

## Memory Taxonomy

Two first-class memory types with fundamentally different retrieval patterns:

### Intents

What was decided, what exists, what happened. Retrieved by **topic similarity**.

> "We added a required phone number field to the signup form."

Intents are the current `Thought` model. They answer "what?" and are found when someone asks about a related topic.

### Reasons

Why something was decided, why something exists. Retrieved by **artifact reference**.

> "Legal requires phone verification for KYC compliance in regulated markets. This was mandated in the Q2 compliance review."

Reasons are a new first-class entity. They answer "why does this exist?" and are found when someone points at a specific artifact — a field, endpoint, config value, component — and asks why it's there.

The critical difference: intents are found by semantic similarity to a *topic*. Reasons are found by matching against an *artifact identifier* — a file path, UI component name, database column, API field. Without artifact linkage, reasons become unfindable the moment the person who wrote them leaves.

### Why Two Types

The fired developer problem: someone built a form field two years ago. Nobody remembers why. The reason existed in a Slack thread, a PR description, a conversation with an agent. If the system captured and attached that reason to the artifact, anyone pointing at the field can discover why it exists — without asking a person.

---

## Stage 1: Extraction

### The Problem

A 50-message conversation might contain one decision, three facts, and a reason split across messages 12 and 31. Extraction must handle:

- **Fragmented reasoning** — the "why" is spread across multiple messages, often after someone pushes back
- **Implicit reasons** — during research, the agent reads a document that explains why something should exist; the reason is in the source material, not stated by the user
- **Retroactive reasons** — someone asks "why does this exist?" and the answer is discovered; it should be permanently attached so nobody asks again

### Three Extraction Modes

**Explicit extraction** (what we have now):
Someone says "we're doing X because Y." The `extractReasoning` pipeline catches this and creates a structured reasoning record. Works for decisions made during conversation.

**Implicit extraction** (new):
During a conversation, an agent consults documents, PRs, design docs, or prior conversations to inform its response. If those sources contain reasoning that explains an existing artifact, that reasoning should be captured and linked — even though nobody explicitly stated it as a decision.

Trigger: when an agent's research references both a *reason* (from a source document) and an *artifact* (the thing being discussed), link them.

**Retroactive extraction** (new):
Someone asks "why is there a phone field on signup?" The agent finds the answer (in a past conversation, a design doc, or by reasoning). The answer is stored as a Reason memory linked to the artifact `signup-form > phone-field`, so the next person who asks gets it immediately without re-researching.

Trigger: a "why does X exist?" question pattern, after the answer is resolved.

### What Gets Extracted

From every conversation turn, the extraction pipeline classifies content into:

| Category | Example | Memory Type | Stored As |
|----------|---------|-------------|-----------|
| Decision | "Let's use Fastify for the API" | Intent | Thought |
| Fact | "The deploy pipeline uses GitHub Actions" | Intent | Thought |
| Reason | "We chose Fastify because it benchmarks 2x Express" | Reason | Thought + artifact link |
| Constraint | "Budget is $5k/month" | Intent (tagged) | Thought with reasoning |
| Preference | "Team prefers explicit error types" | Intent (tagged) | Thought with reasoning |
| Observation | "The auth middleware pattern from PR #42" | Intent | Thought |

The extraction prompt should identify:
1. What category this content falls into
2. Whether it contains reasoning (why/because/rationale)
3. What artifact it refers to, if any (file, component, field, endpoint)
4. Whether it references a prior decision or memory

### Volume Policy

Capture everything. The dedup layer (SHA-256 fingerprint + near-duplicate embedding similarity) prevents redundancy. Storage is cheap. A memory nobody searches for costs nothing. A missing memory when someone needs it costs days of re-discovery.

---

## Stage 2: Assignment

### Scope Assignment

Every memory gets a scope that determines who can see it. The current model uses structural visibility (private/channel/team/project/organization) based on where the memory was created.

The problem: an agent that participates in both a management channel and a client channel could recall management memories while talking to a client. The container tells you where the memory was *created*, not where it can be *surfaced*.

**Recall scope** (new concept): memories carry a restriction on the contexts in which they can be surfaced, distinct from their storage scope.

Rules:

1. **Channel-scoped memories** can only be recalled in that channel, or in channels whose membership is a superset of the source channel's membership. A memory from a private management channel is never surfaced in a public client channel.

2. **Sensitivity tier inheritance**: if a channel is classified as `internal-only`, `confidential`, or `restricted`, every memory from that channel inherits that classification automatically. No manual tagging needed.

3. **Recall context check**: when an agent searches memories during a conversation in channel X, the search function filters to memories whose source channel membership is compatible with channel X's membership. This prevents cross-audience leaks.

```
Management channel (members: CEO, CTO, VP)
  └── Memory: "We're planning layoffs in Q3"
  └── Recall scope: only in channels where ALL members are in {CEO, CTO, VP}

Client channel (members: CEO, client-contact)
  └── Agent searches for "Q3 plans"
  └── Management memory is EXCLUDED (client-contact not in management channel)
```

### Artifact Assignment

For Reason memories, the system must link the reason to the artifact it explains. Artifacts are identified by:

- **File path**: `src/components/SignupForm.tsx`
- **Component name**: `PhoneNumberField`
- **API endpoint**: `POST /api/users`
- **Database column**: `users.phone_number`
- **Config key**: `auth.require_phone_verification`
- **UI element**: `signup-form > phone-field`
- **Concept**: `phone-verification-requirement`

Artifact identifiers are free-form strings with a type hint. They don't need to be validated against the actual codebase at capture time — they're search keys, not foreign keys. An artifact like `signup form phone field` should match when someone asks "why does the signup form have a phone field?"

### Category Assignment

Each memory is categorized as:
- `intent` — what was decided/done/exists
- `reason` — why it was decided/done/exists
- `constraint` — an external limitation shaping decisions
- `preference` — a team/user preference pattern
- `fact` — a statement of current state

Category drives retrieval strategy: intents are found by topic similarity, reasons by artifact reference, constraints by impact analysis.

---

## Stage 3: Storage

### Schema Additions

New entity for artifact-linked reasons:

```
thought_artifacts
  id           UUID PK
  thought_id   UUID FK -> thoughts
  artifact_type  TEXT    -- 'file', 'component', 'endpoint', 'column', 'config', 'ui_element', 'concept'
  artifact_ref   TEXT    -- the identifier: 'src/components/SignupForm.tsx', 'signup-form > phone-field'
  artifact_embedding  vector(1536)  -- embedding of the artifact ref for fuzzy matching
  created_at   TIMESTAMPTZ
```

Index: HNSW on `artifact_embedding` for "why does X exist?" queries.
Index: B-tree on `artifact_ref` for exact-match lookups.

### Recall Ledger

Every time a memory is surfaced during a conversation:

```
thought_recalls
  id              UUID PK
  thought_id      UUID FK -> thoughts
  session_id      TEXT          -- conversation/thread ID
  channel_id      UUID          -- where the recall happened
  query_text      TEXT          -- what query triggered the recall
  query_embedding vector(1536)  -- the query that found this memory
  similarity      FLOAT         -- cosine similarity score
  rank_position   INT           -- position in search results (1 = top)
  recall_context  TEXT          -- 'semantic_search', 'artifact_lookup', 'agent_retrieval'
  was_injected    BOOLEAN       -- was it actually put into the agent's context?
  was_referenced  BOOLEAN       -- did the agent's response reference this memory?
  user_signal     TEXT          -- 'helpful', 'irrelevant', 'harmful', NULL
  created_at      TIMESTAMPTZ
```

This is the operational table. It tracks every recall event and its outcome signal.

### Negative Signal Store

Training data for improving retrieval. Separate table (or separate database later) optimized for batch reads:

```
recall_training_signals
  id              UUID PK
  query_text      TEXT
  query_embedding vector(1536)
  thought_id      UUID
  similarity      FLOAT
  signal          TEXT    -- 'positive', 'negative_ignored', 'negative_unhelpful', 'negative_harmful'
  memory_category TEXT    -- 'intent', 'reason', 'constraint', 'preference', 'fact'
  channel_type    TEXT    -- context about the conversation type
  conversation_topic TEXT -- high-level topic of the conversation
  actor_role      TEXT    -- role of the person who gave the signal
  created_at      TIMESTAMPTZ
```

Write-heavy, batch-read for training. Each row is a (query, memory, context) -> signal triple. Over time this builds a dataset for training a reranker that learns "for this type of query in this context, these memories are useful and these aren't."

### Memory Category Column

Add to `thoughts`:

```
memory_type  TEXT DEFAULT 'intent'  -- 'intent', 'reason', 'constraint', 'preference', 'fact'
```

This is set by the extraction pipeline and drives retrieval strategy.

---

## Stage 4: Retrieval

### The Problem

Cosine similarity gets you 50 candidate memories. The agent's context window fits 5. Choosing wrong costs more than choosing none — irrelevant memories pollute the agent's reasoning.

### Retrieval Strategy by Memory Type

**Intents** — standard semantic search:
1. Embed the query
2. Run `match_thoughts_scoped()` with visibility/org filters
3. Rank by similarity
4. Take top N

**Reasons** — artifact-referenced search:
1. Extract artifact reference from the query ("why does the signup form have a phone field?" -> artifact: `signup-form > phone-field`)
2. Search `thought_artifacts` by embedding similarity on `artifact_embedding`
3. Join back to thoughts where `memory_type = 'reason'`
4. Return the reason chain (may be multiple reasons for one artifact)

**Combined** — when the system doesn't know if the user wants an intent or a reason:
1. Run both searches in parallel
2. Merge and deduplicate
3. Prioritize by: exact artifact match > high semantic similarity > recency

### Recall Logging

Every retrieval writes to `thought_recalls`:
- Which memories were candidates
- Which were injected into context
- Their rank positions

### Signal Collection

After the conversation turn:

1. **Automatic signal**: did the agent's response reference content from the recalled memory? If yes, `was_referenced = true` (positive signal). If the memory was injected but not referenced, `was_referenced = false` (weak negative).

2. **Explicit signal**: the user can flag a memory as helpful or irrelevant. This is the strongest signal.

3. **Session outcome signal**: if the conversation has a task that gets completed, all recalled memories from that session get a positive association. If the task fails or the user expresses frustration, negative association.

### Signal -> Training Data

Periodically, `thought_recalls` rows are aggregated into `recall_training_signals`:

```
For each recall:
  if was_referenced AND (user_signal = 'helpful' OR user_signal IS NULL):
    signal = 'positive'
  if NOT was_referenced AND NOT was_injected:
    signal = 'negative_ignored'  (system filtered it out)
  if was_injected AND NOT was_referenced:
    signal = 'negative_unhelpful'  (agent had it but didn't use it)
  if user_signal = 'harmful':
    signal = 'negative_harmful'  (actively wrong/misleading)
```

### Reranking (Future)

With enough training data, train a lightweight reranker model:
- Input: (query_embedding, memory_embedding, memory_category, channel_type, similarity_score)
- Output: relevance probability
- Training set: the `recall_training_signals` table

The reranker sits between the initial similarity search and context injection. It re-scores candidates using learned patterns beyond raw cosine similarity.

---

## Security Model

### Org Hard Boundary

All queries include `organization_id = $org_id`. No cross-org memory access. Period.

### Recall Scope (Audience Isolation)

The critical addition beyond the existing visibility model:

When an agent searches memories during a conversation in channel X:

```sql
-- Extended scoping: check that source channel membership
-- is compatible with current channel membership
AND (
  t.visibility = 'private' AND t.owner_id = $user_id
  OR t.visibility = 'organization'
  OR t.visibility IN ('channel', 'team', 'project') AND (
    -- Standard membership check (existing)
    ...existing checks...
    -- NEW: Audience compatibility check
    -- For channel-scoped memories, verify no member of the
    -- source channel is excluded from the current channel
    AND NOT EXISTS (
      SELECT 1 FROM channel_members source_cm
      WHERE source_cm.channel_id = t.channel_id
        AND source_cm.user_id NOT IN (
          SELECT user_id FROM channel_members
          WHERE channel_id = $current_channel_id
        )
    )
  )
)
```

This prevents a memory from a 3-person management channel being surfaced in a 50-person public channel — even if the searching user is in both.

Exception: `organization`-visibility memories are explicitly designated as org-wide and skip audience checks.

### Sensitivity Auto-Classification

Memories from channels tagged as `confidential` or `internal` automatically inherit elevated sensitivity. The extraction pipeline doesn't need to detect sensitive content when the container is already classified.

### Reason Security

Reasons linked to artifacts are particularly sensitive because they expose *motivations*. A reason like "we added this field because legal flagged compliance risk" reveals internal legal concerns. Reasons inherit the strictest scope of either:
- The conversation they were extracted from
- The artifact they're linked to (if the artifact has its own access control)

---

## Feedback Loop

The full cycle:

```
Conversation happens
  -> Extraction: identify intents, reasons, constraints
  -> Assignment: scope, category, artifact links
  -> Storage: thoughts + artifacts + reasoning records
  -> ...time passes...
  -> Retrieval: agent searches for relevant memories
  -> Recall logging: what was found, ranked, injected
  -> Agent responds
  -> Signal collection: was it referenced? was it helpful?
  -> Training data: positive/negative signals accumulated
  -> Reranker improvement: better retrieval next time
  -> Outcome tracking: did the decision work out?
  -> Experience: success rates inform future confidence
```

Each cycle makes the next retrieval better. The system learns not just what to remember, but what's worth surfacing for a given type of question.

---

## Implementation Phases

### Phase 1: Recall Ledger (Immediate)
- `thought_recalls` table
- Log every retrieval event during conversations
- Track `was_injected` and `was_referenced` automatically
- This generates the data we need for everything else

### Phase 2: Memory Types + Artifact Links
- Add `memory_type` column to thoughts
- `thought_artifacts` table for artifact-linked reasons
- Artifact-based search endpoint ("why does X exist?")
- Extraction pipeline updates for reason detection and artifact identification

### Phase 3: Recall Scoping
- Audience compatibility checks in `match_thoughts_scoped()`
- Channel-level sensitivity classification
- Automatic sensitivity inheritance

### Phase 4: Signal Collection + Training Data
- `recall_training_signals` table
- Automatic signal derivation from `was_referenced`
- User signal collection (thumbs up/down on recalled memories)
- Session outcome correlation

### Phase 5: Reranker
- Train initial reranker model on accumulated signals
- Deploy as a scoring step between similarity search and context injection
- A/B test retrieval quality

---

## Reason Provenance Chains

A reason rarely arrives fully formed. It develops through conversation:

```
Turn 3:  "I think we need phone verification"           <- intuition
Turn 8:  "Actually it's a legal thing"                   <- reframing
Turn 14: "Specifically KYC compliance for regulated markets" <- precision
Turn 22: "Sarah confirmed this is a hard requirement"    <- validation
```

The final crystallized reason is "Legal requires phone verification for KYC compliance in regulated markets, confirmed by Sarah." But the *thought process* that produced it is equally valuable — it shows why this isn't just someone's opinion, it's a traced conclusion.

### Modeling Reason Development

Each step in the reasoning process is its own Thought with `memory_type = 'reason'`, linked in a `DERIVED_FROM` chain:

```
Thought A: "I think we need phone verification"
  └── DERIVED_FROM → nothing (origin)

Thought B: "It's a legal/KYC requirement"
  └── DERIVED_FROM → Thought A

Thought C: "Sarah confirmed: hard legal requirement for regulated markets"
  └── DERIVED_FROM → Thought B
  └── artifact_ref: "signup-form > phone-field"
```

The latest thought in the chain (C) is the current crystallized reason. The chain traces how it got there. When someone asks "why does the signup form have a phone field?", they get:

1. **The reason**: KYC compliance for regulated markets (Thought C)
2. **The provenance**: how this was established — initial intuition, reframing as legal requirement, confirmation from Sarah
3. **The source messages**: which conversation turns contained each step

### Source Attribution

Each reason step records where it came from:

```
thought_sources
  id           UUID PK
  thought_id   UUID FK -> thoughts
  source_type  TEXT    -- 'message', 'document', 'pr', 'commit', 'external'
  source_ref   TEXT    -- message ID, document path, PR URL
  excerpt      TEXT    -- the relevant snippet from the source
  created_at   TIMESTAMPTZ
```

This allows tracing from the crystallized reason back through the reasoning steps to the original source material. When someone challenges "why do we have this?", the system can show not just the answer but the evidence trail.

### Superseding Developing Reasons

If the reason changes (legal drops the requirement), a new chain starts with a `SUPERSEDES` link to the old chain's head:

```
Thought D: "Legal dropped the KYC phone requirement in Q4 review"
  └── SUPERSEDES → Thought C
  └── artifact_ref: "signup-form > phone-field"
```

Now "why does the phone field exist?" returns Thought D (the superseding reason) with a note that the original justification no longer applies. The old chain is preserved for history.

---

## Key Design Decisions

1. **Reasons are first-class, not metadata on intents.** They have their own lifecycle, retrieval path, and security considerations.

2. **Artifact links are free-form, not foreign keys.** The codebase changes constantly. A file path from 6 months ago might not exist. The artifact reference is a search key, not a validated pointer.

3. **Negative signals are stored separately.** Different access patterns (bulk training reads vs operational queries), different retention policies, potentially different database.

4. **Audience compatibility > container-based scoping.** A memory from a private channel is private not because of the channel, but because of *who was in the room*. The scoping model checks membership compatibility, not just container matching.

5. **Capture everything, filter at retrieval.** Over-extraction is cheap. Under-extraction loses knowledge permanently. The recall ledger and reranker handle the "too many memories" problem at retrieval time, not at capture time.

---

## Research-Informed Design Updates

Key findings from deep research that directly affect implementation decisions.

### Retrieval Architecture (from retrieval research)

**Hybrid candidate generation is mandatory, not optional.** Pure cosine similarity produces false positives on entity names, project codes, and time-specific facts. BM25/lexical search catches what embeddings miss. Fuse with Reciprocal Rank Fusion (RRF) — parameter-light, proven across retrieval benchmarks.

Implementation: add a `tsvector` lexical search channel alongside pgvector cosine search. Run both in parallel, fuse results with RRF before reranking. PostgreSQL already supports both — no new infrastructure.

**Cross-encoder reranking is the right second stage at our scale.** ColBERT is overkill for tens of thousands of memories. LLM listwise reranking is too expensive/non-deterministic for a core cognition loop. A cross-encoder scoring (query + context, candidate) on the top 50-200 candidates is the sweet spot.

Implementation: Phase 5 reranker should be a cross-encoder (BGE reranker as initial teacher, distil to custom model as training data accumulates).

**Context features are not optional.** Generative Agents, MemoryBank, and H-MEM all show that recency, importance, and agent identity must be explicit scoring factors alongside semantic similarity. Make the scoring function: `score = f(query_text, conversation_state, agent_profile, memory_text, memory_metadata)`.

Implementation: add `last_accessed_at` and `access_count` columns to thoughts. Include recency decay and importance in the retrieval scoring function from Phase 1.

### Cold Start Strategy (from retrieval research)

**Bootstrap with synthetic queries.** Generate memory-seeking questions from each stored memory using doc2query/InPars approach. This creates initial training data without user feedback.

**Use off-the-shelf rerankers as teachers.** Before we have enough signal data, use BGE reranker or Cohere rerank API on top-k results. Collect teacher scores as pseudo-labels for later student model training.

**Hybrid retrieval is the cold start solution.** Combining lexical + semantic before any learned reranking already reduces the worst false positives.

### Negative Mining (from retrieval research)

**"Unused" is not "irrelevant".** The recall ledger must distinguish:
- `injected + referenced` = strong positive
- `injected + not referenced` = weak negative (may be relevant but unused due to prompt budget)
- `retrieved + not injected` = candidate negative (system filtered it)
- `not retrieved` = unlabelled (not negative)

**Position bias exists.** Top-ranked candidates are more likely to be used regardless of quality. Consider controlled randomisation of candidate ordering during data collection, or apply IPS weighting when training the reranker.

### Provenance Model (from reasoning research)

**Dual graph structure is research-validated.** 30 years of design rationale work converges on: you need both a *rationale structure graph* (issues, options, criteria, decisions) AND a *provenance graph* (derivation chains, source attribution, temporal ordering). Our ThoughtLink + ThoughtReasoning + thought_sources model covers both.

**Incremental formalisation, not push-button extraction.** Automated extraction should propose candidate nodes and relations. Treat LLM extraction as a drafting assistant, not the system of record. Design for human correction and progressive structuring.

**Artifact links must survive refactoring.** Store multiple anchors per artifact (file path + function name + commit range + test name). If one anchor breaks on rename, others can re-resolve. The `thought_artifacts` table should support multiple anchors per link.

Implementation: add `artifact_anchors JSONB` to `thought_artifacts` for storing multiple resolution paths.

### Security Model (from privacy research)

**Critical: our audience compatibility check has the directionality wrong.** The research confirms our approach is DLM-style "restriction" checking, but flags that the correct check is `Audience(current_channel) <= Audience(source_channel)` — everyone who can see the output was already in the source audience. NOT the reverse. Verify our `match_thoughts_scoped()` implements this correctly.

**Agent state isolation is mandatory.** If an agent reads confidential memories in one channel and later responds in another, it can leak via retained state even without re-retrieving. Agent instances must be isolated per context — no shared hidden state across channels.

**Embeddings are not safe representations.** Research shows 92% of 32-token inputs can be reconstructed from embeddings. Vector store compromise = data compromise. For production multi-tenant deployment, consider:
- Database-level encryption at rest
- Network isolation between tenant vector partitions
- Rate limiting on search endpoints to mitigate membership inference

**Automated sensitivity classification is defence-in-depth, not primary guardrail.** False negative rates of 1-14% depending on model. Use it to *tighten* labels (conservative direction), never to *loosen* them. Channel-level classification (marking a channel as confidential) is more reliable than per-message classification.

**Declassification must be explicit.** "Summarise management discussion into project update" is a declassification event. It must require explicit authority and be logged in the audit trail. The agent should never implicitly declassify by paraphrasing across channels.
