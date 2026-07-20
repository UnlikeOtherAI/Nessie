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

1. **Recommend, never write.** The CoS has zero write access to agent
   configuration, tool policies, triggers, channels, or org structure. Its
   only outputs are opportunity-queue entries, briefing messages, and KB
   *drafts*. Humans apply changes through existing owner/admin flows (agent
   edit, Agent Designer, policy-target routes). This keeps it inside Nessie's
   approval-gate ethos and outside every protected-grant landmine
   (DeepWater-style `requiresExplicitGrant` keys, provenance markers, etc.).
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

**V2 — conversation mining (source B)**
6. Cheap-model batched extraction pipeline + friction taxonomy.
7. KB-draft recommendations (FAQ from repeated questions).
8. Individual PA-DM nudges.

**V3 — later**
9. Organization-wide scope (cross-team duplication, shared-library
   detection) once multi-team observation data exists.
10. Long-term trend reviews ("is onboarding getting faster?") — free once
    observations have months of history.
11. One-click apply for select recommendation classes (e.g. accepted prompt
    revision opens pre-filled Agent Designer) — still human-confirmed.

**Explicit non-goals (v1/v2):** per-person stored profiles, DM ingestion,
external Slack-workspace ingestion beyond existing team mappings, autonomous
config changes, manager-facing individual reports.

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
