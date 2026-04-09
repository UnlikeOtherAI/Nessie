# Multi-Agent Memory System

Complete design document for Nessie's memory system — covering all memory types, retrieval strategies, feedback loops, and implementation priorities. This is the canonical reference that replaces ad-hoc notes and ChatGPT briefs.

Builds on:
- [memory-pipeline-design.md](memory-pipeline-design.md) — four-stage pipeline (extraction, assignment, storage, retrieval)
- [memory-reasoning-and-experience.md](memory-reasoning-and-experience.md) — reasoning model, outcome tracking, supersession chains
- [memory-security-and-scoping.md](memory-security-and-scoping.md) — multi-tenant visibility, org hard boundaries
- [research/memory-retrieval-and-reranking-in-multi-agent-systems.md](research/memory-retrieval-and-reranking-in-multi-agent-systems.md) — retrieval architectures, reranking, negative mining
- [research/reasoning-provenance-and-decision-traceability.md](research/reasoning-provenance-and-decision-traceability.md) — design rationale research
- [research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md](research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md) — embedding security, need-to-know

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
- `thought_artifacts` for artifact-linked reasons (file paths, components, endpoints)
- `thought_links` for supersession chains (supersedes, derived_from, contradicts, supports, relates_to)
- Metadata extraction via LLM (`gpt-4o-mini`)

**What we need**: The existing system covers semantic memory comprehensively. No new work required here. See `packages/memory/src/search.ts` and `packages/memory/src/capture.ts`.

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
  "situation": "User asked to debug failing API endpoint. Error was 500 on /api/users. Logs showed connection pool exhaustion.",
  "action": "Identified connection leak in middleware. Added connection release in error handler. Restarted service.",
  "outcome": "successful",
  "duration_seconds": 340,
  "tools_used": ["Bash", "FileRead", "Grep", "FileWrite"],
  "embedding": [...]
}
```

**Priority**: Medium. The existing reasoning + outcome tracking covers 70% of this. The remaining gap is the compressed situation embedding for "have I seen this before?" retrieval. This can be built on top of the existing `thoughts` table with `memory_type = 'experience'`.

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
  "project_id": "..."
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

**Validation**: Framing memories contain file paths and patterns that can go stale. Before injecting a framing memory, the system should verify:
- Referenced files still exist
- Key patterns still hold (quick grep/read check)
- If validation fails, mark framing as stale and trigger re-exploration

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
- Audience compatibility (channel membership superset check)

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
- Cross-encoder model trained on accumulated signals
- Input: (query_embedding, memory_embedding, memory_type, channel_context, similarity_score)
- Output: relevance probability
- Deployed between initial search and context injection

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

### What This Enables

The self-eval is the **secret sauce** that makes the system self-improving:
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
3. **Reference tracking** (moderate): `was_referenced` — did the agent cite the memory in its response?
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
For each recall:
  if was_referenced AND (user_signal = 'helpful' OR user_signal IS NULL):
    signal = 'positive'
  if NOT was_referenced AND NOT was_injected:
    signal = 'negative_ignored'  (system filtered it out — may be correct)
  if was_injected AND NOT was_referenced:
    signal = 'negative_unhelpful'  (agent had it, didn't use it)
  if user_signal = 'harmful':
    signal = 'negative_harmful'  (actively wrong/misleading)
```

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

Capture everything at ingestion. Dedup prevents redundancy. Storage is cheap. A memory nobody searches for costs nothing. A missing memory when someone needs it costs days of re-discovery.

Pruning happens based on feedback signals, not upfront filtering.

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

| Component | Priority | Status |
|---|---|---|
| **Procedural memory** (how-to steps) | HIGH | Not started |
| **Framing memory** (cold-start elimination) | HIGH | Not started |
| **Self-eval loop** (active feedback) | HIGH | Not started |
| **Episodic memory** (compressed experiences) | MEDIUM | Partial — reasoning+outcome exists, situation embedding missing |
| Artifact-linked reasons (`thought_artifacts` table) | MEDIUM | Designed in pipeline doc, not yet in migrations |
| Recall scoping (audience compatibility at query time) | MEDIUM | Designed, not implemented |
| Signal → training data pipeline | LOW | Designed (Phase 4), not started |
| Learned reranker | LOW | Designed (Phase 5), not started |
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

5. **Self-eval is the growth engine.** Without active feedback, the system doesn't improve. Passive tracking (was_referenced) is necessary but insufficient.

6. **Feedback loops close themselves.** No user forms. The system evaluates itself, captures what's missing, and improves retrieval. User signals are a bonus, not a requirement.

7. **Multi-tenant boundaries are non-negotiable.** Every query includes `organization_id`. No cross-org memory access. Ever.

8. **Personalization should be implicit.** No preference forms. Observe behavior, infer style, adapt. The user shouldn't know the system is adapting.

9. **Local-first saves cost at scale.** Filter early on the device, process on the server only when there's signal worth extracting. But this is an optimization, not a requirement.

10. **One table, many types.** All memory types live in the `thoughts` table with type discrimination. No parallel infrastructure. The unified model with `memory_type` + `metadata` JSONB is simpler and more maintainable than separate tables per type.
