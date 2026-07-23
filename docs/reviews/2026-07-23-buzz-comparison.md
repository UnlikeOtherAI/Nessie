# Buzz vs Nessie — comparison & improvement report

*Research date: 2026-07-23. Sources: block/buzz clone @ `acfbb1b` (v0.4.23), buzz GitHub issues/PRs via `gh` (169 issues, ~2,325 PRs), UnlikeOtherAI/Nessie tracker, Nessie codebase survey.*

## 1. What buzz is, and how it relates to Nessie

**block/buzz** ("A hive mind communication platform", Rust, Apache-2.0, ~4.9k stars, created March 2026) is Block's self-hostable team workspace where **humans and AI agents are protocol-equal members**. It is directly in Nessie's domain — arguably the closest open-source competitor:

- **The relay is the workspace.** One Rust WebSocket server built on the **Nostr protocol**; every action (message, reaction, workflow step, code-review approval, canvas edit, voice-huddle join) is a cryptographically **signed event** in one append-only log (`ARCHITECTURE.md`).
- **Agents are members, not bots.** Each agent has its own keypair, channel memberships, and audit trail — the same surface as a human. Permissioning an agent = channel membership.
- **Agent runtimes are pluggable** via ACP (Agent Client Protocol): goose, Codex, and Claude Code plug into a pooled harness (`crates/buzz-acp`); Block also ships its own minimal agent.
- Feature set: streams/threads/DMs/forum, per-channel canvases, **git hosting on the relay** (signed commits, branch protection, PR review UI), YAML workflows, voice huddles, agent personas/memory ("engrams"), a community GPU **mesh**, Tauri desktop + Flutter mobile + CLI.

The overlap with Nessie (multi-tenant org→project→team→channel workspace, agents in channels, approvals, triggers/workflows, MCP connectors, token ledger, KB, calls, desktop/mobile clients) is strong. The philosophical difference: buzz bets on **one signed event log + protocol-equal identities**; Nessie bets on **governance** (RBAC, budgets, ledger, approvals, commercial billing separation). Buzz has real external users and ferocious velocity (~674 PRs merged in 3.5 weeks, 23 desktop releases in 12 days); Nessie's GitHub tracker has zero external users — its 171 issues were filed by an AI "Architect agent" pipeline (activity stopped ~June 12; real development moved to direct commits on `main`).

## 2. What users actually want — mined from issues/PRs

### Buzz's users (169 issues, mostly community-filed — including by AI agents themselves)

**The meta-finding: nearly every reliability complaint is really an *observability* complaint.** The dominant failure mode isn't wrong answers — it's **silence with no explanation**:

1. **Silent agent failure** — the biggest cluster. An agent's runtime dies with no signal in the channel and no restart control (#2453); @mentions of offline agents vanish silently (#1743 — filed twice by an agent who noted the duplication proved the bug); all turn failures collapse into a vanishing generic "Turn error" (#1659); credit-exhausted models silently requeue forever (#2265); replies get dropped when the model doesn't call the send tool (PR #2448). Users want a dead agent distinguishable from a thinking one.
2. **Onboarding lockouts** — the top strategic pain. Harness install failure soft-locks the whole app (#2325); users had to read source code to learn "a community is a relay" (#2312); the hosted signup email-verification black hole was the single highest-engagement issue (#2351). Maintainers responded with a 9-PR "onboarding v2" program (~42 onboarding PRs in three weeks).
3. **Natural conversation mechanics** — agents "go deaf" in threads they joined unless re-mentioned (#2270), don't reply unless tagged (#2332).
4. **Agent identity confusion** — the harness never tells the model its own name, so agents attribute their replies to *other agents* in multi-agent threads (#2287); renames desync identity and break mentions (#2423).
5. **Cost anxiety scales with autonomy** — orphaned scheduled workflows that fire forever with no off switch (#1593), empty scheduled runs that still burn tokens (#2297), unattributable failed-turn spend (#1659).
6. **Richer agent-to-agent semantics** — job decline/counter-offer/conditions-of-satisfaction instead of accept-only (#2426, backed by a 216-episode experiment); capability grants that can be issued but not consumed (#2282).
7. **More pluggable runtimes** — OpenCode (#2368), Ollama for local/no-API-key (PR #2464), custom ACP agents (#2278); plus Windows-platform breakage (~15 issues under meta-issue #2388).

### Nessie's own tracker

No external-user signal — all 171 issues are maintainer/AI-pipeline artifacts (~20 already closed `invalid` for describing code that doesn't exist). But the credible open items rhyme with buzz's pain points and with `docs/implementation-phases.md`'s "NOT FIXED" list:

- **Tenant-isolation gaps on the live API**: `/api/mcp/usage` cross-tenant leak (#201), KB/thought-capture scope escalation (#186–#189), OAuth callback trusting `X-Forwarded-*` (#132); plus the phase-2 doc's own list — WS subscriptions bypass channel privacy, agent-bind lacks authz, run execution not idempotent despite an `idempotencyKey` field.
- **Streaming/robustness backlog**: tool-arg corruption from cumulative JSON chunks (#183), unenforced `maxResultSizeChars` (#115), no streaming idle watchdog (#167).
- **Roadmap epics still open**: Active Run Lifecycle API — query/cancel/steer (#141), budget alerts (#40), policy explainability (#41).

## 3. Where each project is ahead

**Buzz is ahead / has ideas worth borrowing:**

- **Uniform signed event log** — audit, chat, approvals, and workflow steps are one queryable substrate with cryptographic provenance; the hash-chained tamper-evident audit chain (`crates/buzz-audit`) is directly portable to Nessie's Postgres audit trail.
- **Agent liveness & failure surfacing** (where it's investing after user pain): per-turn stage latency instrumentation (PR #2460), classified turn failures, harness "capability honesty" tables replacing false config controls (PR #2158). *(Nessie: per-run stage latency landed — every run emits a wall-clock-only `run.timing` `TaskEvent` (queue wait / inference / tool) at completion and failure, read at `GET /api/ledger/runs/timing`; classified turn failures already landed via `run.budget_exhausted`. See `docs/plans/2026-07-20-agent-harness-v2.md` §5.1.)*
- **The ACP seam** — pluggable external runtimes (goose/Codex/Claude Code) behind one pooled harness with per-channel single-in-flight + batching discipline. Nessie's loop is bespoke and closed.
- **Git hosting as a product surface** — PRs, inline diff review, branch protection with required signed approvals, branches-as-channels; Nessie has nothing here.
- **Formally verified multi-tenancy** — TLA+/Tamarin models with mutation-tested guarantees (`docs/multi-tenant-relay.md`), and fan-out access checks *before* subscription registration. Nessie's phase-2 doc admits its WS fan-out still bypasses channel privacy.
- **Docs candor** — an explicit "Known Limitations" table and a "works today / being wired / opinions pending code" README taxonomy.
- Real community, real velocity, real dogfooding (agents file and triage its issues).

**Nessie is ahead:**

- **Governance & commerce**: RBAC policy engine with deny-overrides, budgets, token ledger, approval gates, step-up auth, and the entire UOA/Ledger commercial-authority separation. Buzz has *no rate limiting at all* (a trait with no implementation) and channel membership as its only access gate.
- **MCP connector management**: catalog/library/discovery, dynamic OAuth (RFC 7591/9728/8414 + PKCE), encrypted secret store, scoped sharing, locking, context-safe deferred toolsets. Buzz uses MCP only as the agent's local tool transport.
- **Knowledge & memory stack**: native KB with pgvector hybrid search, RAG fusion, episodic memory (`@nessie/memory`) — richer than buzz's key-value engrams.
- **Comms connectors** (Slack/Gmail ingestion), DeepSignal/DeepWater product integrations, execution environments (remote Docker/gcloud runners), project/kanban management, storage accounting chokepoint.
- Buzz's fragile desktop-as-agent-host model (closing the window kills every agent, #2412) validates Nessie's server-side worker architecture.

## 4. Prioritized improvements for Nessie

Ranked by (user-demand evidence from buzz) × (gap severity in Nessie) × (fit with current direction):

**P0 — Close the known tenant-isolation gaps before growing users.**
Buzz's most damaging bug class is authorization-scope mismatch (undeletable orphaned workflows #1593; filter collapse #2373). Nessie *already knows* its equivalents: WS fan-out bypassing channel privacy, agent-bind without authz, non-idempotent run execution (`docs/implementation-phases.md` "NOT FIXED" items; Nessie #201, #186–#189, #132). Borrow buzz's practice: check access **before** registering realtime subscriptions, and add a tenant-isolation conformance/mutation-test suite (buzz's `docs/multi-tenant-conformance.md`).

**P1 — Kill silent agent failure.** Buzz's users' #1 demand (#2453, #1659, #1743, #2265, #2287). Nessie has the same wound: budget caps fire mid-run and return **empty `finalText` with only a `console.warn`** (`worker/src/run/execute/agent-loop.ts`; `docs/plans/2026-07-20-agent-harness-v2.md` calls it "the single worst UX failure mode" — approved but unscheduled). Schedule harness v2, and add: classified, user-visible failure states on every run; an in-channel notice when a bound agent can't respond (offline/budget-blocked/errored); and an agent liveness indicator distinct from "thinking". This also unblocks Chief-of-Staff.

**P2 — Active Run Lifecycle API: status / cancel / steer / restart.** Buzz users beg for `agents status` + `restart` (#2453) and off-switches for runaway scheduled work (#1593, #2297). Nessie's own open epic #141 covers exactly this; the streaming-robustness items (#183 tool-arg corruption, #167 idle watchdog, #115 result-size cap) belong to the same reliability bundle.

**P3 — Run-attributed cost surfacing + budget alerts.** Buzz shows cost anxiety is the adoption gate for scaling agent rosters (#1659 unattributable failed-turn spend, #2297 empty runs). Nessie has the ledger machinery buzz lacks — the improvement is surfacing it: per-run/per-failed-turn attribution in the UI, budget alerts (open Nessie #40), and a "skip empty scheduled run" precheck for triggers (direct port of buzz #2297).

**P4 — First-run onboarding hardening.** Buzz's top strategic investment (~42 PRs) after lockout pain (#2325, #2312, #2351). Nessie's bootstrap-owner URL + org/project/team concepts + UOA-linking have the same conceptual-overload risk, and its phase-2 doc notes login/SSO still hardcodes bootstrap IDs. Lessons: never hard-block setup on an optional dependency ("Skip for now"), explain the concept model in-flow, make every setup error state actionable.

**P5 — Tamper-evident audit chain.** Cheap, differentiating for a governance-first platform: SHA-256 hash-chain Nessie's `AuditLog` with an advisory-lock single writer and a `verify_chain()` op — a direct port of `buzz-audit`.

**P6 — Thread-following semantics for agents.** Buzz #2270/#2332: agents should stay engaged in threads they've joined (with an anti-loop invariant), not only respond to re-mentions. Nessie's engagement-decision path in the worker is the natural home.

**P7 (strategic, larger) — An ACP adapter as a second execution mode. — DEFERRED BY OWNER DECISION — NOT PLANNED.** Nessie already has `executionMode = external_mcp`; an `external_acp` mode would let orgs bind goose/Codex/Claude Code as Nessie agents — matching buzz's most popular extensibility demand (#2368, #2278, PR #2464) while keeping Nessie's governance (budgets, approvals, ledger) wrapped around foreign runtimes. **Owner decision (2026-07-23): explicitly deferred and not planned — the owner has separate plans for dev orchestration, so an ACP adapter is out of scope for this roadmap.** The richer delegation-semantics idea (decline/counter-offer, buzz #2426) for Nessie's mailbox/subtask system is noted separately and is not affected by this deferral.

**Also worth copying, low effort:** buzz's docs candor — add a verified "Known Limitations" table to Nessie's docs (the phase-2 NOT-FIXED list is already the raw material). And avoid buzz's cautionary tale: it shipped approval-gate schema/API/UI before the executor could suspend/resume, so gated runs just *fail* (WF-08) — Nessie's approvals-in-worker (`actorContext` propagation marked PARTIAL) is one honest end-to-end verification away from the same trap.

**Not worth borrowing:** the Nostr protocol substrate itself (heavy migration, key-management UX is buzz's biggest onboarding wound), desktop-hosted agent runtimes, and the GPU mesh (interesting, but Ledger-metered hosted inference is Nessie's model).

---

*Evidence-quality caveat: buzz citations come from a genuine external community (including agent-filed issues); Nessie's issue numbers cite an AI-generated backlog from the April–June experiment — several were closed `invalid` — so Nessie's `docs/` self-assessments (implementation-phases, agent-harness-v2) were weighted above its tracker.*
