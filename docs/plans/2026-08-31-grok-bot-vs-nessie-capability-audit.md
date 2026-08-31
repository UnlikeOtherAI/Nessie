# Grok Bot vs. Nessie — capability audit

> Status: audit complete, 2026-08-31. Read-only; no code changed.
> Method: Nessie claims are grounded in code (file + line). Cross-checked by
> three parallel readers — this session, `kimix`, and `codex sol` — with every
> external claim verified against the tree before it was accepted.
> Next step: Fable turns this into recommendations. This document states *where
> we stand*, not what to build.

## 0. Read this first — the benchmark is a claim-list, not the Grok doc

The "reference doc" we were handed is **not** the full Grok Bot writeup. It is a
bracketed placeholder that enumerates Grok Bot's *claimed* capabilities
(persistent per-user Linux VM shared across a user's Bots; cloud
browser+terminal+files; MCP/plugins; 2–6 Bot group chats up to 50 Bots; durable
Bot memory; routines + learn-by-demonstration; async 24/7; approval cards +
model-based Auto-review + secure-secret handoff; user-is-the-boundary /
Bots-not-a-security-boundary shared creds; product-managed routing with failover
and no model picker; prompt-injection / "Cryptographic Context Injection"
exposure; "org-wide action audit coming"; no public Bot orchestration API;
cloud-only). We benchmark Nessie against those claims. **We cannot verify any of
them against Grok's implementation** — they are the competitor's own
description. Claims we think are especially soft are flagged in §5 so we don't
chase a phantom.

## 1. Headline answer

**No — a Grok Bot cannot do strictly *more* than a Nessie user working with
Nessie agents. The two lead in different places, and the honest summary is a
split decision, not a loss.**

- **Grok is ahead on one axis that matters: turnkey, unsupervised computer-use
  at cloud scale.** A persistent hosted Linux VM per user, a full driveable
  browser (click/type/scroll), a general terminal, and learn-by-demonstration
  skill capture. Nessie has *most of the machinery* for this but ships it in a
  deliberately narrower, safer form (below), and two of the headline verbs are
  not shipped at all.
- **Nessie is ahead on everything an organisation buys a platform *for*:**
  hard multi-tenant isolation, per-user credential placement, a tamper-evident
  per-org audit hash-chain, disclosure/provenance gates that stop cross-channel
  exfiltration, semantic per-agent memory, and a self-healing scheduler. Grok's
  own doc concedes several of these ("org-wide audit coming",
  "Bots-are-not-a-security-boundary", indirect-injection exposure).

So: **a Grok Bot can *act* on the open computer more freely; a Nessie
agent operates inside a governed, auditable, multi-tenant boundary a Grok Bot
does not have.** For a single power user who wants an agent to "just go do it on
a computer," Grok is ahead today. For an organisation putting many people's
agents on shared infrastructure, Nessie is ahead.

## 2. Per-dimension verdict table

| # | Dimension | Verdict | One-line evidence |
|---|-----------|---------|-------------------|
| 1 | Persistent execution environment | **Behind (partial)** | Real executor micro-VM exists but is **BYO-machine + ephemeral per-run**, not a hosted persistent per-user VM; separate docker/gcloud provisioning is workflow-only. `executor/src/`, `worker/src/run/execute/run-setup.ts:208`, `worker/src/control/execution/*` |
| 2 | Computer use / actuation | **Behind (partial)** | Open-URL + bounded observe + COW file r/w + Codex/Claude coding session — but `browser.act` (click/type) and `command.run` (shell) are **declared-only, not shipped**. `worker/src/run/executor-toolset.ts:82-108`, `executor/src/daemon.ts` |
| 3 | Tools / MCP | **Ahead** | Full connector mgmt + dynamic OAuth (RFC 7591/9728/8414/PKCE/8707) + App Store off the official registry; HTTP/SSE-only, default-OFF grants. `packages/mcp-manage/`, `packages/mcp-manage/src/oauth-discovery.ts` |
| 4 | Multi-agent collaboration | **Ahead / Parity** | delegate + spawn_subtask (child agents) + durable mailbox + unbounded channel bindings + model-judged engagement; **no artificial 2–6/50 cap**. `packages/runtime/src/orchestrator.ts`, `worker/src/run/delegate.ts`, `worker/src/control/mailbox.ts` |
| 5 | Memory | **Ahead / Parity** | pgvector semantic store, RRF(k=60) hybrid recall, per-agent-private + audience scoping, run consolidation. `packages/memory/`, `packages/retrieval/src/thoughts.ts` |
| 6 | Routines / scheduling / demo-learning | **Split: scheduling Ahead, demo-learning Behind** | 5 trigger types + self-healing health/reauthorize (the silent-failure bug is *fixed*), but **no learn-by-demonstration — no code found**. `worker/src/control/trigger-health.ts`, `api/src/routes/triggers.ts` |
| 7 | Async / offline operation | **Parity** | Server-side worker, Postgres `queue_jobs` w/ `SKIP LOCKED`, scheduler sweep, non-interactive auto-continue. `packages/runtime/src/queue.ts`, `worker/src/index.ts:565` |
| 8 | Approvals / HITL / auto-review | **Behind** | Approval cards exist, but chat approvals **block-and-return** (re-run with `approvalProof`), not suspend/resume; **no model-based auto-review**. Only the workflow engine truly suspends/resumes. `worker/src/run/execute/tool-authorization.ts:151`, `api/src/services/approval-effects.ts` |
| 9 | Credential / secret isolation | **Ahead** | AES-256-GCM store, per-user OAuth token slots, per-org/scope DB isolation, least-priv agent principals. `packages/runtime/src/secret-crypto.ts`, `McpServerCredentialOverride` |
| 10 | Security / prompt-injection posture | **Ahead (infra) / caveat** | Disclosure sink + IP-pinned egress vs. DNS-rebinding + structural intent; but untrusted-framing of raw live MCP results is **not uniform**. `worker/src/run/execute/disclosure-basis.ts`, `packages/runtime/src/url-safety.ts` |
| 11 | Model routing | **Split: control Ahead, failover Behind** | Per-agent model picker + Ledger `/v1/:serviceId` chokepoint, but **no automatic cross-provider failover** (`FailoverReason` is a misnomer). `packages/runtime/src/ledger-identity.ts`, `worker/src/run/error-classification.ts:147` |
| 12 | Audit / telemetry / enterprise control | **Ahead** | Per-org tamper-evident SHA-256 audit hash-chain + owner-only verify endpoint; token/timing ledger. Grok's is "coming". `packages/db/src/audit-chain.ts`, `api/src/routes/audit-log.ts` |

## 3. Dimension detail (evidence)

### 1 — Persistent execution environment — Behind (partial)
Nessie has **three** distinct execution stories; only conflating them makes it
look like a hosted cloud computer, which it is not:

- **The Executor** (`executor/`, `packages/executor-manage/`,
  `worker/src/run/executor-toolset.ts`) — a paired daemon that boots a **Linux
  micro-VM via Apple's `Virtualization.framework`** on a *user's Mac* (Developer
  ID desktop build; the sandboxed App Store build deliberately omits it —
  `desktop/src-tauri/src/executor_companion/runtime.rs`). Sessions are
  **ephemeral per `runId` and time-boxed** — coding 20 min, browser 10 min, with
  a **copy-on-write workspace discarded on stop**
  (`executor/src/coding-session-manager.ts:14`,
  `executor/src/browser-session-manager.ts:15`,
  `executor/src/sandbox-workspace.ts:319,539`). A headless daemon variant is
  documented, so a self-hosted server *could* be enrolled as an executor
  (`docs/plans/2026-08-11-executor-integration/delivery-and-verification.md:33`).
- **Sandboxed builtin file/http tools** (`file_read/file_write/file_glob/http_fetch`)
  operate on the *worker process's* filesystem confined to `allowedRoots`, which
  is **empty by default → every call throws** unless an org configures it
  (`worker/src/run/builtin-handlers/sandbox.ts:74-78`,
  `packages/runtime/src/builtin-tools-sandboxed.ts:5-10`).
- **Workflow execution environments** — `worker/src/control/execution/` *does*
  provision docker containers / gcloud VMs / Cloud Run jobs, but for **workflow
  `environment_launch` steps**, not as a free agent tool
  (`packages/schemas/src/jobs.ts:245`, `docker-provider.ts`, `gcloud-provider.ts`).

**Verdict:** No Nessie-hosted persistent per-user computer shared across a
user's agents (the doc `2026-08-11-executor-integration.md:423` explicitly
decides "a user machine is not a `docker` or `gcloud`"). Grok's persistent
hosted VM is ahead on *convenience and persistence*; Nessie's per-run micro-VM
is ahead on *isolation* (§9). **No code found** for e2b/firecracker/gvisor/
kubernetes/fargate agent sandboxes or a "DeepTest" runtime.

### 2 — Computer use / actuation — Behind (partial)
What an agent can actually actuate today, gated by per-agent tool policy **and**
an exact executor-binding bundle (`worker/src/run/executor-toolset.ts:198-208`):

- `executor.browser.open` (navigate to one approved HTTPS URL) +
  `executor.browser.observe` (bounded DevTools target state — title/url/type,
  64 KB, **no screenshot, no DOM, no input injection**)
  (`executor/guest/browser_runtime.go`, `executor-toolset.ts:82-90`).
- `executor.file.list/read/write` against the reviewed COW workspace root
  (read ≤ 8 KB, write ≤ 64 KB) (`executor-toolset.ts:51-81`).
- `executor.coding.launch` (a single prompt string that starts a **Codex/Claude
  CLI agent in a tmux pane inside the guest VM**) + `executor.coding.observe`
  (typed lifecycle only, 8 KB; raw terminal output stays in the guest)
  (`executor/guest/coding_runtime.go`, `executor/src/coding-session-manager.ts:44-49`).

**Not shipped, though declared in the catalog:** `browser.act` (click/type/scroll)
and `command.run` (general argv/shell) have **no model-facing schema and no
daemon handler** — they fall through to `null` and are never dispatched
(`executor-toolset.ts:104-108`, `executor/src/daemon.ts`). Playwright/puppeteer
appear **only** in dev/verification harnesses, never in the agent runtime.

**Verdict:** Grok's full cloud browser (drive any web app without an API) +
general terminal is genuinely ahead. Nessie's actuation is narrower by design —
open+observe, COW files, and a delegated coding agent — but the coding-session
route is a real, powerful lane for software work.

### 3 — Tools / MCP — Ahead
`packages/mcp-manage` is one shared connector-management core (catalog, instance
install/probe/projection, per-principal credentials, encrypted secret store,
OAuth, library/discovery) used by both API routes and the worker's PA tools.
Dynamic OAuth is fully implemented: **RFC 9728** resource-metadata discovery,
**RFC 8414** AS metadata, **RFC 7591** dynamic client registration, **PKCE
S256**, **RFC 8707** resource indicators (`oauth-discovery.ts:11-353`). The App
Store reads `McpCatalogEntry` and imports from the official registry
(`registry.modelcontextprotocol.io`, bounded at 20 000 records —
`library.ts:252`, `registry/registry-import.ts`; note: **no hardcoded "5500"** —
that's a live-registry count, not a constant). User-authored connectors are
**HTTP/SSE remotes only — stdio is banned** at catalog/instance/dispatch
boundaries (`mcp-security.ts:105-125`, `mcp-catalog-guards.ts:60`). Installing is
not granting: tools default-OFF via `requiresExplicitToolGrant`
(`mcp-tool-registry-projection.ts:13`). This is at least at parity with, and
arguably richer than, Grok's "MCP/plugins."

### 4 — Multi-agent collaboration — Ahead / Parity
Three cooperation mechanisms: **`delegate`** (ephemeral in-process sub-agent,
fixed small budget — 6 iters / 10 tool calls / 30 k tokens — capped
`NESSIE_MAX_DELEGATES_PER_RUN`=16, cannot recurse —
`worker/src/run/delegate.ts`, `run-budget.ts:79-122`); **`spawn_subtask`**
(creates a durable child `Agent` row with `parentAgentId`, its own run/task,
`agent.spawned` event — `worker/src/run/subtask-tools.ts:45-206`); and a durable
**mailbox** for agent-to-agent delivery (`agent_mailbox_messages`,
`FOR UPDATE SKIP LOCKED`, dead-letter after 3 —
`worker/src/control/mailbox.ts`). Many agents can bind to one channel and a
**model-judged engagement decision** picks who replies vs. reacts
(`packages/runtime/src/orchestrator.ts:109-363`,
`worker/src/run/orchestrate.ts`), with a one-reply-per-turn anti-stampede
guarantee. There is **no artificial "2–6 Bots per chat / 50 max" ceiling** —
bindings are unbounded and governed at reply-time (`agent-bindings.ts:28-128`).
Grok's group-chat cap is a product limit Nessie simply doesn't impose.

### 5 — Memory — Ahead / Parity
`packages/memory` writes a `thoughts` table with pgvector embeddings,
`memory_type` (episodic/semantic/procedural), `memory_category`
(intent/reason/constraint/preference/fact), plus `thought_reasonings`,
`thought_recalls`, and audit logs (`capture.ts:214-394`). Recall is **hybrid**:
`match_thoughts_hybrid` does RRF(k=60) + recency fusion in SQL
(`api/prisma/migrations/20260408193000_*`,
`packages/retrieval/src/thoughts.ts`). Scoping is two orthogonal axes — an
**audience** axis (user/channel/team/project/org) and a genuine **per-agent
private** axis (`private_to_agent_id`), enforced in `match_thoughts_in_scopes`
and contained to the destination (`packages/memory/src/scopes.ts`). Learned
preferences are `memory_category='preference'` thoughts; run summaries are
consolidated to durable thoughts (`consolidate.ts`). This matches or exceeds
Grok's "durable Bot memory," and the disclosure-aware scoping is something Grok's
doc does not claim.

### 6 — Routines / scheduling / learn-by-demonstration — Split
Scheduling is **ahead**: five trigger types (manual/scheduled/webhook/event/
interval — `packages/schemas/src/lifecycle.ts:68`), a server-side sweep, and a
fully-built **self-healing health system** — `TriggerLaunchOriginError` reason
codes, `needs_reauthorization` vs `error`, once-per-transition alert keyed by
`health_revision`, and `POST /api/triggers/:id/reauthorize`
(`worker/src/control/trigger-origin.ts`, `trigger-health.ts:46-133`,
`api/src/routes/trigger-lifecycle.ts:41`). **The silent-failure bug named in the
task brief is fixed** — the header comment in `trigger-health.ts` records the
19-day incident it closes. `schedule_task` (schedule *me*, no owner rights) and
`agent_trigger_create` (schedule *another* agent, owner-only) are distinct
(`builtin-schedule-tools.ts`, `builtin-agent-tools.ts:152`).

Learn-by-demonstration is **behind — no code found**. Broad searches
(`demonstrat|record.?a.?skill|teach.?mode|watch.?me.?do|replay.?action|macro`)
return nothing. Routines are explicitly authored (triggers/workflows/to-do
templates), never captured from user actions. This is a real Grok lead.

### 7 — Async / offline operation — Parity
Runs execute in a standalone worker off a Postgres `queue_jobs` table with
`FOR UPDATE SKIP LOCKED` and lease renewal (`packages/runtime/src/queue.ts:151-256`);
the API only inserts a row. Scheduled/interval triggers fire from a 15 s
server-side sweep with no client present (`worker/src/index.ts:565`,
`trigger-scheduler.ts`). Non-interactive runs auto-continue up to
`NESSIE_RUN_AUTO_CONTINUATIONS` (default 2) (`execute/continuation.ts`). Both
platforms work 24/7 while the user's device is off — parity.

### 8 — Approvals / HITL / auto-review — Behind
Approval cards exist (`approval.needed`/`approval.resolved` realtime events,
admin surface, `GET/POST /api/approvals`). But the mechanics are weaker than
Grok's claim:

- **In-chat tool approval is a block, not a suspend/resume.** A gated tool
  returns `{ type: 'tool_denied', reason: 'approval_required' }` to the model and
  the loop continues; the only way past is to **re-issue the run with an
  `approvalProof`** already attached (`worker/src/run/execute/tool-authorization.ts:151-177`,
  `execute/policy.ts:95-141`, `packages/workspace-admin/src/policy-check.ts:46`).
  The `waiting_approval` run status is **never written** (only failed on expiry),
  and `ApprovalRequest.continuationToken` has **zero consumers** — vestigial
  suspend/resume machinery (`api/src/services/approvals.ts:317-327`).
- `ApprovalRequest` is a **deferred-action ticket**: propose → human resolves →
  the *server* runs the effect. Only two effects exist — knowledge-page publish
  and to-do-template publish; everything else is a no-op
  (`api/src/services/approval-effects.ts:117-133`).
- **No model-based auto-review** anywhere. "Review" in the codebase is *human*
  owner review of discovered MCP tools, not an LLM checking a proposed action.
- The **workflow engine is the exception** — it has genuine step suspend/resume
  choreography and `awaiting_approval` steps (`worker/src/control/workflows.ts`,
  `docs/plans/2026-08-12-workflows-first-class.md`).

**Verdict:** roughly parity on the *surface* (approval cards), behind on the
*substance* (no true mid-run HITL suspend/resume for arbitrary tools, no
auto-review). Grok's model-based Auto-review + secure-secret handoff is a real
lead if its own claims hold (flagged in §5).

### 9 — Credential / secret isolation — Ahead
AES-256-GCM at rest under a per-deployment key (`secret-crypto.ts:14`), opaque
`secret_*` refs (a caller-supplied ref can never select an arbitrary process
secret — `secret-resolver.ts:27`), and **per-user OAuth token placement** via
`McpServerCredentialOverride` (principalType user/agent/channel/team/project/org,
unique per instance+principal). Beyond the MCP token store there is a separate
**scoped secret vault backed by Infisical** with scoped grants
(`use`/`reveal`/`manage`/`delegate`) — `api/src/routes/secrets.ts:18-28`,
`api/src/services/infisical-vault.ts` — so operator/team secrets are held in a
real vault, not env. Multi-tenancy is DB-enforced —
`organizationId` appears ~311× in the schema, composite `(organizationId, id)`
FKs, and a runtime `validateRunActorContext` that hard-fails a tenant mismatch
(`execute/policy.ts:190-256`). This is the **direct opposite of Grok's model**,
whose own doc says the user is the boundary and Bots share cookies/creds/CLI on
one VM. On isolation Nessie is decisively ahead.

### 10 — Security / prompt-injection posture — Ahead (infra), one caveat
Strong infrastructure: the **disclosure sink** (`ConsumedSourceSink` →
`computeReplyBasis` → `runReplyIsRestricted`) stamps a provenance basis on every
reply and cuts the live streaming lane the moment a run consumes a privileged
source — a real anti-exfiltration boundary Grok's doc doesn't claim
(`worker/src/run/execute/disclosure-basis.ts`). **IP-pinned egress**
(`safeFetch`/`pinnedFetch`) resolves once and pins the socket against
DNS-rebinding, blocks localhost/link-local/metadata/CGNAT/ULA, and re-validates
each redirect hop (`packages/runtime/src/url-safety.ts`), used by every MCP/
web_fetch/http_fetch/comms/push egress path. **Caveat:** untrusted-framing is
*not uniform* — explicit `BEGIN/END UNTRUSTED EXTERNAL DATA` wrappers exist for
dashboard data-source results and for compaction/checkpoint re-entry, but raw
live MCP tool results get middle-out truncation without a blanket untrusted
wrapper at insertion (`worker/src/run/pa-tools/dashboards.ts:319`,
`context-compaction.ts:10`; not found in `mcp-toolset.ts`). Both platforms remain
exposed to indirect injection through tool content; Nessie's *containment* of
what a compromised run can leak is stronger.

### 11 — Model routing — Split
Nessie routes all inference through the Ledger `/v1/:serviceId` chokepoint so
Kimi/MiniMax/DeepSeek/custom adapters can't fall through the OpenAI route
(`packages/runtime/src/ledger-identity.ts:162`), with per-provider adapters
(`worker/src/run/inference-provider.ts`). Unlike Grok, Nessie **exposes a
per-agent model picker** (Agent Designer `ModelCombobox` + reasoning-effort
presets — `admin/src/components/features/agents/designer/AgentDesignerForm.tsx`).
But there is **no automatic cross-provider failover** — `FailoverReason` is a
misnomer; `resolveRecovery` only does same-provider retry / compact-and-retry /
surface-error / fail (`worker/src/run/error-classification.ts:147-201`). Grok's
product-managed routing *with failover* is ahead on reliability; Nessie is ahead
on explicit control. Different philosophies, each with a real cost.

### 12 — Audit / telemetry / enterprise control — Ahead
Per-organisation **tamper-evident SHA-256 audit hash-chain**
(`entryHash = sha256(canonicalJson(fields, prevHash))`, advisory-locked append,
`verifyAuditChain` returning the first broken link) with an **owner-only verify
endpoint** `GET /api/audit-log/verify` (`packages/db/src/audit-chain.ts`,
`api/src/routes/audit-log.ts`). Plus an owner-gated token/usage/timing ledger
(`api/src/services/token-ledger.ts`, `run.timing` TaskEvents in
`worker/src/run/execute/run-timing.ts`) isolated at `/ops/usage` from customer
billing. Grok's doc lists "org-wide action audit coming" — i.e. not shipped.
Nessie is clearly ahead, and the hash-chain (cryptographic non-repudiation) is a
capability Grok's doc doesn't claim even as a roadmap item.

## 4. The biggest gaps where Grok is genuinely ahead

1. **Turnkey persistent cloud computer.** Grok hands every user a hosted,
   always-there Linux VM. Nessie's executor is BYO-machine (a paired Mac /
   headless daemon) with per-run, time-boxed micro-VM sessions. Zero-setup
   persistence is a real convenience gap.
2. **Full browser computer-use + general terminal.** Grok drives any web app
   (click/type/scroll) and runs a shell. Nessie ships open-URL + bounded observe
   and *no* general shell — the click/type (`browser.act`) and shell
   (`command.run`) verbs are declared but **not implemented**.
3. **Learn-by-demonstration.** Grok records a user's actions into a reusable
   skill. Nessie has **nothing** here; routines are hand-authored.
4. **Model-based Auto-review + true mid-run approval suspend/resume.** Grok
   claims an LLM reviewer plus approval cards. Nessie has neither an
   action-reviewing model nor real suspend/resume for arbitrary gated tools
   (only workflow steps suspend; chat approvals block-and-re-run).
5. **Managed routing with failover.** Grok fails over between models
   automatically; Nessie fails the run and asks an owner to fix config.

## 5. Where Nessie is genuinely ahead

1. **Hard multi-tenant isolation.** Per-org DB scoping, composite-FK tenancy,
   runtime actor-context validation, and a **per-session micro-VM with no
   ambient credentials** — versus Grok's explicit "Bots are not a security
   boundary, creds are shared on one VM." (§9, §1)
2. **Per-user credential placement + encrypted secret store.** One user's OAuth
   token is not reachable by another user's agents on the same connector. (§9)
3. **Tamper-evident per-org audit hash-chain with a verify endpoint** — Grok's
   audit is "coming." (§12)
4. **Disclosure / provenance gates** that structurally stop a run from leaking a
   privileged source into a room its audience can't read. (§10)
5. **Disclosure-aware semantic memory** with per-agent-private + audience
   scoping. (§5)
6. **A self-healing scheduler** that classifies its own failures, alerts once per
   transition, and offers explicit reauthorization. (§6)
7. **Governance-grade MCP**: dynamic OAuth, default-OFF grants, stdio banned,
   admin locking. (§3)
8. **No artificial multi-agent cap** and a durable agent-to-agent mailbox. (§4)

## 6. Notable risks on either side

**Grok-side (from its own claimed design):**
- User-is-the-boundary / shared creds means one compromised Bot (e.g. via
  indirect prompt injection / "Cryptographic Context Injection") can reach every
  cookie, credential, and CLI the user has on that VM. High blast radius.
- No org-wide audit yet → limited forensic/attribution capability for
  enterprises.
- No model picker → no escape hatch when the managed router picks a bad model.

**Nessie-side (honest internal risks):**
- **Declared-but-unshipped executor verbs** (`browser.act`, `command.run`) are a
  Rule-zero trap: they exist in catalogs and could read as "we have computer
  use" when the actuation surface is much narrower. Any product copy must not
  claim full computer-use.
- **Approval semantics are weaker than the UI implies** — "approval required" is
  a block that needs a re-run, and only two effects actually execute on approve.
  The `waiting_approval` status and `continuationToken` are vestigial. A buyer
  expecting mid-run human-in-the-loop for arbitrary tools would be surprised.
- **Untrusted-framing of live MCP results is not uniform** — a real
  indirect-injection surface until every external tool result is framed at
  insertion, not just at compaction/checkpoint.
- **Workflows are "in delivery"** (a guarded sequence runner, not a DAG) and the
  first-class doc itself lists correctness defects being closed — the suspend/
  resume that *does* exist lives here and should be treated as maturing.
- **Executor requires the Developer ID desktop build** (App Store build omits
  it), so the strongest actuation lane is unavailable to a chunk of the install
  base.

## 7. Grok claims flagged as unconfirmed / possible phantoms

We benchmarked against these but **could not verify any** — treat as the
competitor's marketing until proven:
- "**Persistent per-user Linux VM shared by all a user's Bots**" — plausible but
  unverified; the sharing model and persistence guarantees are asserted, not
  shown.
- "**Model-based Auto-review**" and "**secure-secret handoff**" — the exact
  mechanism (what the reviewer model gates, how secrets are handed off without
  exposure) is undescribed. Don't assume it's stronger than a prompt-level check.
- "**Cryptographic Context Injection**" — this reads as a *named vulnerability
  class*, i.e. a stated **weakness**, not a feature. Do not mistake it for a
  capability.
- "**Up to 50 Bots / 2–6 per chat**" — specific product caps we can't confirm;
  Nessie imposes none, so this is a Grok limitation more than a Nessie gap.
- "**Learn-by-demonstration**" — real if it ships, but the fidelity (does it
  generalise, or replay brittle coordinates?) is unknown. Worth confirming before
  treating it as a decisive lead.
- "**Org-wide action audit coming**" — explicitly *not shipped* by their own
  wording; a roadmap item, not a current capability.

## 8. Cross-checker reconciliation

Three readers ran this audit in parallel (this session + `kimix` + `codex sol`).
`kimix` produced a full structured report; `codex sol` produced an exploration
transcript rather than a final report before it was stopped, and its
code-grounded observations were extracted from that transcript. Every Nessie
claim carries a code citation verified against the current tree. Where an
external reader asserted something the code did not support, it was dropped
rather than averaged in.

The load-bearing, non-obvious findings were **independently corroborated by all
three** and re-verified against code: executor is real but BYO-machine +
ephemeral per-run; `browser.act` **and** `command.run` are declared in the
logical-tool catalog but have no schema/handler (both unshipped, not just
`browser.act`); approvals don't suspend/resume (the `waiting_approval` status is
never written and `continuationToken` has zero consumers — re-verified, despite a
`thread-serialization.ts` comment describing the *intended* resume that isn't
wired); no automatic model failover; no learn-by-demonstration; audit hash-chain
shipped.

Two points surfaced by `kimix` were **verified against code and folded in**: the
Infisical-backed scoped secret vault (§9) and the dead `InferenceRoutingMode`
schema (§11). Nothing in this document rests on an unverified external claim —
the only "as-asserted, to confirm" items are the **Grok-side** benchmark claims
in §7, which cannot be checked against Grok's code.
