<!-- markdownlint-disable MD013 -->

# Codex Agent Architecture Review

Scope reviewed:

- `docs/the-agents.md`
- `docs/multi-agent-memory-system.md`
- `docs/agent-base-template.md`
- `docs/research/evolving-agent-runtime-enterprise-grade.md`

Verdict: the documents describe an ambitious agent runtime, but they do not yet define a coherent system. They repeatedly claim "self-improving", "self-modifying", "agent creation", "skills", and "delivery guarantees" without specifying the actual state machines, permissions, schemas, failure semantics, concurrency controls, or versioning rules needed to make those claims real. The architecture is directionally plausible. It is not executable as a design.

## 1. Contradictions

### 1.1 Agent creation is both minimal and supposedly goal-enforced

- `docs/the-agents.md`, section "Creating an Agent", says only `name` is required for `POST /api/agents`; `role`, `systemPrompt`, `parentAgentId`, `toolPolicy`, `provider`, and `model` are optional, and `role` defaults to `"assistant"`.
- `docs/agent-base-template.md`, section "Goal", says "An agent with no goal should not exist" and "The system should reject agent creation without at least a role."
- `docs/the-agents.md`, section "The Agent Object", also says `role` is `TEXT NOT NULL DEFAULT 'assistant'`.

That is not a goal requirement. A default `assistant` role is a placeholder, not a declared goal. These docs disagree on whether the API accepts under-specified agents or rejects them.

Required fix: define the minimum valid agent creation contract. If `role = assistant` is acceptable, stop claiming goalful creation is enforced. If goalful creation is required, `role` plus either `systemPrompt`, template, or structured goal must be mandatory.

### 1.2 The agent model is "universal", but there are two incompatible agent models

- `docs/agent-base-template.md`, opening paragraphs, says every built-in, user-created, and spawned child agent conforms to the base template.
- The same file, section "In-Memory Types (Legacy Orchestrator)", defines `ManagedAgent` with fields `type`, `responsibility`, `trigger`, `tools`, `intervalMinutes`, `lastRunAt`, and `nextRunAt`.
- `docs/the-agents.md`, section "Database Record", defines persisted agents with `role`, `status`, `system_prompt`, `tool_policy`, `provider`, `model`, `parent_agent_id`, `organization_id`, `project_id`, and `team_id`.

These are not the same contract. `ManagedAgent.type` includes `coder`, `weather`, and `custom`; the role tables use `orchestrator`, `builder`, `reviewer`, `researcher`, `debugger`, and `watcher`. Scheduling fields exist only in the legacy type. Capability fields such as `canSpawn`, `canMutateFiles`, and `requiresReview` are declared as "must declare" later in `agent-base-template.md`, but they are absent from the persisted agent schema and inferred from role policy in `the-agents.md`.

Required fix: either delete the "universal" claim or define an explicit migration/convergence model with one canonical `Agent` contract and adapters for legacy runtime state.

### 1.3 Tools and skills are mapped inconsistently to OpenClaw

- `docs/the-agents.md`, "OpenClaw Alignment", maps OpenClaw "Skills (SKILL.md)" to the `skills` table and OpenClaw "Tools (typed functions)" to the target Tool Registry.
- `docs/agent-base-template.md`, "OpenClaw Mapping", maps OpenClaw "Skills directory" to "Role registry + tool policy", described as "Tools available to agent."
- `docs/multi-agent-memory-system.md`, "OpenClaw Alignment", says OpenClaw "Skills (tools)" map to "Tool call history feeds procedural memory capture."

Those are three different mappings:

1. skills table,
2. role/tool policy,
3. tool-call history for procedural memory.

This is not harmless terminology drift. The design depends on strict separation between tools, skills, procedural memory, and role policy. The docs blur exactly the boundary they need to enforce.

Required fix: create one vocabulary table and make all documents use it. Tool = executable typed action. Skill = reviewed reusable runbook/plan. Procedural memory = unreviewed discovered procedure. Role policy = authorization profile. Do not call OpenClaw skills "tools" in one doc and "skills" in another.

### 1.4 Skill lifecycle statuses conflict

- `docs/the-agents.md`, "Public Skills", says promotion is `draft -> tested -> approved -> public`.
- `docs/the-agents.md`, "Skill Schema (Database)", defines `skills.status` as `(draft, testing, approved, deprecated)`.
- The same schema defines `skill_versions.status` as `(draft, pending_review, approved, rejected, deprecated)`.
- `docs/research/evolving-agent-runtime-enterprise-grade.md`, "Persistent learned-skill library", says promotion is `candidate skill -> tested skill -> approved skill -> deprecated skill`.

There is no single lifecycle. "public" is sometimes a status and sometimes visibility. "tested" is sometimes a status, but the DB uses `testing`. "candidate" exists only in prose. `rejected` exists only on versions. There is no `published_at`, active version pointer, rollback target, or invariant tying `skills.version` to `skill_versions.version`.

Required fix: split lifecycle into separate fields:

- `visibility`: `private | shared | public`
- `status`: `draft | testing | pending_review | approved | rejected | deprecated | archived`
- `active_version_id`
- immutable `SkillVersion` records with promotion and rollback semantics.

### 1.5 Public skills "cannot be deleted", but private deletion is undefined

- `docs/the-agents.md`, "Public Skills", says public skills "Can be deprecated but not deleted."
- No document defines deletion, archival, tombstoning, dependency checks, grants cleanup, or behavior for private skills used by agents/plans.

The docs imply one retention rule for public skills and none for private skills. That is a broken reference model: a private skill can still be used by a plan template, agent, task, or run audit trail.

Required fix: define deletion as tombstoning for all referenced skills. Physical deletion should be allowed only when no runs, plans, grants, or versions reference the skill.

### 1.6 Plan status and task status do not compose

- `docs/the-agents.md`, "Plan Structure", defines plan statuses `(draft, active, blocked, completed, failed, cancelled)`.
- `PlanStep.status` is `(pending, running, done, failed, skipped)`.
- `Task.status` is `(inbox, assigned, in_progress, review, done, failed, cancelled, awaiting_approval)`.
- The plan execution section says approval steps pause and create approval requests, but `PlanStep.status` has no `blocked`, `awaiting_approval`, `cancelled`, `timed_out`, or `retrying`.

A plan step that waits for approval cannot represent its own actual state. It must be either `running`, `failed`, or `pending`, none of which is correct. Child task cancellation and timeout cannot be reflected at the plan-step level.

Required fix: align state machines. At minimum, `PlanStep.status` needs `blocked`, `awaiting_approval`, `cancelled`, `timed_out`, and `retrying`, or it needs a normalized execution state table.

### 1.7 Run status differs across docs and flow diagrams

- `docs/the-agents.md`, "Run Record", uses `pending, running, completed, failed, cancelled`.
- `docs/agent-base-template.md`, "Run Execution Flow", says "Create Run record (status: queued)".

`queued` and `pending` are not the same if a worker queue exists. The docs use them interchangeably without defining whether a run is pending before enqueue, queued after enqueue, or running when leased.

Required fix: define run lifecycle precisely: `created/pending -> queued -> leased/running -> completed/failed/cancelled/timed_out`, or collapse terms consistently.

### 1.8 Current implementation is overclaimed

- `docs/the-agents.md`, "What This Gets Right", claims "Full auditing: Every tool call recorded with input/output/duration/success."
- The same file, "What This Gets Wrong", says only three hardcoded safe tools actually execute.
- `docs/the-agents.md`, "Have (Working)", lists "Spawn system", "Review gates", "Approval gates", "Task ledger", and "Watcher/monitoring" as working in `src/`.
- `docs/agent-base-template.md`, "Gaps and Limitations", says no task decomposition, no inter-agent communication, no self-correction, passive memory, no procedural memory, no framing memory.

The documents conflate "legacy `src/` code exists" with "the actual API/worker architecture has this capability." The project rules say legacy code lives in `src/` and new code goes elsewhere; the docs simultaneously cite `src/` as working architecture and describe it as a parallel legacy runtime.

Required fix: every "Have" row must say whether it exists in production API/worker, legacy local orchestrator only, or design-only. Right now the implementation inventory is not trustworthy.

### 1.9 Memory type enum claims do not match proposed memory storage

- `docs/multi-agent-memory-system.md`, "What We Have", says `memory_type` currently supports `intent, reason, constraint, preference, fact`.
- The same document proposes storing episodic memory as `memory_type = 'experience'`, procedural memory as `memory_type = 'procedure'`, and framing memory as `memory_type = 'framing'`.
- Its "Storage Format by Type" table treats `experience`, `procedure`, and `framing` as direct `thoughts.memory_type` values.

The document clearly says the current enum does not contain the proposed values, but later sections read like the unified model already supports them.

Required fix: separate current enum, target enum, and migration steps. The implementation sequence partially does this, but the design sections should not imply unavailable types are already part of the model.

### 1.10 "Capture everything" contradicts privacy, minimization, and not storing raw logs

- `docs/multi-agent-memory-system.md`, "Volume Policy", says "Capture everything at ingestion. Dedup prevents redundancy."
- The same file, "What NOT to Store", says not to store raw conversation logs long-term, noise, repetition, trivial facts, or ephemeral task state.
- `docs/research/evolving-agent-runtime-enterprise-grade.md`, "GDPR", says the system must design for data minimization, retention limits, and access controls.

"Capture everything" is not compatible with data minimization or the document's own "What NOT to Store" rules unless "capture" means "capture everything into the extraction classifier, not into long-term memory." The docs do not make that distinction.

Required fix: replace "capture everything" with an explicit ingestion policy: retain raw events in audit/message tables under retention limits, extract candidate memories through filters, and promote only compressed validated memory records.

### 1.11 Agent status model cannot represent actual multi-agent execution

- `docs/the-agents.md`, "Agent Status Lifecycle", has one mutable `Agent.status`.
- The same document allows concurrent spawns and multiple bound channels.
- `docs/agent-base-template.md`, "Channel Bindings", says an agent can be bound to multiple channels.

A single global `Agent.status` does not compose with multiple simultaneous runs, multiple channels, or mailbox work. If one agent has two active runs, is it `thinking`, `executing`, `waiting_approval`, or `error`? The docs never say whether runs are serialized per agent, per channel, per thread, or globally.

Required fix: define execution leasing. Either enforce one active run per agent and queue everything else, or move status to `AgentRun`/`Run` and derive aggregate agent status.

### 1.12 `offline` exists as a status but has no detection mechanism

- `docs/the-agents.md`, "Agent Status Lifecycle", includes `offline (remote worker unreachable)`.
- `docs/agent-base-template.md`, "Status Lifecycle", also includes `offline (remote worker down)`.

Neither document defines worker registration, heartbeats, lease expiry, reconnect behavior, or transition rules back to `idle`. `offline` is a state with no state machine.

Required fix: define worker heartbeat records, timeout thresholds, lease ownership, stale-run handling, and recovery transitions.

## 2. Gaps

### 2.1 Agent-creation-by-agent is not designed

The docs repeatedly imply agents can create other agents:

- `docs/the-agents.md`, hierarchy section: agents form trees.
- `docs/the-agents.md`, current flow: keyword spawn creates a child agent/run/task.
- `docs/agent-base-template.md`, spawn request fields include `role`, `label`, `toolScope`, `timeoutSeconds`, and `modelOverride`.
- `docs/research/evolving-agent-runtime-enterprise-grade.md`, executive summary targets an "agent that can iteratively build and program itself."

What is missing:

- No `CreateAgent` tool schema.
- No `AgentTemplate` schema.
- No required inputs for a generated agent: goal, role, model, provider, tool policy, memory policy, scope, channel bindings, budget, review policy, owner, lifecycle policy.
- No authorization rule for which parent roles may create which child roles.
- No validation that generated `systemPrompt` is safe, scoped, and non-conflicting.
- No deterministic path from user-provided data to database insert.
- No post-create activation workflow: bind to channel, warm memory, test prompt, dry run, approve, enable.
- No audit object linking "agent A created agent B because of plan step C."

The spawn system creates task workers. It is not an agent builder.

### 2.2 No skill exists for creating agents from structured intake

The user-provided-data path is absent. There is no skill or workflow that takes:

- user goal,
- domain data,
- constraints,
- allowed tools,
- target channels,
- examples,
- success criteria,
- ownership,
- budget,
- lifecycle rules,

and deterministically produces:

- validated `Agent` row,
- optional `AgentConfigVersion`,
- bindings,
- grants,
- default memories,
- dry-run test,
- activation state.

The current `POST /api/agents` contract accepts raw `systemPrompt` text. That is not deterministic agent construction; it is manual prompt storage.

Required design: an `agent-builder` skill with structured intake, schema validation, policy checks, generated prompt sections, deterministic DB writes, dry-run evaluation, and rollback.

### 2.3 Agents cannot modify their own skills/tools/prompt in the concrete docs

The research doc gestures at this:

- `AgentConfigVersion`
- `ToolDefinition`
- `ToolVersion`
- `ChangeRequest`
- `POST /agents/:id/proposals`

But `docs/the-agents.md` has no `AgentConfigVersion`, no `ChangeRequest`, and no self-edit meta-tool. `docs/agent-base-template.md` says `systemPrompt` defines the agent but does not define how it changes. The skill schema supports agent authorship but not agent self-modification.

Missing mechanics:

- `ProposeAgentConfigChange` tool schema.
- diff format for prompt/toolPolicy/model/provider changes.
- approval matrix by risk level.
- automated checks for prompt regressions and policy violations.
- active version pointer.
- rollback endpoint.
- immutable history and reason/evaluation links.
- rule for whether an agent may propose changes to itself, descendants, siblings, or templates.

Without these, "self-modifying" means "the model can talk about modifying itself."

### 2.4 Missing-skill handling is not designed

The docs say agents see a compact skill index and load full skill definitions on demand. They do not say what happens when no skill matches.

Missing:

- Is a missing skill reported to the user, created as procedural memory, proposed as a candidate skill, or escalated to a builder?
- Who decides whether to create a skill versus execute ad hoc?
- What minimum evidence is required before skill creation?
- Can an agent draft a skill from user-provided instructions without first executing it?
- How are missing-skill requests deduplicated?
- How are skill creation requests prioritized and budgeted?

Required design: `SkillGap` or `CapabilityGap` records with deduplication, owner, proposed schema, expected tools, risk, demand count, and promotion path.

### 2.5 Agent discovery is shallow and channel-bound

`docs/agent-base-template.md`, "What Agents Know About Each Other", says agents know hierarchy, channel bindings, and same-channel messages. `docs/the-agents.md`, channel orchestrator, says routing evaluates bound agents.

Missing:

- No agent registry search API.
- No capability index by skills, tools, role, domain, load, cost, or trust tier.
- No discovery protocol for "which agent can do X?"
- No cross-channel/project discovery policy.
- No way for agents to advertise capabilities.
- No way to deprecate or hide agents from routing.
- No distinction between "can see an agent exists" and "can message/delegate to it."

The design supports channel routing, not agent discovery.

### 2.6 Agent versioning, rollback, deletion, and archival are absent

Skills and tools have versions in some places. Agents do not.

Missing:

- `AgentConfigVersion` in the canonical agent docs.
- active config pointer.
- rollback endpoint.
- deletion semantics.
- archival semantics.
- handling of existing messages/runs/tasks when an agent is deleted.
- uniqueness after archival: can a new agent reuse the same name?
- retention policy for child agents spawned for one task.
- cleanup of bindings, category links, grants, mailboxes, memories, approval requests.

This is a major hole because agent behavior is configuration. If prompts and policies are mutable without versioning, audits are meaningless.

### 2.7 Agent templates and cloning are absent

The base template defines universal fields, but there is no actual template system.

Missing:

- `AgentTemplate` schema.
- template versioning.
- clone-from-template flow.
- override rules.
- inherited vs copied fields.
- template deprecation.
- migration of cloned agents when templates change.
- dry-run tests per template.
- library of system templates for builder/reviewer/researcher/debugger.

The docs use "template" conceptually but do not design templates as product/runtime objects.

### 2.8 Error recovery across the full chain is mostly hand-waved

The docs mention "retry within budget OR escalate" in several places, but do not define recovery semantics.

Missing cases:

- Planner emits invalid JSON.
- Planner emits impossible dependencies or cyclic `depends_on`.
- Plan step succeeds but acceptance criteria fail.
- Tool times out after mutating external state.
- Tool returns malformed output.
- Child agent dies.
- Worker crashes after marking a step running but before writing output.
- Parent agent dies while children continue.
- Mailbox result arrives after parent plan is cancelled.
- Reviewer fails or times out.
- Approval request is never answered.
- Budget is exhausted midway through file edits.
- Self-eval fails after successful execution.
- Skill promotion tests fail after procedure capture.

Required design: idempotency keys, leases, heartbeats, retry policies by step/tool kind, compensating actions, partial result policy, timeout state, orphan reaper, and run/plan reconciliation.

### 2.9 Concurrent access to shared resources is not addressed

The architecture allows multiple agents and concurrent spawns. It also allows builders to mutate files. Nothing defines locking.

Missing:

- file/team locks.
- plan-level write sets.
- conflict detection.
- merge/rebase strategy.
- two agents editing the same file.
- one agent reading stale code while another writes.
- external resource locks for deploys, database migrations, and shared environments.
- lock timeout/recovery.
- priority/preemption.
- deadlock prevention.

The docs mention max concurrent spawns but not shared resource concurrency. That limit only controls fan-out; it does not protect state.

### 2.10 Token and cost accounting is too vague

Budget objects exist:

- `maxIterations`
- `maxWallclockMs`
- `maxToolCalls`
- `maxTokens`
- `maxCostCents`

But accounting is not designed.

Missing:

- ledger schema.
- per-agent, per-run, per-plan, per-step, per-tool, per-skill cost attribution.
- prompt tokens vs completion tokens vs embedding tokens vs reranker tokens.
- tool execution cost.
- sandbox compute cost.
- web/API third-party cost.
- inherited child-agent budget rules.
- hard-stop semantics when a child overruns.
- reservation vs actual spend.
- refunds/reconciliation on failed provider calls.
- UI/reporting model.

The budget fields are caps, not accounting.

### 2.11 Rate limiting and backpressure are not designed

The research doc says enterprise controls include rate limits and later mentions per-user/per-agent rate limits. That is it.

Missing:

- queue architecture.
- worker leases.
- priority classes.
- per-org concurrency caps.
- per-provider rate limit adaptation.
- backpressure from tool gateway/sandbox.
- mailbox queue draining.
- fairness across agents.
- starvation prevention.
- cancellation policy under overload.
- what users see when capacity is exhausted.

Without this, "many agents active" will collapse into provider 429s, DB contention, and runaway queues.

### 2.12 Mailbox delivery guarantees are named but not specified

`docs/the-agents.md`, "Agent Mailbox", says "DB-backed message bus with delivery guarantees." The schema has `queued`, `delivered`, `processed`, and `failed`.

Missing:

- guarantee level: at-most-once, at-least-once, exactly-once illusion with idempotency.
- message leasing/visibility timeout.
- ack protocol.
- retry count.
- dead-letter queue.
- ordering rules.
- duplicate handling via idempotency/correlation keys.
- delivery timeout.
- fan-out semantics for broadcast.
- transactional coupling to plan-step updates.
- behavior when recipient is offline.

The words "delivery guarantees" are unsupported by the schema.

### 2.13 Plans lack transactionality and partial rollback

The plan schema has dependencies, input, output, and acceptance criteria, but no transaction/compensation model.

Missing:

- step side-effect classification.
- rollback/compensation steps.
- checkpoint artifacts.
- changed-file patch references.
- external side-effect references.
- partial completion contract.
- plan resume after crash.
- plan cancellation semantics.
- parent-child budget and state reconciliation.

For code changes, "rollback" cannot be a vague word. It needs patch/artifact tracking and a restore policy.

### 2.14 Security model for self-generated tools is incomplete

The research doc has a Tool Registry and sandbox options. The canonical agent doc places Tool Registry in Phase 5 after skills, mailbox, evaluation, and memory integration.

This ordering is dangerous. If skills can be authored by agents in Phase 3 and public/shared skills can affect agents, but the Tool Registry and sandbox come later, the system has self-authored capabilities before it has a secure capability substrate.

Missing:

- skill safety classification.
- whether skills can include executable code or only instructions.
- sandbox requirement before any generated tool use.
- signature/provenance model.
- dependency pinning.
- prompt-injection scanning for skill instructions.

Required fix: put Tool Registry/sandbox/security gates before agent-authored public skills or any generated code path.

### 2.15 `toolPolicy` override semantics are ambiguous

`docs/the-agents.md`, "Role Policy Structure", says enforcement checks whether the tool is in `allowedTools`, then whether `toolPolicy` overrides it. The example grants `Bash` to a `researcher` with `{ "Bash": true }`. `docs/agent-base-template.md`, "Tool Policy", says `toolPolicy` is `Record<string, boolean>`.

Missing:

- Does `true` add a tool even if the role denies it?
- Does `false` deny a tool even if the role allows it?
- How do you express "inherit" after an override?
- Can `toolPolicy` override risk gates or only role defaults?
- Are overrides allowed for critical tools?
- Who can set overrides?

This field is too powerful to remain a boolean map.

Required fix: replace it with explicit policy entries: `tool_id`, `state: inherit | allowed | denied`, `scope`, `risk_cap`, `set_by`, `reason`, `expires_at`, and approval metadata.

## 3. Limitations

### 3.1 The design tries to build the final platform before proving the loop

The documents include plans, skills, mailbox, evaluation, reflection, procedural memory, framing memory, personalization, learned rerankers, sandbox tiers, SOC2/GDPR, local-first filtering, and self-modification. The current runtime is still single-shot with keyword pre-tools.

This is over-scoped. The immediate architectural dependency is native tool calling plus a persisted run loop. Everything else should be subordinate to that. The docs say this in places, but then scatter database schemas and future systems across multiple documents as if they are equally ready.

### 3.2 The memory design is overconfident about self-eval

`docs/multi-agent-memory-system.md` calls agent self-eval a "strong" signal and "the secret sauce." That is not justified. Self-eval is another model output, susceptible to hallucinated usefulness, self-justification, and hindsight bias.

The design needs adversarial treatment:

- self-eval should be weak until validated by outcomes,
- procedural capture should require concrete tool traces,
- skill promotion should require tests and reviewer approval,
- memory updates that affect many agents need stricter gates.

### 3.3 One `thoughts` table for all memory types may become a junk drawer

The "one table, many types" rule is simple, but the proposed memory types have very different access patterns:

- semantic facts need vector/lexical retrieval,
- procedures need structured step execution and confidence stats,
- framing needs stale path validation,
- personalization belongs on user parameters,
- experiences need situation/action/outcome retrieval.

Keeping all of this in `thoughts.metadata` may work early, but it will create weak constraints, hard migrations, and poor query ergonomics. At minimum, typed side tables may be needed for procedure steps, framing entry points, and experience triples.

### 3.4 Role policies are too coarse for real capability control

Current roles use tool lists and booleans: `canSpawn`, `canMutateFiles`, `requiresReview`. This will not scale to self-modifying agents.

Missing dimensions:

- data scope,
- environment scope,
- egress scope,
- file path scope,
- max risk level,
- approval requirements by tool and argument,
- credential scope,
- generated-code permission,
- self-edit permission.

A builder with `Bash` and `FileWrite` is not a policy. It is a broad hazard.

### 3.5 Skill injection as a compact index can blow up without ranking and paging

The docs say skill metadata is always present and full content is loaded on demand. That fails when an org has hundreds or thousands of skills. There is no ranking threshold, pagination, top-K limit, embedding index, or role/scope prefilter design.

### 3.6 The docs rely too much on LLM routing for hard control decisions

The channel orchestrator and future router use LLM decisions. That may be fine for intent classification, but not for authorization, budget enforcement, risk gates, or privacy boundaries. The docs need a deterministic policy engine before and after LLM classification.

### 3.7 The architecture has no crisp MVP boundary

The phase list says each phase produces something usable, but several phases depend on later safety systems:

- Skills before Tool Registry/sandbox.
- Mailbox before delivery semantics.
- Memory integration before self-eval validation.
- Self-modification claims before change requests land in canonical docs.

The result is a roadmap that can produce impressive demos before it produces safe or reliable behavior.

## 4. Missing Designs That Need Full Specs

### 4.1 Agent builder skill/workflow

Needs a full design, not a paragraph.

Required objects:

- `AgentTemplate`
- `AgentConfigVersion`
- `AgentCreationRequest`
- `AgentCreationEvaluation`
- `AgentActivation`

Required flow:

1. Intake structured user data.
2. Normalize role, goal, scope, tools, budget, memory access, review gates.
3. Select template.
4. Generate prompt from deterministic sections.
5. Validate policy.
6. Create agent in disabled/draft state.
7. Bind channels only after validation.
8. Run dry-run tasks.
9. Approve/activate.
10. Store immutable version and audit trail.

Required deterministic outputs:

- `agents` row,
- config version row,
- bindings,
- initial skill grants,
- memory access policy,
- budget profile,
- activation state.

### 4.2 Structured user data to deterministic agent insert

The docs need a schema such as:

```json
{
  "name": "string",
  "goal": "string",
  "role": "builder|researcher|reviewer|debugger|custom",
  "domain": "string",
  "allowedTools": ["FileRead"],
  "forbiddenTools": ["Bash"],
  "scope": {
    "organizationId": "uuid",
    "projectId": "uuid",
    "teamId": "uuid",
    "channelIds": ["uuid"]
  },
  "memoryPolicy": {
    "read": ["semantic", "framing", "procedure"],
    "write": ["semantic"],
    "visibility": "project"
  },
  "budget": {
    "maxTokensPerRun": 50000,
    "maxCostCentsPerRun": 50
  },
  "successCriteria": ["string"],
  "requiresReview": true
}
```

Then it needs validation rules, defaults, transformations, and exact DB writes. Right now the design accepts free text and hopes the prompt is good.

### 4.3 Skill promotion pipeline

The docs say:
successful run -> self-eval captures procedural memory -> human/agent promotes to candidate skill -> tests pass -> skill approved.

Missing full design:

- candidate extraction schema,
- evidence requirements,
- generated input schema derivation,
- test generation rules,
- sandbox execution,
- reviewer assignment,
- version creation,
- active version pointer,
- rollback,
- deprecation,
- stats attribution,
- failure handling,
- permissions for agent-authored skills.

This pipeline is central to "self-improvement." It cannot remain a sentence.

### 4.4 Inter-agent mailbox delivery guarantees

Needs a full spec:

- delivery guarantee level,
- ordering model,
- leases,
- retries,
- ack/nack,
- dead-letter queue,
- idempotency keys,
- correlation semantics,
- transactional update with plan steps,
- broadcast fan-out,
- offline recipient behavior,
- retention and cleanup,
- security checks.

The current schema is a message table, not a message bus.

### 4.5 Plan failure recovery and partial rollback

Needs a full spec:

- plan step side-effect types,
- checkpointing,
- artifact capture,
- compensation steps,
- retry policy,
- resume policy,
- cancellation policy,
- failure propagation from child to parent,
- rollback of code changes,
- external side-effect limitations,
- user-facing partial result contract.

"Retry within budget or escalate" is not a recovery design.

## 5. Self-Modifying Agents

The design is not yet capable of producing agents that build other agents, create their own tools, write their own skills, and improve autonomously. It describes prerequisites, not the actual mechanism.

### 5.1 What exists conceptually

The docs correctly identify important primitives:

- native tool calling,
- agentic loop,
- plans,
- critic/evaluation,
- reflection,
- skills,
- procedural memory,
- Tool Registry,
- sandboxing,
- approvals,
- audit trails.

That is the right vocabulary.

### 5.2 What is missing for real self-modification

To actually work, the system needs:

- Meta-tools:
  - `create_agent`
  - `propose_agent_config_change`
  - `create_skill_candidate`
  - `promote_skill_version`
  - `create_tool_candidate`
  - `run_tool_tests`
  - `request_approval`
  - `rollback_agent_config`

- Versioned behavior:
  - `AgentConfigVersion`
  - active config pointer
  - config diffing
  - rollback and archival
  - immutable audit history

- Capability gap workflow:
  - detect missing skill/tool,
  - decide build vs ask human vs ad hoc execution,
  - create candidate,
  - test,
  - approve,
  - publish.

- Safe generated tool pipeline:
  - source of truth,
  - sandbox build,
  - unit/integration tests,
  - static analysis,
  - dependency scanning,
  - risk classification,
  - approval,
  - deployment,
  - rollback.

- Deterministic policy engine:
  - what the agent may modify,
  - whose approval is required,
  - what risk tier is allowed,
  - which scopes are affected,
  - what budget applies.

- Evaluation that has teeth:
  - tests as primary signal,
  - LLM critic as secondary signal,
  - failed eval blocks promotion,
  - repeated failure lowers trust/capability.

Without those, the agent can only propose text about self-improvement. It cannot safely or reliably improve itself.

### 5.3 The biggest architectural flaw

The docs treat "agent improves over time" as a memory problem. It is not primarily a memory problem. It is a change-management problem.

Memory can suggest improvements. It cannot safely apply them. Self-modifying agents require:

- versioned configuration,
- governed change requests,
- deterministic validation,
- sandboxed execution,
- approvals,
- rollback,
- audit.

Those pieces exist mostly in the research doc, not in the canonical agent/base/memory designs. Until they are promoted into the canonical architecture, "self-modifying planner-executor-critic" is a slogan, not a system.

## 6. Highest-Priority Fixes

1. Define one canonical agent contract and remove or explicitly quarantine the legacy `ManagedAgent` model.
2. Add `AgentConfigVersion`, `AgentTemplate`, `AgentCreationRequest`, and `AgentActivation` to the canonical docs.
3. Specify the `agent-builder` workflow from structured intake to deterministic DB insert and dry-run activation.
4. Move Tool Registry, sandbox, and change-request governance earlier in the roadmap, before agent-authored public/shared skills.
5. Replace all skill lifecycle prose with one lifecycle state machine and active version model.
6. Define mailbox delivery semantics with leases, retries, dead-lettering, idempotency, and ordering.
7. Define plan recovery: retries, compensation, rollback, cancellation, crash resume, and partial results.
8. Add resource concurrency controls: per-agent run serialization, file/team locks, external resource locks, and conflict detection.
9. Add a real cost ledger: per agent, run, plan, step, tool call, skill execution, and provider request.
10. Add queue/rate-limit/backpressure design across router, planner, worker, tool gateway, sandbox, mailbox, and provider clients.

## 7. Bottom Line

The docs are useful as a vision map. They are not yet a buildable architecture for self-modifying multi-agent systems.

The fatal gaps are not model quality or memory retrieval. The fatal gaps are lifecycle control: creation, versioning, approval, rollback, failure recovery, concurrency, delivery guarantees, budget accounting, and backpressure. Until those are specified, adding more agents, skills, and memory will increase system entropy faster than system capability.
