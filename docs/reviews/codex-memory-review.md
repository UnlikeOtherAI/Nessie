<!-- markdownlint-disable MD013 -->

# Codex Memory System Review

Scope reviewed:

- `docs/multi-agent-memory-system.md`
- `docs/memory-pipeline-design.md`
- `docs/memory-reasoning-and-experience.md`
- `docs/memory-security-and-scoping.md`
- `docs/the-agents.md`, especially sections 7 and 10
- `docs/research/memory-retrieval-and-reranking-in-multi-agent-systems.md`
- `docs/research/reasoning-provenance-and-decision-traceability.md`

Verdict: the memory design is directionally strong but not yet executable. The documents describe the right components: typed memory, hybrid retrieval, recall logging, reasoning provenance, outcome tracking, procedural/framing memory, self-eval, and learned reranking. The problem is that the contracts between those components are loose or contradictory. The system repeatedly claims "self-improving" behavior before defining the prompts, schemas, data quality controls, adversarial model, training regime, retention policy, and access-control invariants required to make that claim true.

## 1. Contradictions

### 1.1 The canonical overview says seven memory types; the pipeline design says two

- `docs/multi-agent-memory-system.md`, section "Memory Types", defines seven types: working, semantic, reasoning, episodic, procedural, framing, personalization.
- `docs/memory-pipeline-design.md`, section "Memory Taxonomy", says there are "Two first-class memory types": intents and reasons.
- `docs/the-agents.md`, section "What an Agent Is", says memory is the `thoughts` table with "semantic, procedural, framing, reasoning, episodic" memory. That omits working and personalization, and collapses semantic intent/reason distinctions.

These are not just different levels of detail. They define different product surfaces and different retrieval systems. The pipeline's two-type model cannot deliver the overview's seven-type retrieval table unless "intent" and "reason" are explicitly defined as subtypes of semantic memory, not the whole taxonomy.

Required fix: define one taxonomy with a `memory_kind` hierarchy. Example: `working` is non-persistent, `semantic.intent` and `semantic.reason` are persistent thought categories, `reasoning` is a linked record type, `experience/procedure/framing` are persistent thought kinds, and `personalization` is a separate user model.

### 1.2 `memory_type` is claimed as implemented, but target values are absent

- `docs/multi-agent-memory-system.md`, section "Semantic Memory", says the implemented `memory_type` column supports `intent`, `reason`, `constraint`, `preference`, `fact`.
- The same document's procedural, framing, and episodic sections store records as `memory_type = 'procedure'`, `memory_type = 'framing'`, and `memory_type = 'experience'`.
- `docs/multi-agent-memory-system.md`, section "Current State Audit", repeats that the implemented schema has only `intent, reason, constraint, preference, fact`, then section "Implementation Sequence" says Phase A adds `procedure` and `framing`, and Phase C adds `experience`.
- The actual Prisma schema does not define a `memory_type` enum or field on `Thought`; current classification lives in metadata/reasoning records, not a typed `Thought.memoryType`.

This makes the overview misleading. It reads like one-table-many-types is already available, while the implementation cannot store the proposed target types in a first-class column.

Required fix: split every design section into "current contract" and "target contract". Add a concrete migration: `Thought.memoryType` enum with current and future values, backfill rules from metadata, and read-path behavior during migration.

### 1.3 The overview promises artifact-linked reasons; the current pipeline and audit admit they are not implemented

- `docs/multi-agent-memory-system.md`, section "Semantic Memory", lists `thought_artifacts` for artifact-linked reasons under "What we have (implemented)".
- The same document's "Current State Audit" says "Artifact-linked reasons (`thought_artifacts` table)" are designed but not yet in migrations.
- `docs/memory-pipeline-design.md`, sections "Reasons" and "Artifact Assignment", make artifact linkage central to reason retrieval.

This is a direct contradiction. The overview's "What we have" overclaims a core feature that the current-state audit correctly marks as missing.

Required fix: demote artifact links from implemented to planned everywhere until the table, extraction fields, write path, and artifact lookup endpoint exist.

### 1.4 "Reasons are first-class" conflicts with one-table storage and linked reasoning records

- `docs/memory-pipeline-design.md`, section "Memory Taxonomy", says reasons are a first-class memory type retrieved by artifact reference.
- `docs/memory-reasoning-and-experience.md`, section "Nessie's Reasoning Model", says reasoning is first-class as `ThoughtReasoning`, separate from `Thought`.
- `docs/multi-agent-memory-system.md`, "Storage Format by Type", says semantic reasons live in `thoughts + thought_artifacts`, while reasoning lives in `thought_reasonings`.

The word "reason" is overloaded across at least three entities:

- `memory_type = 'reason'` as a stored thought category.
- `ThoughtReasoning.reasoning` as structured rationale attached to any thought.
- `thought_artifacts` as artifact-linked reason lookup records.

The docs never define whether "reason memory" and "reasoning memory" are separate records, linked records, or different views over the same rationale. That ambiguity will leak directly into APIs and retrieval prompts.

Required fix: reserve names. For example: `ReasonMemory` = artifact-linked answer to "why does X exist?"; `ThoughtReasoning` = structured rationale attached to a thought; `ThoughtLink` = provenance/evolution graph. Then state which one is returned for each query type.

### 1.5 Capture policy contradicts itself and the research

- `docs/memory-pipeline-design.md`, section "Volume Policy", says "Capture everything. The dedup layer ... prevents redundancy. Storage is cheap."
- `docs/multi-agent-memory-system.md`, "Volume Policy", repeats "Capture everything at ingestion."
- `docs/multi-agent-memory-system.md`, "What NOT to Store", says not to store raw conversation logs long-term, noise, repetition, trivial facts, or ephemeral task state.
- `docs/research/reasoning-provenance-and-decision-traceability.md`, sections "What failed in practice" and "Knowledge decay", warn that capture-everything repositories fail due to capture overhead, staleness, inconsistency, and lack of curation.

"Capture everything" is not compatible with "do not store noise" or with value-based rationale capture. The only coherent version is "evaluate every turn for candidate memory extraction, but persist only compressed, scoped, typed memory records under retention rules."

Required fix: rename the policy. Use "process every eligible event" for ingestion and define explicit persistence filters for long-term memory.

### 1.6 Security directionality is both specified and flagged as wrong

- `docs/memory-pipeline-design.md`, section "Scope Assignment", says channel-scoped memories can be recalled in channels whose membership is a superset of the source channel.
- The SQL example in "Recall Scope" checks that every source-channel member is in the current channel.
- `docs/memory-pipeline-design.md`, "Research-Informed Design Updates", says this direction is wrong and the safe rule is `Audience(current_channel) <= Audience(source_channel)`.
- `docs/research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md`, section "Your audience-compatibility check is a DLM-style restriction check", says the same: surfacing into a larger audience leaks.
- `docs/the-agents.md`, section "Skill Visibility", says skill sharing mirrors the memory scoping model but inherits the same undefined directionality.

The document knowingly contains an unsafe rule and then asks implementers to "verify" it. That is not acceptable for a security invariant.

Required fix: replace every prose and SQL example with the safe rule: a memory can be surfaced into output audience B only if every member of B was authorized for the source audience A, unless an explicit declassification record exists.

### 1.7 Security doc access checks are weaker than the pipeline's recall-scope model

- `docs/memory-security-and-scoping.md`, section "Query-Time Filtering", uses per-user membership checks: if the caller is a member of the source channel/team/project, they can access the thought.
- `docs/memory-pipeline-design.md`, section "Recall Scope", says the system must check the full output audience, not only the searching user.
- `docs/multi-agent-memory-system.md`, "Retrieval Architecture", claims audience compatibility is applied at query time.

The security doc still models read authorization as "can this user see the memory?" The recall design needs "can this memory influence an answer visible to this audience?" Those are different questions. A user who belongs to management and client channels may personally see both, but cannot let management memories influence a client-channel answer.

Required fix: add `outputAudience` or `currentChannelId` to every memory search API and SQL function. User authorization is necessary but not sufficient.

### 1.8 Evaluation priority conflicts between memory and agent docs

- `docs/multi-agent-memory-system.md`, section "Self-Evaluation Loop", marks self-eval as high priority and the growth engine.
- `docs/the-agents.md`, section "Implementation Order", puts memory integration, including procedural memory, framing, and self-eval, in Phase 6 after native tool calling, plans, skills, mailbox, evaluation, tool registry, and sandbox.
- `docs/the-agents.md`, "Need (Not Started)", marks self-eval as Medium, procedural memory as Medium, and framing memory as Medium.

The memory docs say self-eval/procedural/framing are high-priority next work. The agent docs say they are late-phase dependencies after most of the runtime has been rebuilt.

Required fix: define a real dependency graph. If self-eval depends on the agentic loop and critic loop, stop calling it next. If procedural/framing memory can be implemented against current tool-call logs, move them earlier and state their degraded behavior under single-shot execution.

### 1.9 The self-eval loop and the critic loop are two different evaluation systems with no contract

- `docs/multi-agent-memory-system.md`, "Self-Eval Flow", produces `used_memories`, `missing_memories`, `new_procedural`, `framing_update`, `task_success`, and `confidence`.
- `docs/the-agents.md`, section "Evaluation and Self-Correction", defines an `evaluations` table with `kind`, `passed`, `score`, `feedback`, and `metrics`.
- `docs/the-agents.md`, "Reflection", defines a separate reflection JSON with `root_cause`, `proposed_fix`, `applied`, `confidence`, and `impact`.

There is no mapping between these outputs. Does the memory self-eval create an `evaluations` row, a reflection row, both, or neither? Does `task_success` come from the critic, task status, user signal, or the model's self-report? Where is `missing_memories` stored if not in `evaluations.metrics`?

Required fix: define a shared `RunEvaluation` schema with typed subdocuments for quality, memory feedback, reflection, and promotion candidates.

### 1.10 Skills and procedural memory are related, but the promotion pipeline is not designed

- `docs/the-agents.md`, section "Skills vs Procedural Memory", says successful run -> self-eval captures procedural memory -> human/agent promotes to candidate skill -> tests pass -> skill approved.
- `docs/multi-agent-memory-system.md`, section "Procedural Memory", says procedures are stored as JSONB steps with confidence and success/failure counts.
- `docs/the-agents.md`, section "Skill Schema", has `source_thought_id`, but no candidate status, no conversion schema, no test generation rule, no approval authority, no versioning from source procedure, and no rollback/deprecation propagation.

The pipeline is a slogan, not a design.

Required fix: add `SkillCandidate` or define `skills.status = candidate`. Specify field mapping from procedural metadata to skill definition, required tests, reviewer authority, risk classification, and what happens to `source_thought_id` when the source procedure is superseded.

## 2. Eval And Feedback Loop Gaps

### 2.1 The self-eval output schema is aspirational, not enforceable

The self-eval JSON in `docs/multi-agent-memory-system.md`, section "Active Self-Eval Step", is useful as a concept but not buildable yet.

Missing:

- No Zod/JSON schema.
- No enum definitions for `impact`, `suggested_type`, task outcome, or confidence calibration.
- No validation behavior for invalid JSON, partial output, hallucinated `thought_id`, or fabricated tool history.
- No grounding requirement tying `used_memories[].thought_id` to actual recalled IDs from `thought_recalls`.
- No storage target for `missing_memories`.
- No retry/fallback path when self-eval fails.
- No sampling policy for trivial tasks beyond "more than N tool calls."

Required fix: define `SelfEvalResultSchema`, persist raw and parsed outputs, reject unknown recalled IDs, and require every claim to reference either a `recall_id`, `tool_call_id`, `message_id`, or `plan_step_id`.

### 2.2 Missing-memory detection is hand-waved

The docs say self-eval identifies "what should have been available but wasn't" but do not define how.

Missing:

- Exact prompt.
- Model choice.
- Input budget.
- Prompt compression strategy.
- Whether the model sees the full conversation, tool calls, failed searches, or only final answer.
- Whether retrieval misses are detected by comparing attempted queries to zero-result searches.
- Cost model per run.
- Precision controls to avoid generating fake "missing memories" after every task.
- Deduplication of repeated missing-memory reports.

The current prompt example asks a model to introspect absence. That is a high-false-positive task. A model can invent missing memories because absence is not directly observable unless failed searches and task detours are logged.

Required fix: define missing memory as an evidence-backed object:

```json
{
  "description": "...",
  "evidence": [
    { "type": "failed_search", "query": "...", "top_k_count": 0 },
    { "type": "exploration_detour", "tool_call_ids": ["..."] },
    { "type": "user_correction", "message_id": "..." }
  ],
  "suggested_type": "procedure | framing | semantic | reason | experience",
  "confidence": 0.0
}
```

### 2.3 `was_referenced` is currently too weak to support training

- `docs/memory-pipeline-design.md`, section "Signal Collection", treats `was_referenced = true` as an automatic positive signal.
- `docs/multi-agent-memory-system.md`, "Feedback System", ranks reference tracking as moderate reliability.
- Current implementation in `worker/src/run/execute.ts` uses `detectReferencedRecallIds`, which normalizes text and checks whether generated response text contains phrases from memory content.

That implementation is not reliable enough for training labels:

- False positive: the model repeats a phrase because it is common domain language, not because it used the memory.
- False negative: the model paraphrases the memory, uses the reasoning but not exact phrases, or uses a truncated part not in the phrase set.
- Citation laundering: the model can copy memory text without the memory being useful.
- Redundancy: the model may ignore one memory because another memory says the same thing, not because the ignored one is unhelpful.
- Truncation: only 220 chars are injected per memory in the current worker, so phrase matching against full memory content can look for text the model never saw.

Required fix: split the field into `referenced_by_phrase`, `referenced_by_citation`, `referenced_by_self_report`, and `reference_confidence`. Do not train a reranker from phrase matches as hard positives.

### 2.4 Signal aggregation rules are incomplete and internally unsafe

- `docs/memory-pipeline-design.md`, "Signal -> Training Data", maps `was_referenced` and `was_injected` to `positive`, `negative_ignored`, `negative_unhelpful`, and `negative_harmful`.
- `docs/research/memory-retrieval-and-reranking-in-multi-agent-systems.md`, "Training with mostly implicit signals", explicitly warns that unused is not irrelevant and that exposure/position bias affects labels.
- `docs/memory-pipeline-design.md`, "Research-Informed Design Updates", repeats "Unused is not irrelevant", but the earlier aggregation rules still label unused injected memories as `negative_unhelpful`.

Missing signal states:

- `positive_explicit`: user said helpful.
- `positive_cited`: explicit memory citation or structured self-report.
- `positive_outcome_correlated`: task succeeded but memory role unknown.
- `neutral_redundant`: not used because another memory covered it.
- `neutral_budget`: not used because context budget was exhausted.
- `negative_wrong_scope`: memory should not have been eligible.
- `negative_stale`: memory was outdated.
- `negative_conflict`: contradicted newer memory.
- `negative_false_reference`: phrase match said referenced but verifier rejected it.
- `negative_prompt_injected`: adversarial user caused reference.

Required fix: add signal confidence and source. Training rows should include `label`, `label_confidence`, `label_source`, `exposure_rank`, `injected_position`, `prompt_tokens_visible`, and `verifier_version`.

### 2.5 Session outcome signals are dangerously blunt

- `docs/memory-pipeline-design.md`, "Signal Collection", says if a task completes, all recalled memories get a positive association; if it fails or the user expresses frustration, negative association.
- `docs/multi-agent-memory-system.md`, "Feedback System", repeats session outcome as a contextual signal.

This will poison training data. A task can succeed despite bad memory, fail despite good memory, or succeed because the agent ignored injected memory. User frustration may be about UX latency, not recalled content.

Required fix: session outcome should be a weak contextual feature, not a label. Use it only in aggregate with exposure, explicit self-eval, and user feedback.

### 2.6 The reranker design is not buildable yet

- `docs/memory-pipeline-design.md`, section "Reranking (Future)", says train a lightweight reranker from `recall_training_signals`.
- `docs/multi-agent-memory-system.md`, "Reranking Roadmap", says Phase 3 uses a cross-encoder with input `(query_embedding, memory_embedding, memory_type, channel_context, similarity_score)`.
- `docs/research/memory-retrieval-and-reranking-in-multi-agent-systems.md`, sections "Learned reranking" and "Architectures and training workflows", recommend top-k cross-encoder reranking over text and metadata, not just embeddings.

The design lacks:

- Model family choice.
- Input serialization.
- Feature set.
- Training objective.
- Negative sampling.
- Minimum label volume.
- Evaluation set.
- Offline metrics.
- Online A/B criteria.
- Latency budget.
- Hardware/runtime plan.
- Cold-start teacher strategy.
- Debiasing approach for position/exposure.

Also, a cross-encoder cannot use only `query_embedding` and `memory_embedding` if the point is token-level interaction. It needs query text, candidate text, conversation state, and metadata. The current Phase 5 input spec describes a feature model, not a cross-encoder.

Required fix: define Phase 5 as either:

- Cross-encoder: input is text pair plus metadata text, output score.
- LambdaMART/feature ranker: input is numeric/text-derived features, output score.

Do not call the second one a cross-encoder.

### 2.7 There is no adversarial-feedback model

The feedback loop assumes user and model signals are honest. That is not valid in a multi-agent, multi-tenant memory system.

Attack paths:

- User repeatedly flags poisoned memory as helpful.
- User asks the agent to cite a memory so phrase matching marks it positive.
- User injects "this memory was useful" into the prompt.
- Agent self-eval hallucinates a procedure that favors its own previous behavior.
- A compromised channel creates high-confidence procedures that later get shared to agents of the same role.
- A public or org-scoped memory becomes a high-ranking prompt injection payload.
- Negative feedback is used to suppress true but inconvenient memories.

Required fix: model feedback as untrusted input. Add actor trust, rate limits, anomaly detection, label provenance, moderation of promotion-sensitive signals, and separate user preference feedback from objective correctness feedback.

## 3. Memory Type Gaps

### 3.1 Procedural memory capture is underspecified

- `docs/multi-agent-memory-system.md`, section "Procedural Memory", says self-eval compresses raw tool calls into generalized steps.
- `docs/the-agents.md`, "Skills vs Procedural Memory", says procedural memories are raw material for skills.

Missing:

- Exact prompt.
- Input format for tool calls.
- How failed tool calls are represented.
- How to distinguish necessary steps from incidental exploration.
- How to abstract project-specific values into parameters.
- How to preserve critical environmental details.
- How to attach preconditions and contraindications.
- How to capture verification steps.
- How to prevent a one-off success from becoming a reusable runbook.
- How to update an existing procedure instead of creating a near-duplicate.

Generalization is the hard part. If too specific, the procedure is useless outside the original task. If too general, it becomes a dangerous checklist missing the constraints that made it work.

Required fix: procedural memory must store:

- `trigger_conditions`
- `preconditions`
- `inputs`
- `steps`
- `verification`
- `failure_modes`
- `do_not_use_when`
- `source_run_id`
- `supporting_tool_call_ids`
- `success_count`
- `failure_count`
- `review_status`

### 3.2 Framing memory can become harmful, but the stale model is shallow

- `docs/multi-agent-memory-system.md`, section "Framing Memory", says validation checks whether referenced files still exist and key patterns still hold.
- `docs/research/reasoning-provenance-and-decision-traceability.md`, sections on gIBIS and traceability, warn that outdated issue framings can bias future work and require hygiene.

File existence is not enough. A framing memory can be harmful even when every file still exists:

- Entry point exists but no longer owns the behavior.
- Pattern exists but is deprecated.
- Navigation strategy optimizes for old architecture.
- Gotcha was fixed and now misleads the agent.
- Ownership changed.
- New package boundary makes old imports invalid.
- The framing reflects a failed mental model from exploration, not the actual architecture.

Required fix: framing memory needs `validated_against_commit`, `last_validated_at`, `validation_method`, `staleness_score`, `invalidated_by`, and `scope_of_truth`. Validation must include targeted tests/searches and recent-change checks, not only `stat` or `grep`.

### 3.3 Episodic memory retrieval is not designed

- `docs/multi-agent-memory-system.md`, section "Episodic Memory", admits there is no explicit episodic type and no similar-situation retrieval.
- The proposed structure embeds `situation` but does not define how the situation is extracted.
- `docs/memory-reasoning-and-experience.md`, section "Experience Retrieval", describes retrieving decisions with outcomes, not situation-action-outcome episodes.

The system cannot claim episodic memory until it defines situation representation. "Debug failing endpoint" is too broad. Useful situation similarity needs dimensions such as symptom, environment, artifact, error class, constraints, attempted actions, and outcome.

Required fix: define a situation schema, not a paragraph:

```json
{
  "task_type": "debugging",
  "symptoms": ["HTTP 500", "connection pool exhaustion"],
  "artifacts": ["POST /api/users", "db middleware"],
  "environment": ["postgres", "api worker"],
  "constraints": ["production incident"],
  "initial_hypotheses": ["connection leak"],
  "outcome": "successful"
}
```

Embed both the natural summary and selected structured fields rendered as text.

### 3.4 Memory type interactions are not specified

The docs imply interactions but do not define them:

- `ThoughtLink` supports `DERIVED_FROM`, `SUPERSEDES`, `CONTRADICTS`, `SUPPORTS`, `RELATES_TO`.
- Procedural memories can be superseded.
- Reasoning records attach to thoughts.
- Skills can source from procedural memories.
- Reflections are linked to procedural memories in `docs/the-agents.md`, section "Reflection".

Missing:

- Can a procedure reference a framing memory as a precondition?
- Can a reasoning record explain a procedure step?
- Can an episodic memory be evidence for increasing a procedure's confidence?
- Can a framing memory be superseded by a reasoning decision?
- Are links typed strongly by source/target memory kinds?
- What happens if a linked memory is no longer visible in the current audience?

Required fix: define allowed link matrices by memory kind and relation. Retrieval must preserve link security: do not inject a visible memory with an invisible linked rationale unless declassified.

### 3.5 Personalization memory is underspecified and risky

- `docs/multi-agent-memory-system.md`, section "Personalization Memory", proposes inferring stress, directness, verbosity, and confirmation frequency.
- It says no forms and implicit background analysis.

This is sensitive behavioral profiling. The security docs do not define consent, visibility, deletion, audit, or whether agents can write/read another user's personalization model. "Stress indicators" can be a workplace surveillance feature.

Required fix: define explicit product policy before implementation: what signals are allowed, who can see them, how users opt out, retention windows, and whether personalization can affect decisions beyond response style.

## 4. Scaling And Cost

### 4.1 Hybrid search at 100K and 1M memories has no latency model

- `docs/multi-agent-memory-system.md`, "Retrieval Architecture", says every relevant retrieval uses semantic + lexical + RRF.
- `docs/memory-pipeline-design.md`, "Retrieval Strategy", runs both searches and merges.
- The research doc supports hybrid search but does not size Nessie's Postgres deployment.

Missing:

- Expected corpus size per org, project, channel, and agent.
- HNSW latency at 100K and 1M scoped rows.
- GIN lexical latency at 100K and 1M scoped rows.
- Cost of audience-compatibility joins before or after ANN candidate generation.
- Whether `organization_id`, `visibility`, and channel filters can be pushed down efficiently with pgvector.
- RRF top-k sizes per modality.
- P95/P99 target.
- Concurrency target.
- Index memory footprint.
- Vacuum/reindex strategy for write-heavy memory tables.

At 1M thoughts, "just run hybrid search" is not a design. Scoped vector search with complex ACLs is exactly where systems get slow or accidentally broaden retrieval.

Required fix: add a capacity model and benchmark plan. Define query plans for 100K, 1M, and 10M rows, including per-org partitioning or partial indexes if needed.

### 4.2 Self-eval after every task has no cost envelope

- `docs/multi-agent-memory-system.md`, "Cost Control", says use a cheap model, run only above N tool calls, batch within session, and cap prompt size.
- No dollar model is provided for task volume.
- No token budget is defined for summarized tool history.
- No failure budget is defined if the eval call times out.

Required fix: define:

- tasks/day assumptions,
- percent eligible for self-eval,
- average input/output tokens,
- model price,
- max monthly spend,
- degradation mode when budget exhausted,
- eval sampling policy per agent role.

### 4.3 Extraction cost model is inconsistent with "every conversation turn"

- `docs/memory-pipeline-design.md`, "What Gets Extracted", says every conversation turn is classified.
- `docs/memory-reasoning-and-experience.md`, "Cost Model", prices per thought, not per raw conversation turn.
- Current `captureThought` runs embedding, metadata extraction, and reasoning extraction in parallel for captured thoughts, not every message.

The docs conflate message volume, candidate memories, and stored thoughts. Cost depends on which unit is processed.

Required fix: define the pipeline units:

- raw message,
- candidate extraction window,
- extracted candidate memory,
- stored thought,
- reasoning record.

Then price each stage separately.

### 4.4 Recall ledger retention is absent

- `docs/memory-pipeline-design.md`, "Recall Ledger", logs every surfaced memory.
- `docs/multi-agent-memory-system.md`, "Feedback System", aggregates recall rows into training signals.

Missing:

- Retention window for `thought_recalls`.
- Whether query text and embeddings are sensitive.
- Deletion behavior when a thought is deleted.
- GDPR/user deletion behavior.
- Compaction after aggregation.
- Sampling/downsampling at high volume.
- Partitioning by date/org.
- Archival policy for training data.

The recall ledger will grow faster than memories. Every search can log multiple candidates. At scale, this becomes a click-log system, not a side table.

Required fix: partition `thought_recalls` by time and org, define raw retention, aggregate retention, and privacy deletion semantics.

### 4.5 "Storage is cheap" ignores embeddings, audit, and training logs

The docs repeatedly say a memory nobody searches costs nothing. That is false operationally. It costs:

- embedding generation,
- vector storage,
- lexical index size,
- backup size,
- audit log rows,
- search candidate noise,
- privacy exposure surface,
- retention/delete complexity,
- future reranker training noise.

Required fix: replace the slogan with a storage and retrieval cost model.

## 5. Missing For A Complete System

### 5.1 Memory garbage collection and decay

The docs mention pruning and staleness but do not define a policy.

Missing:

- Decay function.
- Minimum evidence before pruning.
- Difference between low-use, stale, wrong, sensitive, duplicate, and superseded.
- Human review for deletion.
- Soft-delete behavior for linked reason/procedure/skill records.
- Archive versus delete.
- Rehydration path if a pruned memory was still useful.

Required fix: add lifecycle statuses such as `active`, `stale`, `superseded`, `deprecated`, `archived`, `deleted`, plus type-specific decay rules.

### 5.2 Memory conflict resolution

The system supports `CONTRADICTS` links but does not define conflict handling.

Missing:

- How contradictions are detected.
- Who resolves them.
- Whether conflicting memories are both retrieved.
- How recency, confidence, actor trust, outcome, and scope affect conflict resolution.
- How to prevent an agent from storing a contradictory falsehood and outranking a true memory.
- What response an agent gives when retrieved memories conflict.

Required fix: define a conflict resolver. At retrieval time, a memory with unresolved `CONTRADICTS` links should be injected with conflict context or withheld from autonomous use.

### 5.3 Memory migration for cloned/forked agents

Agent docs support hierarchy and spawning, but memory docs do not define clone/fork memory behavior.

Missing:

- Does a child inherit parent memories by reference or copy?
- Can a cloned agent see parent private memories?
- Are procedural memories role-shared immediately or after promotion?
- What happens when an agent changes role?
- How are agent-owned memories reassigned when an agent is archived?
- Can a fork modify inherited framing memory?

Required fix: define memory inheritance rules: inherited-read, copied, excluded, or promoted. Include audit records for every memory made visible to a new agent.

### 5.4 Agent-builds-agent access control

The docs do not define memory access control when agents create or configure other agents.

Missing:

- Whether the builder agent can inject memories into the child system prompt.
- Whether a child can inherit memories from the builder's current channel.
- Whether private/user memories can be used to configure a public agent.
- Whether procedural memories can become public skills without declassification.
- How confidential context is prevented from leaking into generated prompts, tests, or skill instructions.

Required fix: treat agent creation as declassification-sensitive. Any memory-derived content embedded into an agent config or skill must pass audience compatibility and produce an audit/declassification record.

### 5.5 Skills promotion pipeline

The promotion path from procedural memory to skill is missing concrete machinery.

Required design:

- `procedure.review_status`: `unreviewed | candidate | rejected | promoted | deprecated`.
- `skill_candidates` table or candidate status in `skills`.
- Conversion job from `procedure.metadata` to `SkillVersion`.
- Required generated tests and manual review for risky tools.
- Security scan for commands and external calls.
- Versioned approval.
- Backlink from skill version to source thought and source run.
- Rule for updating or deprecating promoted skills when source procedure later fails.

### 5.6 Source attribution for memory extraction is incomplete in implementation sequence

- `docs/memory-pipeline-design.md`, "Source Attribution", defines `thought_sources`.
- `docs/memory-reasoning-and-experience.md`, "Reasoning Model", emphasizes provenance.
- `docs/multi-agent-memory-system.md`, "Implementation Sequence", does not include `thought_sources` in the next phases.

Without source attribution, the system cannot defend extracted rationale, debug bad memories, or support human correction.

Required fix: move `thought_sources` into the same phase as artifact-linked reasons and self-eval output. Every extracted memory should know which messages, docs, PRs, tool calls, or files supported it.

### 5.7 Human correction and incremental formalization are missing

The research doc explicitly says automated extraction should be a drafting assistant, not the system of record. The product docs mostly describe fully automatic extraction and self-eval.

Missing:

- Review UI/API for extracted memories.
- Correction workflow.
- Confidence thresholds for auto-activation.
- Curator role.
- Audit trail for edits to reasoning/procedure/framing records.
- Queue for low-confidence extractions.

Required fix: add a "memory curation" workflow. Auto-extracted high-risk memory should be provisional until confirmed.

### 5.8 Evaluation benchmarks are absent

The docs list metrics like Precision@K, hallucination reduction, time saved, and task success. They do not define test sets or acceptance gates.

Required benchmarks:

- "Why does this artifact exist?" answerability set.
- Refactor resilience set for artifact links.
- Similar-situation episodic retrieval set.
- Procedure reuse success set.
- Framing stale/harmful detection set.
- Cross-audience leakage test set.
- Reranker offline evaluation set with held-out labels.

No memory system should ship learned reranking or self-eval-driven capture without these regression suites.

### 5.9 Agent state isolation is missing

- `docs/memory-pipeline-design.md`, "Research-Informed Design Updates", says agent state isolation is mandatory because an agent that reads confidential memories in one channel can later leak them in another.
- `docs/memory-security-and-scoping.md` defines query-time memory access, but not retained model/session state.
- `docs/the-agents.md` allows agents to be bound to channels and to run across threads, but does not define per-channel hidden-state isolation.

Query filtering is insufficient if the agent carries remembered confidential context across runs. The design needs to specify whether agents are stateless between runs, whether conversation summaries are scoped, and whether any internal scratchpad/reflection memory can cross audiences.

Required fix: bind every run's hidden state, summaries, loaded memories, and reflections to an output audience. A later run with a different audience must not receive prior hidden state unless that state passes the same audience-compatibility check or an explicit declassification event.

### 5.10 Declassification is not modeled

- `docs/research/privacy-preserving-memory-scoping-in-multi-tenant-ai.md` says summarizing confidential discussion into a broader update is a declassification event that must require authority and audit.
- `docs/memory-security-and-scoping.md`, section "Deletion and Audit Trail", has `ThoughtAuditLog.action` values for create/update/delete/promotion/demotion/sensitivity changes, but no declassification action.
- `docs/the-agents.md`, section "Skills vs Procedural Memory", allows procedural memories to become skills, but does not address whether private/channel memory content is being republished into a wider capability.

This matters because memory-derived content can escape its original audience through summaries, agent configs, skills, procedures, tests, and documentation.

Required fix: add a `declassification_events` table or explicit audit action with `source_scope`, `target_scope`, `actor_id`, `authority`, `source_memory_ids`, `derived_artifact_id`, `justification`, and `approved_at`.

### 5.11 Recall event semantics are underdefined

- `docs/memory-pipeline-design.md`, "Recall Ledger", defines `recall_context` as `semantic_search`, `artifact_lookup`, or `agent_retrieval`.
- The same schema defines `was_injected`.
- Current implementation uses `retrieval_mode` in `ThoughtRecall`, not `recall_context`, and sets `was_injected` after prompt construction.

The docs do not define what happens when the same memory is found by multiple retrieval paths, when framing/procedural memory is loaded outside standard search, or when a memory is retrieved but trimmed out by prompt budgeting.

Required fix: make recall events explicit:

- `retrieved`: candidate returned by a retriever.
- `selected`: chosen for possible prompt inclusion.
- `injected`: actual text included in the model input.
- `visible_token_range`: the part of memory the model actually saw.
- `retrieval_paths`: array of search paths that produced the candidate.

## 6. Highest-Priority Fixes

1. Fix the taxonomy and schema contract. Decide what `memory_type` means and what values exist now versus target.
2. Correct audience-compatibility direction everywhere. This is a security blocker.
3. Define the shared evaluation schema connecting critic, self-eval, reflection, recall signals, and memory capture.
4. Replace phrase-match `was_referenced` with multi-source reference evidence and confidence.
5. Define procedural/framing/episodic schemas before implementing capture.
6. Add source attribution and human correction paths before relying on extracted rationale.
7. Add retention, decay, conflict, and recall-ledger pruning policies.
8. Turn the reranker roadmap into an actual ML design: model, inputs, labels, negatives, debiasing, evaluation, latency, and rollout.
