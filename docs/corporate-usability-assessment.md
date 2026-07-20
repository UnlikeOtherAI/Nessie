# Corporate Usability Assessment

**Question:** Is Nessie usable to automate the tasks of an organisation — automating work, distributing work across people and agents, running organisational workflows?

**Method:** 10 review agents, each taking a distinct corporate-usability lens, every claim grounded in the actual `api/`, `worker/`, `admin/`, `packages/`, `src/`, and `docs/` source rather than the project's marketing framing.

**Status:** reviewed. An adversarial pass (6 reviewers + independent re-judging of every disputed claim) verified each citation against source. Findings held up on substance; several overstated claims were corrected — see [Adversarial review corrections](#adversarial-review-corrections) at the end.

---

## Verdict

Mean readiness **4.0 / 10**. No lens rated Nessie enterprise-ready; none rated it unusable.

The consistent picture: a genuinely well-architected enterprise core is being built in `api/` + `worker/`. The `nessie` CLI launches that modern stack (api on 5554, admin on 5555, worker), but the **root `npm` scripts (`dev`/`start`) still default to the legacy single-user `src/` server**, and most of the controls an organisation depends on are either stubs or explicitly labelled "target-state design."

**As an org-wide automation and work-distribution platform: not usable today.** The single most important capability for the stated goal — distributing and handing off work *among people* — does not exist in the data model at all; the system only orchestrates AI agents.

**As a single-team, self-hosted, text-chat agentic assistant with scheduled automations:** the new `api/`+`worker/` stack is a credible foundation, roughly 60–70% complete on scheduling and tenancy, suitable for a controlled pilot only after the blockers below are closed.

---

## Scores by lens

| Lens | Verdict | Score |
|------|---------|------:|
| Automation / recurring workflows | usable-with-caveats | 6 |
| Multi-tenant / scale | usable-with-caveats | 6 |
| Knowledge-worker UX | usable-with-caveats | 5 |
| Voice-first viability | usable-with-caveats | 4 |
| Procurement / governance | not-ready | 4 |
| Security & compliance | not-ready | 3 |
| Work distribution (the core ask) | not-ready | 3 |
| Integration architecture | not-ready | 3 |
| SRE / reliability | not-ready | 3 |
| IT admin / fleet deployment | not-ready | 3 |

---

## The four findings that directly answer "can it distribute work / automate an org?"

### 1. It cannot assign work to people — only to agents

> **RESOLVED** — commit `2b21b0b` (2026-05-30): human work distribution shipped. `Task` now carries `assigneeUserId` and `ownerUserId`; `/api/tasks` endpoints support assign, hand-off, and route-to-approver flows; the admin Work page exposes a human work queue. The original finding is preserved below for context.

~~The `Task` and `PlanStep` models carry `agentId` / `assignedAgentId` but **no human assignee/owner field anywhere** in `api/`, `worker/`, or `admin/`. There is no human work queue, no ownership, no hand-off, no reassignment. "Roles" are agent capability profiles (orchestrator / builder / reviewer / watcher / researcher / debugger), not job functions or people. Approvals can be resolved by any non-requester org member — there is no routing to a named approver or role.~~

~~- `api/prisma/schema.prisma:1601` — `Task` model: `agentId` required, no assignee/userId~~
~~- `src/orchestration/task-types.ts:32` — `Task` interface has only role + threadId, no person~~
~~- `src/orchestration/role-registry.ts:11` — roles are tool-capability policies~~
~~- `api/src/services/approvals.ts:119` — any non-requester org actor can resolve~~

~~This is the defining requirement for organisational work distribution and it is absent. (Note: the codebase *does* have a real claim/handoff work queue — `AgentMailboxMessage`, `schema.prisma:1072` — but it is strictly agent-to-agent, which reinforces rather than softens the finding: the system orchestrates AI agents, not people.)~~

### 2. Two products, and the insecure one runs by default

Root `dev`/`start` launch the legacy `src/index.ts`, whose `/mcp` JSON-RPC surface exposes `invoke_tool → Bash`/screenshot with **no per-user identity, auth disabled entirely when no key is set, a single shared static key otherwise**, and self-advertises `_nessie._tcp` over mDNS. The strong multi-tenant `api/` server exists, but the advertised orchestration tools (tasks / spawn / reviews / approvals) still live only in the legacy server; the `api/` MCP routes only manage connectors.

**Scope correction (adversarial review):** the unauthenticated state is **loopback-only** — the server binds `127.0.0.1` by default (`src/index.ts:30,678`), and binding to a non-local host triggers a fail-fast guard that *refuses to start* without an API key (`src/index.ts:175-177`). So "unauthenticated" and "network-reachable" are mutually exclusive in the default config. The real risk is a **local** unauthenticated RCE on the developer's machine plus an mDNS service-name leak — serious for a multi-user host, but not a network-wide RCE broadcast.

- `package.json` scripts `dev`/`legacy:dev` → `bun run src/index.ts`
- `src/index.ts:139`, `src/mcp/server.ts:469` — unauthenticated tool dispatch (loopback)
- `src/index.ts:30,678` — binds `127.0.0.1` by default; `:175-177` — non-local bind requires a key
- `src/index.ts:214` — mDNS advertisement of the legacy server

### 3. No turnkey corporate integrations, and credentials don't flow

The MCP client/connector spine is well-built (official SDK, stdio/http/sse, backoff, a catalog with a draft→pending→approved publishing flow). But the only seeded connector is Context7, a no-auth docs server. There is **zero Jira / Confluence / Slack / email / calendar / ticketing** code. The credential plane is stubbed: resolved secrets are never injected into outbound connector transports, and OAuth tokens persist only in an in-memory store that throws in production. Any authenticated SaaS connector cannot work end-to-end today.

- `api/src/db/seed-connectors.ts:35` — only Context7 seeded
- `api/src/services/secret-resolver.ts:28` — `EnvSecretResolver` stub, KMS resolver is `TODO(phase3)`, never consumed in `worker/`
- `api/src/services/mcp-instances.ts:478` — comment confirms no injection in the resolver; `worker/` MCP dispatch passes no credential
- `api/src/routes/mcp.ts:46` — startup guard throws in production when no OAuth secret store is injected (the in-memory stub itself returns a ref, it does not throw)

### 4. You would be flying blind

No metrics, alerting, or tracing in the shipping stack — `run_validators` / `get_metrics` / `get_alerts` exist only in the legacy `src/mcp` server, not imported by `api/` or `worker/`. The health check is a static `{status:'ok'}`. The token ledger accounts for cost after the fact but has no budget/quota/cap enforcement, so org-scale LLM spend is unbounded and unmonitored. Failed *trigger deliveries* are passively visible in the admin TriggersPage, but the queue-level `dead` status and the mailbox dead-letter path have **no admin view at all**, and there is **no proactive alerting/paging anywhere** — so a permanently-failed automation goes unnoticed unless someone manually inspects the right trigger.

- `api/src/index.ts:1287` — static health check
- `src/mcp/server.ts:913` — validators/metrics/alerts only in legacy
- `packages/runtime/src/queue.ts:128` — `dead` status written but never read or surfaced
- `worker/src/control/mailbox.ts:148` — `dead_letter` status, no admin surface
- `api/src/services/token-ledger.ts:25` — cost estimation, no budget enforcement

---

## What genuinely works (the bones are real)

**Scheduling / triggers — best subsystem (6/10).** Lease-based claim with `FOR UPDATE SKIP LOCKED` and a 60s lease, dedupe keys, IANA-timezone-aware cron, a shared scheduling module so API and worker math cannot drift, retry-with-cap plus a dead-letter queue, and admin visibility into per-trigger delivery history. The worker runs as a standalone process (or embedded in the API in local mode) driven by a Postgres queue, so recurring jobs fire regardless of whether anyone is at the Mac. It re-verifies the creating user's channel membership at fire time and degrades to an autonomous run if access was revoked.

- `packages/runtime/src/scheduling.ts:29`, `worker/src/control/trigger-scheduler.ts:34`, `worker/src/control/trigger-run.ts:276`

**Multi-tenancy (6/10).** Normalised Organization→Project→Team→Channel→User schema with `organization_id` on child tables, HS256 session tokens carrying org/proj/team/sub/roles claims, ~40 handlers scoping every query to the verified `organizationId` plus channel-membership checks, 45 ordered Prisma migrations, a real scoped RBAC policy engine with deny-overrides, and working OIDC SSO with PKCE.

- `api/prisma/schema.prisma:505`, `api/src/auth/session.ts:52`, `api/src/services/policy.ts:72`, `api/src/services/external-auth.ts:59`

**Knowledge-worker chat (5/10).** Slack-style workspace with channels, DMs, agent @mentions, and an auto-provisioned "Personal Assistant" DM running a real agentic loop with safety budgets (max 12 iterations / 20 tool calls / 90s / cost cap). Knowledge-worker tools are wired and dispatched (workspace/people search, web search/fetch, document read, send_message, natural-language scheduling). A non-technical employee can plausibly type a request and get multi-step work done without touching Bash.

- `api/src/services/personal-assistant.ts:157`, `worker/src/run/agentic-loop.ts:173`, `worker/src/run/pa-tools.ts:507`

---

## Hard blockers before any corporate pilot

1. **"Voice-first" is not implemented in the deployable product.** No audio / OpenAI Realtime code in `api/src`; `voice_start` / `voice_stop` are unreachable stubs with no handler; there is no `stream_audio` tool. Real audio capture exists only in the legacy macOS app talking to `:4317`, architecturally severed from the tasks/approvals control plane on `:5554`/`:5555`. (`docs/functionality.md:371`, `api/src/realtime/hub.ts:1`)
2. **Plaintext secrets in a local `.env` (not committed).** A gitignored, untracked `.env` can hold local auth and provider-routing credentials loaded by the CLI. *Correction from the original draft: this is **not** "secrets committed to the repo" — `.env` is gitignored (`.gitignore:6`) and has never been in git history. Hosted model and Serper dispatch now use Nessie's product-bound Ledger key; `SERPER_API_KEY` is not consumed and there is no direct web-search fallback. The remaining risk is local-disk plaintext for local credentials + incomplete vault adoption, not a committed-secret leak.* (`cli/src/local.ts:124`)
3. **Audit log is a plain mutable table** with only `createdAt` — no hash chain, append-only constraint, or WORM — so it is not tamper-evident and fails typical SOC2 / ISO / financial immutable-log requirements. (`api/prisma/schema.prisma:1736`, `api/src/services/audit.ts:45`)
4. **No enterprise identity at scale.** OIDC login works, but there is no SAML, no SCIM/directory sync, no automated provisioning/deprovisioning, and SSO auto-provisions every user into the first org by `createdAt` — one tenant per deployment in practice. (`api/src/index.ts:1463`, `docs/deployment-modes-and-auth-spec.md:108`)
5. **No fleet/install story.** The macOS client is unauthenticated and points at the legacy `:4317` server; the "installer" is a v0.0.0 private CLI running the monorepo from source via `pnpm`+`tsx`. No code signing, notarization, or MDM path. (`macos/Nessie/NessieClient.swift:189`, `cli/src/local.ts:700`)
6. **Unsupervised embedded worker.** In local mode the worker's `stop()` handle is discarded and never wired to the API's shutdown, and the worker installs its own `process.exit` SIGTERM/SIGINT handlers that race Fastify shutdown. Worker crashes degrade automation while `/api/health` still returns 200. (`api/src/index.ts:5574`, `worker/src/index.ts`)

---

## Recommendation

Not usable today as an org-wide automation / work-distribution platform. A controlled single-team pilot of the text-chat assistant + scheduled automations is plausible only after:

1. Retiring the legacy `src/` server as the default runtime (close the unauthenticated RCE surface and mDNS broadcast).
2. Shipping the real KMS-backed secret store and removing committed secrets.
3. ~~Adding human task assignment, ownership, and hand-off to the `Task`/`PlanStep` model.~~ **DONE** — commit `2b21b0b`.
4. Wiring metrics, alerting, and dead-letter surfacing into `api/`/`worker/`.
5. Making the audit log tamper-evident.

The scheduling and multi-tenancy foundations are strong enough that these are finishing-work items, not rewrites.

---

## Adversarial review corrections

Six adversarial reviewers re-checked every claim against source, and each disputed claim was independently re-judged. The findings held up on substance; the following overstatements were corrected above:

| # | Original claim | Ruling | Correction |
|---|----------------|--------|------------|
| 1 | "RCE broadcast to any host on a corporate network" | doc-overstated | Legacy server binds `127.0.0.1` by default; non-local bind forces an API key (`src/index.ts:30,175-177,678`). Real risk is a **local** unauthenticated RCE + mDNS name leak. |
| 2 | "Secrets committed to the repo" | doc-overstated (claim of "committed" is false) | `.env` is gitignored and never tracked. Real risk is plaintext secrets in a local file loaded by the CLI (`cli/src/local.ts:124`). |
| 3 | "OAuth in-memory store throws in production" | doc-wrong-citation | The stub returns a ref; the production throw is a startup guard in `api/src/routes/mcp.ts:46`. |
| 4 | "Dead-lettered automations accumulate silently" | doc-overstated | Failed trigger deliveries are visible in admin; the queue `dead` / mailbox `dead_letter` paths and paging are what's missing. |
| 5 | "Legacy server runs by default" | doc-overstated (framing) | True only for root `npm` scripts; the `nessie` CLI launches the modern `api/`+`worker/`+`admin` stack. |

Additional gaps the reviewers surfaced that the strengths section had glossed (worth tracking, not score-changing):

- OIDC SSO does **not** validate the `id_token` signature or nonce — it trusts the userinfo endpoint's email for identity (`api/src/services/external-auth.ts`).
- The agentic-loop **cost cap** only sums costs reported in USD; non-USD providers bypass it (token/iteration/wall-clock caps still bound the loop) (`worker/src/run/agentic-loop.ts:107`).
- On queue-enqueue failure the scheduler reschedules at `now+60s` rather than the next cron slot, so a persistently failing cron trigger fires every minute (`worker/src/control/trigger-scheduler.ts:165`).
- In CLI local mode the worker runs **twice** (embedded in the API *and* a spawned process); `FOR UPDATE SKIP LOCKED` keeps this correct but it is redundant.
