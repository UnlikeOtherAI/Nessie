# Chief of Staff — Proactive Team & Agent-Fleet Optimizer

**Status:** Draft spec — approved direction, not yet scheduled
**Date:** 2026-07-20
**Scope:** Team- and project-level enablement (organization-wide is a later
phase)

## 1. Vision

The Chief of Staff (CoS) is not an assistant and not a chatbot. It is an
internal operational optimizer: a system-managed shared agent that quietly
watches how a team communicates and how its agents perform, extracts durable
knowledge from that activity, and continuously looks for ways to make the team
more effective — without anyone having to ask.

It continuously asks itself:

- What is slowing this team down?
- What is wasting people's time?
- What keeps getting asked?
- What knowledge is hard to find?
- Which agents are not performing as their users intended?
- Who needs help before they ask?

Design principle: it behaves like the best operations manager in the company.
It listens far more than it speaks, notices patterns humans miss because they
are too close to the work, proposes solutions rather than describing problems,
and every recommendation ships with a draft the human can approve — never just
an observation.

The ideal outcome is that after a few months the team does not think of it as
"an AI that reads chat" but as a colleague who keeps making work run a little
more smoothly.

## 2. Hard rules (non-negotiable design constraints)

These are product boundaries, not implementation details. Violating any of
them is the fastest way to destroy trust in the feature.

1. **Recommend, never write config.** The CoS has zero write access to agent
   configuration, tool policies, triggers, channels, or org structure. Its
   only outputs are opportunity-queue entries, briefing messages, and KB
   *drafts*. Humans apply changes through existing owner/admin flows (agent
   edit, Agent Designer, policy-target routes). This keeps it inside Nessie's
   approval-gate ethos and outside every protected-grant landmine
   (DeepWater-style `requiresExplicitGrant` keys, provenance markers, etc.).
   One precise amendment for §3.7: the CoS **may execute** other agents in
   evaluation contexts (probes, rehearsals) and orchestrate
   accepted-recommendation workflows — under strict token budgets, fully
   Ledger-attributed — but configuration mutation and anything user-visible
   or persistent stays human-gated. Acceptance of a recommendation is the
   authorization for its workflow; publish steps remain approval-gated.
2. **No DMs.** Observation sources are team/project channels only. DM and
   `dm_only` content is never read. The enablement UI states this explicitly.
3. **No per-person profiles in v1.** No stored working-style dossiers, no
   working-hours inference, no "who is slow" views. Individual-level findings
   are ephemeral, and are delivered only to the person themselves via their
   Personal Assistant DM — never to their manager or the team channel.
   Team-facing findings are pattern-level and anonymized ("auth questions
   cost ~18 h this month; knowledge is concentrated in one person — here is a
   draft doc"), not named reports.
4. **Silence is a feature.** The CoS says nothing until confidence is high,
   value is clear, the recommendation is actionable, and someone specific
   benefits. Cold start per team is ~2 weeks of pure observation; the
   enablement UI sets that expectation ("first briefing in about two weeks").
5. **Feedback closes the loop.** Every recommendation is accept/dismissible.
   Dismissal lowers confidence for that pattern class so a rejected idea is
   not re-suggested forever.
6. **All inference routes through the standard model chokepoint** (Ledger
   when configured) with full run/agent attribution and cost caps, like every
   other Nessie inference call. Extraction uses a cheap model tier.

## 3. Architecture overview

"Continuously watches" does not fit the agentic loop (12 iterations / 20 tool
calls / 90 s / cost caps). The CoS is therefore a **pipeline with an agent at
the end**, not an agent that watches:

```
observation sources          store + analysis            delivery
─────────────────────        ───────────────────         ─────────────────────
A. agent telemetry   ──┐
   analyzer (SQL +     ├──▶  CosObservation  ──▶  clustering / confidence ──▶
   selective LLM)      │     (structured,          CosOpportunity queue
B. conversation      ──┘      embedded,             (state machine)
   extraction (cheap          dated)                      │
   model, batched)                                        ▼
                                              briefings (rolling digest),
                                              PA DM nudges, Insights tab,
                                              KB drafts
```

The CoS *agent* (system-managed, `agentKind: shared`) appears only at the
delivery end: it writes briefings, drafts KB articles and prompt revisions,
and answers "why did you recommend this?" when spoken to in its channel.

### 3.1 Enablement & provisioning

- Owner/admin toggle per **team** or per **project**, following the
  DeepWater team-enablement pattern (transactional provisioning, advisory
  lock per org/team transition, toggle + rows commit or roll back together).
- Enabling provisions a system-managed CoS agent scoped via the existing
  `Agent.teamId` / `Agent.projectId` columns, bound to the scope's channels
  via `AgentBinding`, by cloning the Personal Assistant bootstrap chain
  (`api/src/services/personal-assistant.ts` →
  `ensure...Team/Agent/Channel/Thread/Binding`).
- A `scheduled` `AgentTrigger` (cron, `worker/src/control/trigger-scheduler.ts`)
  drives the daily/weekly briefing runs. The pipeline jobs (extraction,
  clustering) are worker background jobs, not agent runs.
- Disable removes bindings and stops pipeline jobs; the observation store is
  retained (configurable retention) so re-enable does not cold-start.

### 3.2 Observation source A — agent-fleet watchdog (build first)

Structured telemetry already exists (`Run`, `TokenLedgerEvent`,
`ExecutionUsageLedger`, tool-call events, `AuditLog`, `Task`), so this source
is mostly SQL aggregation plus selective LLM judgment on run transcripts. No
cold-start problem, no privacy concerns (it observes agents, not people), and
it proves the whole store → queue → briefing pipeline first.

Signal catalog:

| Signal | Detection | Flagship recommendation |
|---|---|---|
| Correction loops | User replies "no, I meant…" / re-asks rephrased right after agent output; repeated corrections cluster by topic | Draft system-prompt revision, diff attached, owner applies |
| Waste | Runs hitting iteration/cost caps without accepted output; retry burn; expensive model on trivial tasks | Model/routing-profile change suggestion |
| Tool friction | Repeated attempts at policy-denied tools; granted tools never used | Suggest grant (owner applies via existing policy routes) or trim |
| Abandonment | Agents with no traffic; users going silent mid-task; tasks reopened after agent "completed" them | Retire/merge/repair suggestion |
| Duplication | Near-identical system prompts/configs across teams (embedding cluster) | Consolidate into one shared agent |

### 3.3 Observation source B — conversation mining (build second)

- A worker background pass runs **cheap-model extraction** over new messages
  in batches (per channel, per day) — never per-message full-agent runs.
- Extraction emits structured observations: question-asked, blocker,
  ownership-confusion, document-request, repeated-explanation, delay,
  hand-over, with entities + embedding. The principle is *durable knowledge,
  not transcripts*: "Can somebody send me the deployment guide?" is stored as
  "deployment documentation is difficult to locate", linked to evidence
  message ids, not as message text.
- Detects the friction taxonomy from the vision doc: knowledge problems
  (repeated questions, buried info, single-person knowledge), communication
  problems (slow answers, wrong-team asks, repeated context), process
  problems (slow approvals, review bottlenecks, recurring manual work,
  status-chasing), organizational problems (unclear ownership, duplicated
  work), collaboration problems (same issue in multiple places, experts
  interrupted repetitively).

### 3.4 Data model (sketch)

Two new tables, both fully org/project/team scoped like every child table:

```
CosObservation
  id, organizationId, projectId?, teamId?
  source        enum: agent_telemetry | conversation
  kind          string (taxonomy key, e.g. "repeated_question",
                "correction_loop", "tool_denied")
  summary       string           -- the durable-knowledge phrasing
  entities      Json             -- linked channels/agents/kb pages/topics
  evidenceRefs  Json             -- message/run ids only, never copied text
  embedding     vector           -- pgvector, for clustering
  observedAt, createdAt

CosOpportunity
  id, organizationId, projectId?, teamId?
  kind          string (recommendation class)
  state         enum: observed | confirmed | recommended |
                accepted | dismissed | superseded
  confidence    float            -- rises with corroborating observations,
                                 -- falls on dismissal of the pattern class
  title, recommendation  string
  draftRef      Json?            -- KB draft id / prompt-diff payload
  observationIds Json
  audienceType  enum: team_channel | individual_pa | insights_only
  decidedByUserId?, decidedAt?
  createdAt, updatedAt
```

Lifecycle: observations accumulate → clustering job groups them (embedding +
kind) → cluster crossing a confidence threshold promotes to `confirmed` → the
CoS agent's briefing run turns confirmed clusters into `recommended` entries
with drafts → human accepts or dismisses. Dismissal writes a per-scope
negative prior for that recommendation class.

### 3.5 Delivery surfaces

1. **Briefing digest** (once daily or weekly per scope): reuse the
   DeepSignal rolling-digest skeleton
   (`api/src/services/deepsignal-digest.ts`) — coalesced single message
   updated in place, advisory-locked, budget-capped fresh posts per window —
   generalized out of DeepSignal into a shared digest service rather than
   forked.
2. **Individual nudges** via the recipient's own PA DM only ("three people
   are blocked waiting on your review"), ephemeral, never stored as profile
   data, subject to the same budget caps.
3. **Insights tab** (`admin/src/pages/project/ProjectInsightsTab.tsx`) as the
   durable opportunity-queue UI: list, evidence drill-down, accept/dismiss,
   link to the attached draft.
4. **KB drafts** through existing tools (`kb_draft_write`, `kb_note_add`) —
   e.g. an FAQ article auto-drafted from the 47-times-asked question's actual
   answers, awaiting human review.

### 3.6 New builtin capability

One net-new tool family: a **scope-locked activity analytics tool** for the
CoS agent's briefing runs (aggregate queries over
`CosObservation`/`CosOpportunity` and read-only telemetry aggregates). It
returns aggregates and pattern summaries, never raw message dumps, and is
`requiresExplicitGrant`-style restricted to the CoS agent so ordinary agents
cannot mine team activity.

### 3.7 Agent-to-agent interventions — the CoS as active participant

Beyond observing, the CoS communicates with other agents to improve processes
directly. Grounding — the interaction primitives that exist today:

- **Mailbox** (`worker/src/control/mailbox.ts`): async one-shot dispatch to a
  *named* agent (creates Message + Run + Task for the target, retry/backoff,
  dead-letter). Producers today are workflow `agent_task` steps and
  delegation plans — there is **no agent-facing builtin** to send to a named
  agent's mailbox.
- **`spawn_subtask`** (`worker/src/run/subtask-tools.ts`): creates a fresh
  child-clone agent (copies model/toolPolicy, strips protected grants) in the
  parent's thread; results flow back via shared thread messages.
- **`delegate`** (`worker/src/run/delegate.ts`): ephemeral in-process
  sub-agent, synchronous return, tight budget (4 iterations / 60 s).
- **PA `send_message`** (`worker/src/run/pa-tools/message-delivery.ts`):
  posts *as the requesting user* into a channel and enqueues
  `orchestrate.decide`, so a PA can cause other agents to engage. Normal
  agent replies deliberately do **not** re-trigger orchestration (no
  cascade loops).
- **Workflows** (`worker/src/control/workflows.ts`): the only way to chain
  multiple distinct named agents, via sequential `agent_task` steps.

Intervention capabilities, in order of ambition:

1. **Mystery-shopper probes.** The CoS periodically dispatches synthetic
   test tasks (drawn from real observed usage) to team agents via mailbox
   and scores the responses. Uses: regression-testing after an owner edits a
   prompt or swaps models; drift detection after connector changes; a
   "hiring interview" shakedown for newly created agents (representative
   probes, tool-policy gap check — tools the prompt implies but policy
   denies — and duplication check against the existing fleet). Probe suites
   are stored per agent and re-run on change events.
2. **Rehearsal sandbox — pre-validated recommendations.** Before
   recommending a prompt revision, the CoS spawns a subtask clone carrying
   the revised prompt and **replays the historic conversations that produced
   user corrections** against it. The recommendation ships with receipts:
   "revised agent handled 8/9 previously-corrected conversations — diff and
   transcripts attached." Only possible because Nessie owns the agents,
   their transcripts, and the spawn machinery simultaneously.
3. **CoS ↔ PA symbiosis.** The PA (`delegationMode:
   act_as_requesting_user`) is the privacy-preserving last mile. Downward:
   the CoS hands pattern-level tips to a user's PA via mailbox ("your user
   asked about deployments three times; runbook is at X — surface it when
   relevant"); the PA, with full DM context and the user's identity, picks
   the natural moment. Upward (opt-in): PAs contribute **anonymized**
   friction signals ("my user couldn't find a document about Y") as
   observations, without exposing DM content — sensor coverage where the
   CoS is deliberately blind. Interactive: for low-confidence hypotheses the
   CoS asks instead of guessing — a one-question check delivered via 2–3
   relevant users' PAs; answers adjust confidence.
4. **Repair crews for accepted recommendations.** When a human accepts
   "this should become an FAQ", the CoS dispatches a workflow: Librarian
   agent drafts the KB article from the observed conversations → reviewer
   subtask checks it → `ApprovalRequest` lands with a human for publish.
   The human decision moves from "do the work" to "approve the work".
5. **Matchmaker / traffic control.** Fleet-level pattern spotting: agent A
   repeatedly fails at tasks agent B handles well → recommend a workflow
   chaining them or channel guidance; pending approvals blocking multiple
   runs → context-rich nudge to the approver via their PA ("similar
   approvals granted 40/40 — does this gate still earn its cost?"); two
   teams running near-identical agents → consolidation proposal proven by a
   rehearsal-sandbox run of the merged agent against both workloads.

**Plumbing this requires (net-new):**

- An **`agent_dispatch` / `agent_probe` builtin** (CoS-granted only, via the
  same `requiresExplicitGrant` machinery as DeepWater tools): send a task to
  a named agent's mailbox with an evaluation flag, correlation id, and probe
  budget. Today only workflows/plans can reach named agents.
- **Evaluation-context runs**: probe/rehearsal runs marked so their messages
  live outside normal channels (dedicated eval thread), never ping humans,
  and are excluded from the CoS's own observation ingestion (no
  self-observation feedback loops).
- **Per-agent budget tiers.** The agentic loop is a native multi-step
  tool-calling loop (read a doc, then another…), but capped at 12
  iterations / 20 tool calls / 90 s per run — fine for chat, cramped for
  "audit this agent's last 50 runs". Caps should become per-agent-kind
  tiers so CoS analysis/rehearsal runs get more headroom; `delegate`
  sub-agents stay tight.
- **Agent↔agent multi-turn conversation** is a *gap*: mailbox dispatch is
  one-shot, results return only via shared threads, and agent replies never
  re-trigger orchestration (by design, to prevent loops). If probes need
  clarifying back-and-forth, a bounded conversation primitive
  (correlation-id threaded, max-turns capped, loop-guarded) is a new
  mechanism — deliberately deferred until probe experience proves the need.
- **Probe spend controls**: per-scope probe token budget (Ledger-attributed
  like everything else), probe frequency caps, and probes always use the
  target agent's normal config so results reflect reality.

## 4. Success metrics

Measure improvement, not activity — trends computed from the observation
store itself:

- Repeated questions per topic trending down; time-to-answer trending down.
- KB usage up after CoS-drafted articles land; repeated-explanation
  observations down.
- "Who owns this?" / "where is…?" observations down.
- Agent fleet: correction-loop rate down, capped-run waste down, denied-tool
  retries down after applied recommendations.
- Recommendation acceptance rate (are suggestions actually good?), and
  post-acceptance effect (did the underlying observation rate fall?).

## 5. Phasing

**V1 — agent watchdog end-to-end (prove the skeleton)**
1. `CosObservation` / `CosOpportunity` schema + clustering/confidence jobs.
2. Agent-telemetry analyzer (source A) with the signal catalog above.
3. CoS bootstrap + enablement toggle (team/project), scheduled briefing run.
4. Generalized rolling-digest delivery + Insights-tab queue UI with
   accept/dismiss.
5. Flagship recommendation: draft system-prompt revision with diff.

**V2 — conversation mining (source B) + first interventions**
6. Cheap-model batched extraction pipeline + friction taxonomy.
7. KB-draft recommendations (FAQ from repeated questions).
8. Individual PA-DM nudges (CoS → PA mailbox handoff, §3.7.3 downward path).
9. `agent_probe` builtin + evaluation-context runs + rehearsal sandbox for
   prompt-revision recommendations (§3.7.1–2) — recommendations ship with
   replay receipts.

**V3 — later**
10. Organization-wide scope (cross-team duplication, shared-library
    detection) once multi-team observation data exists.
11. Long-term trend reviews ("is onboarding getting faster?") — free once
    observations have months of history.
12. Repair-crew workflows for accepted recommendations (§3.7.4) and
    matchmaker/approval-gate advisories (§3.7.5).
13. PA upward anonymized signals + one-question PA interviews (§3.7.3) —
    opt-in, after downward trust is established.
14. One-click apply for select recommendation classes (e.g. accepted prompt
    revision opens pre-filled Agent Designer) — still human-confirmed.

**Explicit non-goals (v1/v2):** per-person stored profiles, DM ingestion,
external Slack-workspace ingestion beyond existing team mappings, autonomous
config changes, manager-facing individual reports, unbounded agent↔agent
conversation (only budgeted one-shot probes/dispatches until proven needed).

## 6. Open questions

- Retention policy for `CosObservation` (evidence refs age out with message
  retention; suggested default 180 days).
- Confidence thresholds and dismissal decay — start with simple counts +
  class priors; tune with real data before anything fancier.
- Whether the CoS digest channel is its own system channel per scope (PA
  pattern) or posts into the team's main channel; leaning **own channel** so
  it stays opt-in-visible and never interrupts working channels.
- Pricing/entitlement: is CoS part of the base product or a
  UOA-entitled add-on? (Commercial authority stays with UOA either way.)
- Budget-tier values for CoS analysis/rehearsal runs vs. the standard
  12-iteration / 20-tool-call / 90 s loop caps, and per-scope probe spend
  ceilings.
- Whether probe/rehearsal transcripts are surfaced to agent owners verbatim
  or only as scored summaries (leaning verbatim — receipts build trust).
- Shape of a future bounded agent↔agent conversation primitive
  (correlation-threaded, max-turns, loop-guarded) if one-shot probes prove
  insufficient.
