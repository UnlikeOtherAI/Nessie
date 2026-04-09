# Multi-Agent Memory System

Complete design document for Nessie's memory system — covering all memory types, retrieval strategies, feedback loops, and implementation priorities. This is the canonical reference that replaces ad-hoc notes and ChatGPT briefs.

Builds on:
- [memory-pipeline-design.md](memory-pipeline-design.md) — four-stage pipeline (extraction, assignment, storage, retrieval)
- [memory-reasoning-and-experience.md](memory-reasoning-and-experience.md) — reasoning model, outcome tracking, supersession chains
- [memory-security-and-scoping.md](memory-security-and-scoping.md) — multi-tenant visibility, org hard boundaries
- [research/memory-retrieval-and-reranking-in-multi-agent-systems.md](research/memory-retrieval-and-reranking-in-multi-agent-systems.md) — retrieval architectures, reranking, negative mining
- [research/reasoning-provenance-and-decision-traceability.md](research/reasoning-provenance-and-decision-traceability.md) — design rationale research
- [research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md](research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md) — embedding security, need-to-know
- [conversation-intelligence-platform.md](conversation-intelligence-platform.md) — § 6 Memory Capture pipeline feeds into this memory system

---

## Core Principle

Memory is not storage. It is **selection + usefulness**.

The problem is never "how do I store this." The problem is "how do I retrieve the right memory for the current context." Naive cosine similarity returns semantically similar results that are contextually useless — false positives, irrelevant recalls, token waste, worse reasoning.

The system must:
1. Store structured memory types (not flat blobs)
2. Retrieve and rerank based on context, not just similarity
3. Learn what actually worked via feedback loops
4. Improve retrieval quality over time

---

## Memory Types

Seven memory types mapped from human cognition to AI implementation. Each type has a different storage strategy, retrieval pattern, and evaluation metric.

### Taxonomy

The seven types exist at different implementation stages:

| Memory Type | Status | Storage | Notes |
|---|---|---|---|
| Working | Implicit | Context window | Not persisted — always exists |
| Semantic | **Implemented** | `thoughts` table (memory_type: intent, reason, constraint, preference, fact) | Full hybrid search |
| Reasoning | **Implemented** | `thought_reasonings` linked to thoughts | Structured alternatives/criteria/outcome |
| Episodic | Partial | `thoughts` (target: memory_type = 'experience') | Reasoning+outcome exists, situation embedding missing |
| Procedural | **Not started** | `thoughts` (target: memory_type = 'procedure') | Highest ROI gap |
| Framing | **Not started** | `thoughts` (target: memory_type = 'framing') | Cold-start elimination |
| Personalization | **Future** | Separate user parameter store | Not in `thoughts` table |

The `memory_type` column currently supports: `intent`, `reason`, `constraint`, `preference`, `fact`. Target additions: `procedure`, `framing`, `experience`. These require a schema migration to extend the enum.

**Naming clarification** — "Reason" is overloaded in these docs:
- `memory_type = 'reason'` — a stored semantic thought categorized as a reason/rationale
- `ThoughtReasoning` — a structured record (alternatives, criteria, constraints, outcome) attached to any thought
- `thought_artifacts` — artifact-linked reason lookup ("why does this file exist?")
These are three different entities. `ReasonMemory` = semantic thought, `ThoughtReasoning` = structured rationale, `ArtifactReason` = artifact-linked lookup.

### 1. Working Memory (Context Window)

**What it is**: The current conversation context and active task state.

**Implementation**: The LLM's context window. No embedding, no persistence. This is whatever the agent is currently holding in its prompt.

**What we have**: This exists implicitly in every agent run. The orchestrator maintains `OrchestratorState` with `messages[]` per thread.

**What we need**: Nothing new. Working memory is the context window. The only design decision is what gets injected into it from other memory types.

**Evaluation**: Coherence within a conversation, task continuity across turns.

---

### 2. Semantic Memory (Long-Term Knowledge)

**What it is**: Facts, knowledge, patterns, decisions. "What was decided, what exists, what happened."

**Implementation**: Chunked content with embeddings stored in pgvector. Retrieved via hybrid search (semantic + lexical + RRF fusion).

**What we have** (implemented):
- `thoughts` table with 1536-dim embeddings (OpenAI `text-embedding-3-small`)
- `search_vector` tsvector column for full-text search
- Three retrieval modes: semantic (`match_thoughts_scoped`), lexical (`match_thoughts_lexical`), hybrid (`match_thoughts_hybrid`) with Reciprocal Rank Fusion and recency decay
- HNSW index (m=16, ef_construction=64) for vector similarity
- GIN index for full-text search
- Deduplication via SHA-256 content fingerprint
- Multi-tenant scoping with org hard boundary
- Visibility levels: private, channel, team, project, organization
- Sensitivity tiers: normal, sensitive, restricted
- `memory_type` column: intent, reason, constraint, preference, fact
- `thought_artifacts` for artifact-linked reasons — **designed but not yet in migrations**. The table schema exists in docs but has not been created in the database.
- `thought_links` for supersession chains (supersedes, derived_from, contradicts, supports, relates_to)
- Metadata extraction via LLM (`gpt-4o-mini`)

**What we need**: 
- Create `thought_artifacts` table and migration
- Implement artifact-referenced search
- Add audience compatibility checks to search functions (see Security section)

See `packages/memory/src/search.ts` and `packages/memory/src/capture.ts`.

**Evaluation**: Precision@K, hallucination reduction, correct information retrieval rate.

---

### 3. Reasoning Memory

**What it is**: Why decisions were made. Structured records of alternatives considered, criteria applied, constraints acknowledged, and outcomes observed.

**Implementation**: Structured records linked to thoughts with full lifecycle tracking.

**What we have** (implemented):
- `thought_reasonings` table with:
  - `reasoning_type`: decision, evaluation, constraint, pattern, correction, validation
  - `alternatives`: JSON array of options considered
  - `criteria`: JSON array of evaluation criteria
  - `constraints`: JSON array of external limitations
  - `tradeoffs`: text explanation of tradeoffs
  - `confidence`: 0.0-1.0 float
  - `reasoning`: text explanation
  - `actor_type` / `actor_id`: who contributed (user, agent, service)
  - `outcome`: pending, successful, partially, failed, superseded
  - `outcome_notes` / `outcome_at`: result tracking
- Multi-actor reasoning chains (user proposes, agent evaluates, another agent validates)
- Reasoning extraction via LLM (`gpt-4o-mini`) in `packages/memory/src/extract-reasoning.ts`
- Outcome tracking via `recordOutcome()` in `packages/memory/src/lifecycle.ts`

**What we need**: This is more sophisticated than most memory systems. The existing implementation covers reasoning memory. The remaining work is connecting outcome signals back to retrieval quality (Phase 4-5 in the pipeline design).

**Evaluation**: Consistency of decisions over time, reduced contradictions, alignment with past logic.

---

### 4. Episodic Memory (Experience)

**What it is**: "What happened before" — past interactions, decisions, and their outcomes as structured experiences. Not raw logs, but compressed situation-action-outcome triples.

**Implementation**: Stored as structured records with embeddings for situation matching.

**What we have** (partial):
- `thought_reasonings` with outcome tracking captures the action-outcome pair
- `thought_links` with `supersedes` / `contradicts` track decision evolution
- `thought_recalls` log retrieval events with session context
- `getExperienceStats()` in `packages/memory/src/lifecycle.ts` aggregates experience data

**What we need** (gap):
- No explicit episodic memory type. The current system stores decisions and reasons but doesn't store compressed experiences as first-class entities.
- The situation-action-outcome triple is spread across multiple tables rather than being a queryable unit.
- No "similar situation" retrieval — the system can find similar topics but not similar situations.

**Proposed structure**:

```json
{
  "situation": {
    "summary": "User asked to debug failing API endpoint",
    "task_type": "debugging",
    "symptoms": ["HTTP 500 on /api/users", "connection pool exhaustion in logs"],
    "artifacts": ["src/middleware/db-pool.ts", "api/src/routes/users.ts"],
    "environment": ["postgres", "api worker", "production"],
    "constraints": ["production incident — no downtime allowed"],
    "initial_hypotheses": ["connection leak", "query timeout"]
  },
  "action": {
    "summary": "Identified connection leak in middleware, added connection release in error handler",
    "key_steps": ["Read logs", "Checked pg_stat_activity", "Grepped for pool.connect", "Found missing release in error path"],
    "tools_used": ["Bash", "FileRead", "Grep", "FileWrite"]
  },
  "outcome": "successful",
  "duration_seconds": 340,
  "lessons": "Always check error handlers for resource cleanup — happy path may work but error path leaks"
}
```

**Priority**: Medium. The existing reasoning + outcome tracking covers 70% of this. The remaining gap is the compressed situation embedding for "have I seen this before?" retrieval. This can be built on top of the existing `thoughts` table with `memory_type = 'experience'`.

**Situation embedding**: The `situation.summary` is embedded for primary retrieval. Additionally, structured fields (`task_type`, `symptoms`, `environment`) are rendered as text and concatenated for a richer embedding that captures structural similarity, not just semantic similarity. This is what differentiates episodic from semantic memory — similar situations share structure, not just topic.

**Evaluation**: Did similar situations retrieve relevant experiences? Did it improve decision-making speed?

---

### 5. Procedural Memory (How-To) — PRIORITY: HIGH

**What it is**: "How to do things" — actionable, ordered steps that an agent discovered work for a specific type of task. Not embeddings-first. Structured + executable.

**What we have**: Nothing. This is the biggest gap.

Currently, when an agent figures out how to navigate a codebase, deploy a service, debug a pattern, or configure a system — that knowledge evaporates. Next run, it starts from scratch. Every agent run that involves exploration is wasted work unless the procedure is captured.

**Why this matters most**: Procedural memory has the highest ROI of any memory type. It directly reduces:
- Time to complete recurring tasks
- Token cost (fewer exploration steps)
- Error rate (proven procedures vs. trial-and-error)
- Agent "stupidity" (the same agent that solved a problem yesterday shouldn't be clueless about it today)

**Proposed structure**:

```json
{
  "memory_type": "procedure",
  "task_pattern": "debug failing API endpoint",
  "trigger_conditions": [
    "HTTP 500 error",
    "API endpoint not responding",
    "service returning errors"
  ],
  "steps": [
    {
      "order": 1,
      "action": "Check service logs for error details",
      "tool": "Bash",
      "command_template": "docker logs {service_name} --tail 100 | grep -i error",
      "expected_outcome": "Identify the specific error type"
    },
    {
      "order": 2,
      "action": "Check database connection pool",
      "tool": "Bash",
      "command_template": "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'",
      "expected_outcome": "Connection count within normal range"
    },
    {
      "order": 3,
      "action": "If connection leak, find unclosed connections in code",
      "tool": "Grep",
      "command_template": "pattern: 'pool\\.connect|getConnection' in src/",
      "expected_outcome": "List of connection acquisition points"
    }
  ],
  "confidence": 0.85,
  "success_count": 3,
  "failure_count": 0,
  "last_used_at": "2026-04-09T...",
  "average_duration_seconds": 280,
  "domain": "backend-debugging",
  "project_id": "...",
  "preconditions": [
    "Service is running in Docker",
    "Agent has Bash access",
    "PostgreSQL is the database"
  ],
  "failure_modes": [
    "Connection pool not managed by middleware (direct connections)",
    "Error is not connection-related despite similar symptoms"
  ],
  "do_not_use_when": [
    "Database is not PostgreSQL",
    "Service runs without connection pooling"
  ],
  "verification": {
    "method": "Check pg_stat_activity count returns to baseline",
    "tool": "Bash"
  },
  "source_run_id": "uuid-of-originating-run",
  "supporting_tool_call_ids": ["uuid-1", "uuid-2"],
  "review_status": "unreviewed"
}
```

**Storage**: In the `thoughts` table with `memory_type = 'procedure'`. Steps stored in `metadata` JSONB. Trigger conditions embedded for semantic matching. The structured steps are NOT embedded — they are stored as structured data and retrieved after the thought is matched.

**Retrieval pattern**:
1. Agent starts a task
2. Task description is embedded
3. Search `thoughts` where `memory_type = 'procedure'` with semantic similarity on trigger conditions
4. If match found with confidence above threshold, inject procedure into working memory
5. Agent follows or adapts the procedure
6. After completion, update confidence and success/failure counts

**Capture pattern**:
1. Agent completes a multi-step task successfully
2. Self-eval step (see section 9) identifies that a reusable procedure was discovered
3. System generates a procedural memory from the task's tool call history
4. Extraction prompt compresses raw tool calls into generalized steps
5. Stored with trigger conditions derived from the original task description

**Lifecycle**:
- Confidence increases with successful reuse, decreases with failures
- Steps can be refined based on variations across uses
- Superseded by newer procedures via `thought_links` (SUPERSEDES relation)
- Pruned if confidence drops below threshold after N uses

**Generalization challenge**: The hardest part of procedural capture is abstraction. Raw tool calls contain project-specific values (`docker logs my-service-abc`) that must be generalized (`docker logs {service_name}`) without losing critical context. The extraction prompt must:
1. Identify values that are instance-specific vs. pattern-essential
2. Parameterize instance-specific values with descriptive names
3. Preserve environmental constraints (OS, database type, framework)
4. Include verification steps (how to confirm the procedure worked)
5. Attach contraindications (when NOT to use this procedure)

A one-off success should NOT become a reusable procedure. Minimum threshold: the procedure must succeed at least twice across different runs before it is considered reliable. Until then, `review_status = 'unreviewed'` and `confidence` starts at 0.3.

**Evaluation**:
- Task success rate (with vs. without procedural memory)
- Time saved (duration comparison)
- Reduced exploration steps (tool call count comparison)
- Agent self-reported usefulness in self-eval

---

### 6. Framing Memory (Cold-Start Elimination) — PRIORITY: HIGH

**What it is**: "Where should I start?" — initial understanding of a task domain, system, or project. Entry points, navigation strategies, key files, mental models. Bootstrapping intelligence that eliminates the expensive orientation phase every agent run currently pays.

**What we have**: Nothing. Every agent run that touches a new domain or project starts with blind exploration.

**The problem**: The first 30-60 seconds of any agent task is orientation — reading files, understanding structure, figuring out where things are. This is pure waste on the second and subsequent runs. Framing memory captures what the agent learned during orientation so the next run skips straight to productive work.

**Proposed structure**:

```json
{
  "memory_type": "framing",
  "domain": "nessie-api",
  "scope": {
    "project_id": "...",
    "subdomain": "memory-system"
  },
  "entry_points": [
    {
      "path": "packages/memory/src/index.ts",
      "role": "Public API — all exports for the memory package"
    },
    {
      "path": "api/src/services/thoughts.ts",
      "role": "Service facade — API layer calls into memory package through this"
    },
    {
      "path": "api/prisma/schema.prisma",
      "role": "Schema definition — Thought, ThoughtReasoning, ThoughtLink models"
    }
  ],
  "navigation_strategy": "Start from the service layer (thoughts.ts), trace down into packages/memory for implementation, up into api/src/index.ts for route definitions",
  "key_patterns": [
    "Memory package uses raw SQL via pg client, not Prisma, for vector operations",
    "All search functions require organization_id — hard multi-tenant boundary",
    "Extraction uses gpt-4o-mini via ModelClient, not direct OpenAI calls"
  ],
  "gotchas": [
    "Vector columns are not in Prisma schema — managed via raw SQL migrations",
    "search_vector is a GENERATED column — do not try to write to it directly"
  ],
  "confidence": 0.9,
  "last_validated_at": "2026-04-09T...",
  "created_from_session": "session-id-here"
}
```

**Storage**: In the `thoughts` table with `memory_type = 'framing'`. Structured data in `metadata` JSONB. The `content` field holds a natural-language summary that gets embedded for retrieval.

**Retrieval pattern**:
1. Agent starts a new session or task
2. Task description + project context is embedded
3. Search `thoughts` where `memory_type = 'framing'` scoped to the project/domain
4. If match found, inject framing into working memory as system context
5. Agent skips exploration and starts from the known entry points

**Capture pattern**:
1. Agent completes a task that required significant exploration (high tool call count relative to task complexity)
2. Self-eval step identifies that the agent spent time orienting
3. System generates framing memory from the exploration pattern:
   - Which files were read first?
   - What turned out to be the actual entry points?
   - What patterns were discovered?
   - What dead ends were hit?
4. Stored with domain/project scope

**Evolution**:
1. First run in a domain: explore everything, generate framing memory
2. Second run: load framing, skip to productive work
3. Subsequent runs: validate and refine framing (files may have moved, patterns may have changed)
4. Staleness check: if `last_validated_at` is older than N days, re-validate entry points before trusting

**Validation**: Framing memories can become harmful even when all referenced files still exist — entry points may no longer own the behavior, patterns may be deprecated, navigation strategies may optimize for old architecture.

Validation levels:
1. **Existence check** (fast, always): Do referenced files exist?
2. **Pattern check** (moderate, on load): Do key patterns still appear via targeted grep?
3. **Recency check** (moderate, on load): Have the referenced files changed since `last_validated_at`? If yes, the framing may be stale.
4. **Structural check** (expensive, periodic): Run a lightweight exploration of the domain and compare against the framing. Major divergence triggers re-generation.

Framing metadata must include:
- `validated_against_commit` — git SHA at last validation
- `last_validated_at` — timestamp
- `validation_method` — which level was last applied
- `staleness_score` — 0.0 (fresh) to 1.0 (likely stale), computed from file change rate and time since validation
- `invalidated_by` — if manually or automatically invalidated, who/what

If `staleness_score > 0.7`, the framing is injected with a warning: "This framing may be outdated. Verify entry points before relying on them."
If `staleness_score > 0.9`, the framing is not injected and a re-exploration is triggered.

**Evaluation**:
- Time to first useful action (with vs. without framing)
- Reduction in exploration tool calls
- Agent self-reported framing quality in self-eval

---

### 7. Personalization Memory (User Model) — PRIORITY: FUTURE

**What it is**: How a specific user prefers interaction. Not just tone preferences — understanding communication patterns, stress levels, working styles, and adapting accordingly.

**Why it matters even in a workplace**: People under pressure communicate differently. A stressed user sending terse messages with exclamation marks needs different handling than a relaxed user writing detailed requests. Difficult stakeholders, high-pressure environments, cross-cultural teams — personalization helps agents navigate all of these. An agent that adapts to communication style reduces friction, misunderstandings, and wasted cycles.

**Implementation approach**: Two layers.

**Global model** (patterns that apply across users):
- Busy / stressed signals → concise responses, skip pleasantries, front-load answers
- Relaxed / exploratory signals → more detail, suggestions, context
- Time of day patterns → morning = brief, afternoon = verbose
- Calendar density → many meetings = async-friendly, few meetings = available for back-and-forth

**Per-user model** (learned from individual behavior):

Signals (all implicit, no forms):
- Message length (short = wants brevity)
- Response latency (fast replies = engaged, slow = context-switching)
- Tone markers (exclamation marks, caps, short sentences = urgency/frustration)
- Correction frequency (frequent corrections = needs more confirmation steps)
- Question patterns (asks "why" often = wants reasoning, asks "how" = wants steps)

Output parameters:

```json
{
  "user_id": "...",
  "verbosity": 0.3,
  "directness": 0.9,
  "reasoning_depth": 0.7,
  "confirmation_frequency": 0.4,
  "preferred_response_format": "bullet_points",
  "stress_indicators": {
    "current_level": "elevated",
    "signals": ["short_messages", "fast_replies", "imperative_tone"]
  },
  "last_updated_at": "..."
}
```

**Storage**: Separate from the `thoughts` table. This is a parameter store on the user record, updated incrementally. Not embedding-based — it's a structured model.

**Capture**: Background analysis of message patterns over time. No single-message extraction. Updated after every N interactions or significant behavior shift.

**Consent and Risk**: Personalization involves behavioral profiling, which is sensitive:
- Users must be informed that communication style adaptation is active (settings page, not buried in ToS)
- Users can opt out entirely — disable personalization for their account
- Users can view their personalization model and correct it
- `stress_indicators` are particularly sensitive — they must NEVER be surfaced to managers, used in performance reviews, or shared outside the agent-user interaction
- Personalization affects response STYLE only, never response CONTENT or decision-making
- Retention: personalization models are deleted when a user leaves the organization
- Audit: every personalization model update is logged with the triggering signal

**Evaluation**:
- Reduced corrections from user
- Reduced friction (fewer "that's not what I meant" cycles)
- Increased task completion rate
- User engagement signals (response time, message length, conversation length)

**Implementation timeline**: After procedural + framing + self-eval are solid. This is a nice-to-have that improves quality of life but doesn't block core functionality.

---

## Retrieval Architecture

### Current State (Implemented)

Three-mode retrieval with fusion:

```
Query
  ├── Semantic Search (pgvector cosine similarity, HNSW index)
  ├── Lexical Search (tsvector full-text, GIN index, BM25 ranking)
  └── Hybrid (both in parallel + RRF fusion + recency decay)
```

Scoping applied at query time:
- Organization hard boundary (required)
- Visibility level check (private/channel/team/project/org)
- Sensitivity tier filtering
- Audience compatibility: A memory can be surfaced into output audience B ONLY IF every member of B was a member of the source audience A. The rule is `Audience(current_channel) ⊆ Audience(source_channel)` — the current audience must be equal to or a subset of the original audience. Surfacing a memory into a LARGER audience is information leakage and is blocked. Surfacing into a SMALLER audience (subset) is safe.
  - Example: A memory from a 5-person #core-team channel CAN be surfaced in a 3-person #core-leads channel if all 3 leads are members of #core-team
  - Example: A memory from a 3-person #core-leads channel CANNOT be surfaced in a 10-person #engineering channel — 7 members of #engineering were not in the original audience
  - Exception: An explicit declassification record can override this check (see Declassification below)

### Retrieval by Memory Type

| Memory Type | Primary Retrieval | Secondary |
|---|---|---|
| Semantic (Intent) | Hybrid search on content embedding | Recency + frequency boost |
| Semantic (Reason) | Artifact-referenced search on `thought_artifacts` | Fall back to content embedding |
| Reasoning | Linked from parent thought via `thought_reasonings` FK | Direct search if standalone |
| Episodic | Situation embedding similarity | Outcome-weighted ranking |
| Procedural | Trigger condition matching + task description similarity | Confidence + success rate ranking |
| Framing | Domain/project scope match + task type similarity | Staleness check before injection |
| Personalization | Direct user_id lookup | No search needed — parameter store |

### Retrieval Pipeline (Target Architecture)

```
Agent starts task
  │
  ├── 1. Load framing memory (if exists for domain/project)
  │     └── Validate entry points still exist
  │
  ├── 2. Search procedural memory (match task description to trigger conditions)
  │     └── If found, inject as suggested approach
  │
  ├── 3. Load personalization model (for the interacting user)
  │     └── Adjust response style parameters
  │
  └── During task execution:
        │
        ├── 4. On-demand semantic search (when agent needs facts/context)
        │     └── Hybrid search with RRF + reranking
        │
        ├── 5. Artifact lookup (when "why does X exist?" pattern detected)
        │     └── thought_artifacts search
        │
        └── 6. Experience recall (when agent encounters similar situation)
              └── Episodic memory search on situation embedding
```

### Reranking Roadmap

**Phase 1 (current)**: Heuristic reranking
- Recency decay
- Frequency boost (access_count)
- Past usefulness (was_referenced history)

**Phase 2 (planned — Phase 4 of pipeline design)**: Signal collection
- Convert recall ledger data to training signals
- Positive: referenced memories
- Negative: injected but not referenced
- Hard negative: user-flagged harmful

**Phase 3 (planned — Phase 5 of pipeline design)**: Learned reranker

Two architecture options (decision deferred until sufficient training data):

**Option A: Cross-encoder** (higher quality, higher latency)
- Input: query TEXT + candidate memory TEXT + metadata (type, age, confidence, scope)
- Model: Fine-tuned small cross-encoder (e.g., MiniLM-L6 or similar, ~25M params)
- Output: relevance probability 0.0–1.0
- Latency: ~10ms per candidate, applied to top-20 candidates from initial search
- Training: Positive pairs from `positive_explicit` + `positive_cited` signals. Negatives from `negative_harmful` + random sampling. Minimum 10K labeled pairs before training.

**Option B: Feature ranker** (lower quality, lower latency, simpler)
- Input: Numeric features derived from retrieval (similarity_score, recency, access_count, confidence, memory_type, scope_match)
- Model: LambdaMART or XGBoost
- Output: relevance score
- Latency: <1ms per candidate
- Training: Same signal data, feature-engineered

**Requirements before either option:**
- Minimum 10K recall events with labels (estimated: ~3 months of production usage)
- Offline evaluation set: 500 hand-labeled query-memory pairs
- Debiasing: Adjust for position bias (memories injected first are more likely referenced)
- Cold-start: Until the reranker is trained, use heuristic ranking (current Phase 1)
- A/B framework: Compare reranker vs heuristic on held-out traffic

---

## Self-Evaluation Loop — PRIORITY: HIGH

### The Problem

The current recall ledger passively tracks what was referenced. It answers "what did the agent use?" but not "what should have been available but wasn't?" The passive approach gives signal on retrieval quality but misses the most valuable signal: **what's missing from memory.**

### Active Self-Eval Step

After each agent run, inject a hidden evaluation prompt that produces structured feedback:

```json
{
  "session_id": "...",
  "task_summary": "Debugged failing API endpoint, found connection pool leak",
  "used_memories": [
    {
      "thought_id": "uuid-123",
      "impact": "high",
      "note": "Knew about connection pool config from prior debugging session"
    },
    {
      "thought_id": "uuid-456",
      "impact": "low",
      "note": "Retrieved but not relevant to this specific error"
    }
  ],
  "missing_memories": [
    {
      "description": "No memory of the connection pool middleware pattern in this codebase",
      "would_have_helped": "Could have skipped 5 minutes of exploration to find the middleware",
      "suggested_type": "framing"
    },
    {
      "description": "No procedure for debugging connection pool issues",
      "would_have_helped": "Could have gone straight to pg_stat_activity check",
      "suggested_type": "procedure"
    }
  ],
  "new_procedural": {
    "should_capture": true,
    "task_pattern": "debug connection pool exhaustion",
    "key_steps": [
      "Check pg_stat_activity for connection count",
      "Find connection acquisition points with grep",
      "Trace error handler for missing connection.release()"
    ]
  },
  "framing_update": {
    "should_update": true,
    "new_entry_point": "src/middleware/db-pool.ts",
    "new_pattern": "Connection pool middleware wraps every request handler"
  },
  "task_success": true,
  "confidence": 0.9
}
```

### Self-Eval Output Schema (Enforceable)

The self-eval output must be validated against a Zod schema. Invalid output is discarded, not stored.

Validation rules:
- `used_memories[].thought_id` must match actual `thought_recalls` rows from this run (rejects hallucinated IDs)
- `impact` must be one of: `high`, `medium`, `low`, `none`
- `missing_memories[].suggested_type` must be one of: `procedure`, `framing`, `semantic`, `experience`
- `confidence` must be 0.0–1.0
- `task_success` is informational only — the authoritative success signal comes from the critic/evaluation loop
- If the model returns invalid JSON or fails validation, the self-eval is skipped for this run (logged, not retried)

### Self-Eval Flow

```
Agent completes task
  │
  ├── 1. Generate self-eval (hidden LLM call)
  │     Input: task description, tool call history, recalled memories, outcome
  │     Output: structured eval (above)
  │
  ├── 2. Update recall signals
  │     For each used_memory: update thought_recalls with impact score
  │     For each unused recalled memory: mark as negative signal
  │
  ├── 3. Process missing memories
  │     For each missing_memory:
  │       - If suggested_type = 'procedure': trigger procedural capture
  │       - If suggested_type = 'framing': trigger framing update
  │       - If suggested_type = 'semantic': flag for human review or auto-capture
  │
  ├── 4. Capture new procedural memory (if new_procedural.should_capture)
  │     Compress tool call history into generalized steps
  │     Store as thought with memory_type = 'procedure'
  │
  └── 5. Update framing memory (if framing_update.should_update)
        Add new entry points / patterns to existing framing
        Bump last_validated_at
```

### Cost Control

The self-eval LLM call adds cost. Mitigations:
- Use a cheap model (`gpt-4o-mini` or equivalent) — this is classification, not reasoning
- Only run self-eval on tasks that took more than N tool calls (skip trivial tasks)
- Batch self-evals for tasks within the same session
- Cap self-eval prompt size — summarize tool call history, don't include raw output

### Cost Envelope

Assumptions for budgeting:
- Average tasks per org per day: 100
- Self-eval eligibility (> N tool calls): ~40% of tasks
- Self-eval model: gpt-4o-mini (~$0.15/1M input, ~$0.60/1M output)
- Average self-eval input: ~2000 tokens (summarized history + recalled memories)
- Average self-eval output: ~500 tokens
- Cost per self-eval: ~$0.0006
- Daily cost per org (40 evals): ~$0.024
- Monthly cost per org: ~$0.72

**Degradation mode**: When monthly self-eval budget is exhausted:
- Stop running self-eval on `background` priority tasks
- Continue on `critical` and `normal` tasks only
- Log skipped evaluations for later batch processing

**Sampling policy by role**:
- `builder` agents: always evaluate (highest value)
- `researcher` agents: evaluate 50% (moderate value)
- `assistant` agents: evaluate 25% (lower value)
- `watcher` agents: never evaluate (monitoring only)

### What This Enables

The self-eval is the **growth engine** — but it is model output, not ground truth. Self-eval signals are WEAK until validated by outcomes (task success, user feedback, procedure reuse). Treat self-eval as a drafting assistant, not an oracle:
- **Procedural memory grows organically** — every successful multi-step task can become a procedure
- **Framing memory stays current** — entry points and patterns are validated and updated
- **Retrieval quality improves** — missing memory signals identify what to capture next
- **Negative signals are captured** — irrelevant retrievals get flagged without user intervention
- **No user feedback forms needed** — the system evaluates itself

---

## Feedback System

### Signal Sources (Ranked by Reliability)

1. **User explicit signal** (strongest): User flags memory as helpful/irrelevant/harmful via UI thumbs up/down
2. **Agent self-eval** (strong): Structured eval after task completion (see above)
3. **Reference tracking** (moderate, multi-source):
   - `referenced_by_phrase`: String/phrase match between memory content and response (current implementation — noisy)
   - `referenced_by_self_report`: Agent's self-eval explicitly lists the memory as used (stronger but model-dependent)
   - `reference_confidence`: Composite score (0.0–1.0) combining both signals
   - Known limitations: Phrase matching has false positives (common domain language) and false negatives (paraphrasing). Self-report has hallucination risk. Neither alone is reliable training signal.
4. **Injection tracking** (weak): `was_injected` — was the memory put into context?
5. **Session outcome** (contextual): Did the task succeed or fail? All recalled memories get associated signal.
6. **Access patterns** (ambient): `access_count` and `last_accessed_at` — frequently accessed memories are likely useful

### Signal Flow

```
Signal sources
  │
  ├── thought_recalls (operational — every retrieval event)
  │     Fields: thought_id, session_id, query, similarity, rank, was_injected, was_referenced, user_signal
  │
  ├── Self-eval output (per task)
  │     Fields: used_memories with impact, missing_memories, task_success
  │
  └── Aggregated into recall_training_signals (batch — for reranker training)
        Fields: query, thought_id, similarity, signal (positive/negative_ignored/negative_unhelpful/negative_harmful)
```

### Signal Aggregation Rules

```
For each recall event:

  # Strong positive signals
  if user_signal = 'helpful':
    signal = 'positive_explicit' (confidence: 0.95)
  if referenced_by_self_report AND referenced_by_phrase:
    signal = 'positive_cited' (confidence: 0.85)
  if was_referenced AND task_success:
    signal = 'positive_outcome_correlated' (confidence: 0.6)

  # Neutral signals (DO NOT use as training negatives)
  if was_injected AND NOT was_referenced AND another_memory_covers_same_topic:
    signal = 'neutral_redundant' (confidence: 0.3)
  if was_injected AND NOT was_referenced AND prompt_budget_exceeded:
    signal = 'neutral_budget' (confidence: 0.2)
  if NOT was_injected:
    signal = 'neutral_filtered' (confidence: 0.1) — system excluded it, not agent

  # Negative signals
  if user_signal = 'harmful':
    signal = 'negative_harmful' (confidence: 0.95)
  if was_injected AND NOT was_referenced AND task_failed:
    signal = 'negative_unhelpful' (confidence: 0.5)
  if scope_mismatch_detected:
    signal = 'negative_wrong_scope' (confidence: 0.9)
  if memory_superseded_since_retrieval:
    signal = 'negative_stale' (confidence: 0.8)
```

Key principle: **"Unused" is NOT the same as "irrelevant."** Position bias, prompt budget, redundancy, and paraphrasing all cause useful memories to appear unused. Only negative signals with strong evidence should be used for training.

Training data rows include: `label`, `label_confidence`, `label_source`, `exposure_rank` (position in prompt), `injected_position`, `prompt_tokens_visible`, `verifier_version`.

### Adversarial Feedback Model

The feedback loop assumes honest signals. In a multi-tenant system, that assumption fails.

**Attack paths:**
- User repeatedly flags poisoned memory as helpful → inflates importance
- User crafts prompts to trigger phrase matching on specific memories → fabricates positive signal
- Agent self-eval hallucinates a procedure from one success → bad procedure enters the system
- Compromised channel creates high-confidence procedures shared across agents → lateral contamination
- Negative feedback weaponized to suppress true but inconvenient memories

**Mitigations:**
- **Rate limiting**: Max N feedback signals per user per day per memory
- **Anomaly detection**: Flag memories whose signal pattern deviates significantly from similar memories
- **Actor trust**: Weight signals by actor history (new users / recently created agents have lower weight)
- **Label provenance**: Every training label tracks source (user, self-eval, phrase_match) — tainted sources can be excluded
- **Promotion gates**: Procedural memories need ≥2 independent successes before promotion eligibility. A single run, no matter how confident, is insufficient.
- **Moderation queue**: Memories flagged for org-wide promotion go through human review

### What Feedback Drives

- **Memory boosting**: High-signal memories get importance score bumped
- **Memory pruning**: Consistently ignored memories get importance score lowered
- **Retrieval tuning**: Training data for future reranker
- **Procedural refinement**: Failed procedures get steps adjusted
- **Framing validation**: Stale framing gets flagged for re-exploration

---

## Storage Strategy

### What to Store

- Decisions and their reasoning
- Patterns discovered during work
- Procedures that worked
- Domain framing and entry points
- Strong signals (corrections, surprises, failures)
- Compressed experiences (situation-action-outcome)

### What NOT to Store

- Raw conversation logs (long-term) — they are in message history already
- Noise and repetition — dedup via SHA-256 fingerprint
- Trivial facts derivable from the codebase — `git log` and file reads are authoritative
- Ephemeral task state — that's working memory

### Storage Format by Type

| Memory Type | Primary Storage | Embedding | Structured Data |
|---|---|---|---|
| Semantic (Intent) | `thoughts` table | Content embedding (1536-dim) | Metadata JSONB |
| Semantic (Reason) | `thoughts` + `thought_artifacts` | Content + artifact embeddings | Artifact refs |
| Reasoning | `thought_reasonings` | Via parent thought | Alternatives, criteria, constraints, outcome |
| Episodic | `thoughts` (memory_type = 'experience') | Situation embedding | Action, outcome, tools_used |
| Procedural | `thoughts` (memory_type = 'procedure') | Trigger condition embedding | Steps array, confidence, success/failure counts |
| Framing | `thoughts` (memory_type = 'framing') | Domain description embedding | Entry points, patterns, gotchas |
| Personalization | User record (separate) | None | Parameter store (verbosity, directness, etc.) |

### Volume Policy

**Ingestion policy**: Process every eligible conversation turn through the extraction classifier. The classifier decides what is worth persisting — not everything is.

**Persistence filters**: Only store compressed, scoped, typed memory records that pass:
1. Novelty check (SHA-256 dedup against existing content)
2. Type classification (must map to a known memory_type)
3. Minimum signal threshold (corrections, decisions, and procedures always pass; trivial acknowledgments do not)
4. Scope assignment (must have a valid org + visibility level)

**Cost reality**: "Storage is cheap" is misleading. Each stored memory costs:
- Embedding generation (~$0.00002 per 1K tokens via text-embedding-3-small)
- Vector storage + HNSW index maintenance
- Lexical index (GIN) growth
- Backup size increase
- Search candidate noise (more memories = more false positives in retrieval)
- Privacy exposure surface
- Recall ledger growth (every search that considers this memory logs a row)

Pruning and decay (see Memory Lifecycle below) are essential, not optional.

---

## Memory Lifecycle

Memories are not permanent. They have a lifecycle:

```
created → active → stale → deprecated → archived → deleted
                     │
                     └→ superseded (via thought_links SUPERSEDES)
```

### Decay Rules

| Memory Type | Decay Trigger | Action |
|---|---|---|
| Semantic | No access in 90 days + confidence < 0.3 | Mark `stale` |
| Procedural | 3 consecutive failures | Mark `deprecated`, flag for review |
| Framing | `staleness_score > 0.9` | Mark `stale`, trigger re-exploration |
| Episodic | No retrieval in 180 days | Mark `stale` |
| Reasoning | Linked thought is deprecated/deleted | Mark `stale` |

### Garbage Collection

A background job runs daily:
1. `stale` memories with no access for 30 additional days → `archived`
2. `archived` memories with no references (no thought_links, no skill source) → soft `deleted`
3. `deleted` memories are physically removed after 90-day grace period (for regulatory holds)
4. `thought_recalls` rows older than 90 days are aggregated into `recall_training_signals` then purged

### Conflict Resolution

When the system detects contradictory memories (via `thought_links` CONTRADICTS relation):
1. Both memories are retrieved with conflict context: "Note: this memory contradicts [other memory]"
2. The agent must acknowledge the conflict in its response
3. Resolution options:
   - Newer memory supersedes older (automatic if confidence difference > 0.3)
   - Human curator resolves (flagged in curation queue)
   - Both retained with conflict marker (for genuinely contested knowledge)
4. An agent CANNOT silently store a contradictory memory and outrank a true one — the CONTRADICTS link triggers review.

### Memory Inheritance (Agent Cloning/Forking)

When a child agent is spawned or an agent is cloned:
- **Inherited-read**: Child can read parent's project/org-scoped memories (no copy)
- **Copied**: Framing memories for the relevant domain are copied to the child's scope
- **Excluded**: Parent's private/channel-scoped memories are NOT visible to the child
- **Promoted**: If a child discovers a procedure, it's captured in the child's scope. Promotion to parent scope requires review.

### Declassification

Memory-derived content can escape its original audience through summaries, agent configs, skills, and procedures. Every scope widening is a declassification event:

```
declassification_events
  id               UUID PK
  source_scope     JSONB — { type: "channel", id: "uuid" }
  target_scope     JSONB — { type: "project", id: "uuid" }
  actor_id         UUID — user or agent who authorized
  authority         TEXT — "org_admin", "channel_owner", "automated_promotion"
  source_memory_ids UUID[] — memories being declassified
  derived_artifact_id UUID — skill, agent config, or summary that received the content
  justification    TEXT
  approved_at      TIMESTAMPTZ
  created_at       TIMESTAMPTZ
```

Rules:
- Procedural memory → skill promotion = declassification (channel scope → org scope)
- Memory content embedded in agent system prompt = declassification
- Memory-informed summary shared to wider audience = declassification
- Each event requires explicit authority and creates an audit record

---

## Agent Architecture Alignment

### How Memory Maps to the Agent Loop

Every AI agent follows the same fundamental loop:

```
Perceive → Think → Act → Update → Repeat
```

Memory integrates at every stage:

| Stage | Memory Role |
|---|---|
| **Perceive** | Framing memory provides context. Personalization adjusts interpretation. |
| **Think** | Semantic + reasoning memory provides facts and past decisions. Procedural memory provides known approaches. Episodic memory provides "last time this happened..." |
| **Act** | Procedural memory guides tool selection and ordering. |
| **Update** | Self-eval captures what worked, what didn't, what's missing. New memories created. |
| **Repeat** | Next iteration benefits from everything learned above. |

### OpenClaw Alignment

Nessie integrates with OpenClaw as an agent runtime. OpenClaw's architecture maps cleanly:

| OpenClaw Concept | Nessie Memory Integration |
|---|---|
| **Gateway** (receives messages) | Message content flows into extraction pipeline |
| **LLM** (reasoning engine) | Consumes recalled memories in context window |
| **Skills** (tools) | Tool call history feeds procedural memory capture |
| **Memory** (persistent context) | This entire system — OpenClaw's default is Markdown + SQLite; Nessie replaces with pgvector-backed structured memory |
| **Agent loop** (observe-think-act-repeat) | Self-eval runs at loop completion to update memory |

OpenClaw's session model (`agent:<agentId>:<channel>:group:<id>`) maps to Nessie's memory scoping via the session mapper in `src/openclaw/session-mapper.ts`. Memories created during an OpenClaw session inherit the channel's visibility and sensitivity tiers.

### Multi-Agent Memory Sharing

In Nessie's multi-agent orchestration:
- **Orchestrator** has read access to all memories within its org/project scope
- **Sub-agents** (builder, researcher, reviewer, debugger) create memories scoped to their task
- **Memory visibility** follows the existing channel/team/project/org hierarchy
- **Procedural memories** are shared across agents of the same role — a procedure discovered by one builder agent benefits all builder agents
- **Framing memories** are project-scoped — all agents working in the same project share domain knowledge
- **Personalization** is per-user, not per-agent — the user's communication style is consistent regardless of which agent they talk to

### Agent State Isolation

Query-time memory filtering is necessary but insufficient. An agent that reads confidential memories in one channel can carry that knowledge into a different channel's run via its conversation summaries or reflection memories.

**Isolation rules:**
- Every run's loaded memories, tool results, and generated reflections are tagged with `output_audience_id` (the channel/thread where results will be visible)
- Summaries and reflections generated during a run inherit the run's `output_audience_id`
- A subsequent run with a different `output_audience_id` cannot load memories, summaries, or reflections from the previous run UNLESS audience compatibility is satisfied
- Agents are stateless between runs by default — no hidden state carries over. All persistent state is in the `thoughts` table (subject to scoping) or the `messages` table (subject to thread/channel access)
- If an agent needs cross-channel context, it must explicitly recall memories (subject to audience compatibility) rather than relying on conversational carryover

---

## Local-First Filtering — PRIORITY: FUTURE

### Concept

On mobile or edge devices (iPhone app, desktop companion), use on-device AI to pre-filter what's worth remembering before sending to the server. This offloads cost onto the end device and reduces server-side processing.

### Why This Matters

- Not every message is worth extracting memories from
- Server-side LLM calls for extraction cost money
- Mobile devices already have capable on-device models (Apple Intelligence, on-device LLMs)
- Filtering at the edge means the server only processes high-value content

### Architecture

```
User Input (mobile device)
  │
  ├── On-device model (small, fast, free)
  │     Decides: "Is there anything worth remembering here?"
  │     Output: { should_process: bool, signal_type: 'decision' | 'fact' | 'procedure' | 'noise', confidence: 0.0-1.0 }
  │
  ├── If should_process = true:
  │     Send to server for full extraction pipeline
  │
  └── If should_process = false:
        Store message normally but skip memory extraction
```

### What the On-Device Model Decides

- Is this a decision? → Extract
- Is this a correction? → Extract (high signal)
- Is this a procedure being described? → Extract
- Is this small talk? → Skip
- Is this a simple acknowledgment? → Skip
- Is this a question the agent answered? → Maybe extract the answer, not the question

### Implementation Considerations

- On-device model must be small (quantized, <1B params) for acceptable latency
- Classification only — no embedding generation on device
- False negatives are worse than false positives (missing a decision > processing noise)
- Start with high recall, tune down as confidence grows
- This is a cost optimization, not a correctness mechanism — the server pipeline is the source of truth

### Timeline

After the core memory types are working and the extraction pipeline is proven. This is a nice-to-have optimization, not a blocker.

---

## Current State Audit

### What We Have (Implemented and Working)

| Component | Status | Location |
|---|---|---|
| Thought storage with embeddings | Done | `packages/memory/src/capture.ts` |
| Hybrid search (semantic + lexical + RRF) | Done | `packages/memory/src/search.ts` |
| Content deduplication (SHA-256) | Done | `packages/memory/src/fingerprint.ts` |
| Metadata extraction (LLM) | Done | `packages/memory/src/extract-metadata.ts` |
| Reasoning extraction (LLM) | Done | `packages/memory/src/extract-reasoning.ts` |
| Recall ledger (retrieval logging) | Done | `packages/memory/src/recalls.ts` |
| Outcome tracking | Done | `packages/memory/src/lifecycle.ts` |
| Thought linking (supersession chains) | Done | `packages/memory/src/lifecycle.ts` |
| Experience stats aggregation | Done | `packages/memory/src/lifecycle.ts` |
| Multi-tenant scoping (org boundary) | Done | SQL functions in migrations |
| Visibility levels (private → org) | Done | SQL functions in migrations |
| Sensitivity tiers | Done | Schema |
| HNSW + GIN indexes | Done | Migrations |
| memory_type column | Done | Schema (intent, reason, constraint, preference, fact) |
| Thought audit log | Done | Schema |
| API service facade | Done | `api/src/services/thoughts.ts` |

### What We Don't Have (Gaps)

| Component | Priority | Implementation Status |
|---|---|---|
| **Procedural memory** (how-to steps) | HIGH | Not started |
| **Framing memory** (cold-start elimination) | HIGH | Not started |
| **Self-eval loop** (active feedback) | HIGH | Not started |
| **Episodic memory** (compressed experiences) | MEDIUM | Partial — reasoning+outcome exists, situation embedding missing |
| Artifact-linked reasons (`thought_artifacts` table) | MEDIUM | Designed in pipeline doc, not yet in migrations |
| Recall scoping (audience compatibility at query time) | MEDIUM | Designed, not implemented |
| Signal → training data pipeline | LOW | Designed (Phase 4), not started |
| Learned reranker | LOW | Designed (Phase 5), not started |
| **Memory garbage collection** (decay, pruning) | HIGH | Not started — memories grow unbounded |
| **Conflict resolution** (contradicting memories) | MEDIUM | CONTRADICTS link exists, resolution logic missing |
| **Declassification model** | MEDIUM | Not started — scope widening unaudited |
| **Source attribution** (`thought_sources` table) | MEDIUM | Designed in pipeline doc, not in implementation phases |
| **Human memory curation** (review, correct, curate) | MEDIUM | No UI or API for memory correction |
| **Evaluation benchmarks** (regression test sets) | MEDIUM | No test sets for retrieval quality |
| **Agent state isolation** (cross-channel) | HIGH | Not started — agents can leak context across channels |
| **Personalization memory** (user model) | FUTURE | Not started |
| **Local-first filtering** (edge pre-filter) | FUTURE | Not started |

---

## Implementation Sequence

### Phase A: Procedural + Framing Memory (Next)

1. Add `procedure` and `framing` to `memory_type` enum in thoughts schema
2. Define JSONB structure for procedural steps in `packages/schemas`
3. Define JSONB structure for framing data in `packages/schemas`
4. Add capture functions to `packages/memory`:
   - `captureProcedure(input: CaptureProcedureInput)` — stores procedure from tool call history
   - `captureFraming(input: CaptureFramingInput)` — stores framing from exploration session
5. Add retrieval functions:
   - `searchProcedures(taskDescription, scope)` — trigger condition matching
   - `loadFraming(domain, projectId)` — direct scope lookup
6. Add lifecycle functions:
   - `updateProcedureConfidence(thoughtId, success: boolean)` — bump/decrement
   - `validateFraming(thoughtId)` — check entry points still exist
7. Wire into agent orchestrator:
   - At session start: load framing + search procedures
   - At task completion: trigger capture if applicable

### Phase B: Self-Eval Loop

1. Define self-eval prompt template (for `gpt-4o-mini`)
2. Define self-eval output schema in `packages/schemas`
3. Add `selfEvaluate(sessionContext)` to `packages/memory`
4. Extend `thought_recalls` with impact_score column
5. Add missing_memory capture flow:
   - If suggested_type = 'procedure': call `captureProcedure()`
   - If suggested_type = 'framing': call `captureFraming()` or update existing
6. Wire into agent orchestrator:
   - After task completion (success or failure)
   - Skip for tasks with < N tool calls (configurable threshold)
7. Add cost controls:
   - Cheap model only
   - Summarized input (not full tool call output)
   - Batch within session
8. Add source attribution:
   - Create `thought_sources` table
   - Link every extracted memory to source messages, tool calls, or files
   - Required for debugging bad memories and supporting human correction

### Phase C: Episodic Memory

1. Add `experience` to `memory_type` enum
2. Define experience structure (situation/action/outcome) in `packages/schemas`
3. Add `captureExperience(input)` — compresses task into experience triple
4. Add situation-similarity search
5. Wire into self-eval — when self-eval produces a task summary, also store as experience

### Phase D: Artifact Links + Recall Scoping

(Already designed in pipeline doc, implementation deferred)

1. Create `thought_artifacts` table
2. Implement artifact-referenced search
3. Add audience compatibility checks to `match_thoughts_scoped()`
4. Implement audience compatibility with CORRECT directionality: `Audience(current) ⊆ Audience(source)`
5. Add `output_audience_id` to runs and evaluations for agent state isolation

### Phase D.5: Memory Lifecycle

1. Implement decay rules by memory type
2. Add garbage collection background job
3. Add conflict detection and resolution logic
4. Add declassification event tracking
5. Add human curation API (view, correct, approve, reject memories)
6. Create initial evaluation benchmark sets

### Phase E: Personalization (Future)

1. Add personalization parameters to user model
2. Implement background signal analysis
3. Wire into response generation

### Phase F: Local-First Filtering (Future)

1. Define on-device classification protocol
2. Implement server-side "should extract?" endpoint for non-edge clients
3. Add iOS/mobile SDK for on-device classification

---

## Key Design Rules

1. **Memory is selection, not storage.** Store everything, but retrieve only what's contextually useful. The retrieval pipeline is the product, not the database.

2. **Don't store raw logs as memory.** Store compressed intelligence: decisions, procedures, experiences, framings. Raw conversations are in message history.

3. **Procedural memory has the highest ROI.** It directly reduces cost, time, and errors. Prioritize it.

4. **Framing eliminates cold starts.** Every dollar spent on exploration that could have been skipped is waste.

5. **Self-eval is the growth engine, not an oracle.** Self-eval produces hypotheses about what helped and what's missing. These hypotheses are WEAK until validated by outcomes, user feedback, or repeated success. Treat self-eval output as draft intelligence, not ground truth.

6. **Feedback loops are multi-signal.** The system evaluates itself AND accepts human correction. Auto-captured memories below confidence threshold are provisional — they enter a curation queue, not the active memory pool. User signals are the strongest signal source. Self-eval is the most scalable. Both are needed.

7. **Multi-tenant boundaries are non-negotiable.** Every query includes `organization_id`. No cross-org memory access. Ever.

8. **Personalization should be implicit.** No preference forms. Observe behavior, infer style, adapt. The user shouldn't know the system is adapting.

9. **Local-first saves cost at scale.** Filter early on the device, process on the server only when there's signal worth extracting. But this is an optimization, not a requirement.

10. **One table, many types — with typed side tables where needed.** All memory types live in the `thoughts` table with `memory_type` discrimination. However, complex structured data (procedural steps, framing entry points, episodic situation triples) are stored in `metadata` JSONB with enforced schemas. If query patterns diverge significantly (e.g., procedural step execution tracking), typed side tables may be introduced. The unified model is the default, not a dogma.
