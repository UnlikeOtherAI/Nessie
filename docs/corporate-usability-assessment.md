# Corporate Usability Assessment

**Question:** Is Nessie usable to automate the tasks of an organisation — automating work, distributing work across people and agents, running organisational workflows?

**Method:** 10 review agents, each taking a distinct corporate-usability lens, every claim grounded in the actual `api/`, `worker/`, `admin/`, `packages/`, `src/`, and `docs/` source rather than the project's marketing framing.

**Status:** under adversarial review — claims below carry `file:line` evidence and should be treated as findings to be verified, not settled fact.

---

## Verdict

Mean readiness **4.0 / 10**. No lens rated Nessie enterprise-ready; none rated it unusable.

The consistent picture: a genuinely well-architected enterprise core is being built in `api/` + `worker/`, but the **default runnable product is still the legacy single-user `src/` server**, and most of the controls an organisation depends on are either stubs or explicitly labelled "target-state design."

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

The `Task` and `PlanStep` models carry `agentId` / `assignedAgentId` but **no human assignee/owner field anywhere** in `api/`, `worker/`, or `admin/`. There is no human work queue, no ownership, no hand-off, no reassignment. "Roles" are agent capability profiles (orchestrator / builder / reviewer / watcher / researcher / debugger), not job functions or people. Approvals can be resolved by any non-requester org member — there is no routing to a named approver or role.

- `api/prisma/schema.prisma:1601` — `Task` model: `agentId` required, no assignee/userId
- `src/orchestration/task-types.ts:32` — `Task` interface has only role + threadId, no person
- `src/orchestration/role-registry.ts:11` — roles are tool-capability policies
- `api/src/services/approvals.ts:120` — any non-requester org actor can resolve

This is the defining requirement for organisational work distribution and it is absent.

### 2. Two products, and the insecure one runs by default

Root `dev`/`start` launch the legacy `src/index.ts`, whose `/mcp` JSON-RPC surface exposes `invoke_tool → Bash`/screenshot with **no per-user identity, auth disabled entirely on localhost, a single shared static key**, and self-advertises `_nessie._tcp` over mDNS on the LAN — effectively broadcasting a remote-code-execution endpoint to any host on a corporate network. The strong multi-tenant `api/` server exists, but the advertised orchestration tools (tasks / spawn / reviews / approvals) still live only in the legacy server; the `api/` MCP routes only manage connectors.

- `package.json` scripts `dev`/`legacy:dev` → `bun run src/index.ts`
- `src/index.ts:139`, `src/mcp/server.ts:469` — unauthenticated tool dispatch
- `src/index.ts:214` — mDNS advertisement of the legacy server

### 3. No turnkey corporate integrations, and credentials don't flow

The MCP client/connector spine is well-built (official SDK, stdio/http/sse, backoff, a catalog with a draft→pending→approved publishing flow). But the only seeded connector is Context7, a no-auth docs server. There is **zero Jira / Confluence / Slack / email / calendar / ticketing** code. The credential plane is stubbed: resolved secrets are never injected into outbound connector transports, and OAuth tokens persist only in an in-memory store that throws in production. Any authenticated SaaS connector cannot work end-to-end today.

- `api/src/db/seed-connectors.ts:35` — only Context7 seeded
- `api/src/services/secret-resolver.ts:28` — `EnvSecretResolver` stub, KMS resolver is `TODO(phase3)`
- `api/src/services/mcp-instances.ts:231` — credentials not injected into transport
- `api/src/services/mcp-oauth.ts:286` — in-memory token store throws in production

### 4. You would be flying blind

No metrics, alerting, or tracing in the shipping stack — `run_validators` / `get_metrics` / `get_alerts` exist only in the legacy `src/mcp` server, not imported by `api/` or `worker/`. The health check is a static `{status:'ok'}`. Dead-lettered automations accumulate silently with nobody paged. The token ledger accounts for cost after the fact but has no budget/quota/cap enforcement, so org-scale LLM spend is unbounded and unmonitored.

- `api/src/index.ts:1287` — static health check
- `src/mcp/server.ts:913` — validators/metrics/alerts only in legacy
- `packages/runtime/src/queue.ts:127` — `dead` status written but never read or surfaced
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
2. **Secrets committed to the repo.** `.env` contains live-looking OpenAI / MiniMax / Kimi / Serper keys and `NESSIE_AUTH_SECRET` in plaintext, loaded by the CLI from `repoRoot/.env`. The production KMS-backed secret store is an unimplemented stub. (`.env:1`, `api/src/services/secret-resolver.ts:28`)
3. **Audit log is a plain mutable table** with only `createdAt` — no hash chain, append-only constraint, or WORM — so it is not tamper-evident and fails typical SOC2 / ISO / financial immutable-log requirements. (`api/prisma/schema.prisma:1736`, `api/src/services/audit.ts:45`)
4. **No enterprise identity at scale.** OIDC login works, but there is no SAML, no SCIM/directory sync, no automated provisioning/deprovisioning, and SSO auto-provisions every user into the first org by `createdAt` — one tenant per deployment in practice. (`api/src/index.ts:1463`, `docs/deployment-modes-and-auth-spec.md:108`)
5. **No fleet/install story.** The macOS client is unauthenticated and points at the legacy `:4317` server; the "installer" is a v0.0.0 private CLI running the monorepo from source via `pnpm`+`tsx`. No code signing, notarization, or MDM path. (`macos/Nessie/NessieClient.swift:189`, `cli/src/local.ts:700`)
6. **Unsupervised embedded worker.** In local mode the worker's `stop()` handle is discarded and never wired to the API's shutdown, and the worker installs its own `process.exit` SIGTERM/SIGINT handlers that race Fastify shutdown. Worker crashes degrade automation while `/api/health` still returns 200. (`api/src/index.ts:5574`, `worker/src/index.ts`)

---

## Recommendation

Not usable today as an org-wide automation / work-distribution platform. A controlled single-team pilot of the text-chat assistant + scheduled automations is plausible only after:

1. Retiring the legacy `src/` server as the default runtime (close the unauthenticated RCE surface and mDNS broadcast).
2. Shipping the real KMS-backed secret store and removing committed secrets.
3. Adding human task assignment, ownership, and hand-off to the `Task`/`PlanStep` model.
4. Wiring metrics, alerting, and dead-letter surfacing into `api/`/`worker/`.
5. Making the audit log tamper-evident.

The scheduling and multi-tenancy foundations are strong enough that these are finishing-work items, not rewrites.
