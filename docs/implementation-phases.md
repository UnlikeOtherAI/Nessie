# Implementation Phases

> Status: active delivery roadmap.

## 1) Planning rules

Every phase must end in something workable.

That means:

- a real UI people can use,
- a real backend people can talk to,
- no dead-end prototype layer that gets thrown away immediately,
- no phase that is only infrastructure with no usable outcome.

Core delivery principles:

- keep one provider-agnostic core,
- keep hosted SaaS and self-hosted modes on the same core contracts,
- ship safe hosted features before privileged execution features,
- make every phase testable locally first,
- keep React UI CSR-first from the start,
- enforce very strict linting, formatting, typechecking, and build gates for both `/admin` and `/api` from Phase 1.
- use reusable component primitives and domain facades in `/admin`; do not build a React Context provider per entity.
- create `packages/schemas` and `packages/config` in Phase 1 before feature code fans out.

## 1.1) Mandatory end-of-phase review gate

No implementation phase is complete until all of these are true:

- the phase's functional acceptance criteria are satisfied,
- lint, typecheck, and build gates for affected roots pass,
- end-to-end behavior for that phase works,
- review passes are run through:
  - Claude CLI
  - Codex
  - `max`
  - Gemini CLI
- findings from those reviewers are manually verified before they become blocking,
- the phase closes only when there are no verified blocking findings left.

Important rule:

- reviewer agreement alone is not enough,
- reviewer disagreement alone is not enough,
- only verified findings count as blockers.

## 2) Recommended phase order

## Phase 1: Core Collaboration MVP

### Goal

Ship the first version that feels like a real product:

- users can sign in,
- users can enter channels,
- users can create and talk to agents,
- agents can spawn sub-agents,
- the UI is usable,
- the API is real,
- the system runs locally.

### Scope

- React CSR Nessie product UI in `/admin`
- landing page in `/web`
- API service in `/api`
- worker service in `/worker`
- Postgres-backed persistence
- `packages/schemas` for shared API/event/context contracts
- `packages/config` for typed startup config and capability flags
- SSE streaming for chat and thread updates
- WebSocket for agent activity, subscriptions, and live status
- local launch path:
  - Docker mode
  - non-Docker mode with `nessie local doctor`
- JWT-based auth with:
  - local bootstrap path for first-user creation (see [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md) section 4.3a)
  - Fastify `preHandler` auth middleware producing `AuthorizedActionContext` (see section 4.3c)
  - hosted default path
  - self-hosted/local configurable providers
  - optional auto-redirect
  - one canonical `GET /api/auth/me` source for current user/session/context
- Postgres-backed job queue (`pgqueue`) for local mode, Pub/Sub for hosted (see [hosted-app-architecture.md](./hosted-app-architecture.md) section 4)
- minimal org model:
  - organization
  - default project
  - default team
  - users
  - channels
  - agents
  - threads
- Phase 1 rule:
  - `project` and `team` exist as real records from day one,
  - but the first UI may treat them as default bootstrap containers rather than exposing full project/team administration yet.
- Phase 1 auth/runtime rule:
  - one real authenticated owner account is enough,
  - Phase 1 may simulate the broader org structure through deterministic default organization/project/team records,
  - agents still receive one canonical user/actor context from the auth/session layer.
- hidden organizer routing
- named agents plus sub-agent spawning
- basic agent registry and channel binding
- safe MVP tools only:
  - web search / fetch
  - deterministic knowledge/document read for local project docs
  - no shell, no SSH, no remote worker yet
- Phase 1 frontend/data rule for tools:
  - tools use the same facade pattern as other entities,
  - tool state must not be managed through page-local ad hoc fetch logic,
  - `/admin` should include a minimal tools surface for safe-tool visibility and binding where needed.
- agent activity observability (mandatory, not optional):
  - always-visible agent activity panel showing all agents with live status
  - WebSocket-driven instant status updates (idle, thinking, executing, waiting_approval, error)
  - `waiting_approval` is display-only in Phase 1 — the amber dot renders but there is no approval resolution endpoint; approval actions are Phase 2
  - `offline` status exists in the type system but Phase 1 agents never emit it (it applies to remote workers in Phase 4)
  - agent drill-down with sub-agent tree, tool execution log, and last 5 messages
  - thought process stream (`AgentThoughtStream`) is a Phase 1 stub component with placeholder; wired to `agent.thought` event in Phase 2
  - last 5 messages per agent always visible in agent detail view
  - sub-agent drill-down at any depth
  - see [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md) section 9 for full spec
- basic admin UX:
  - create channel
  - invite/add user
  - create agent
  - bind agent to channel

### Out of scope

- remote workers
- SSH
- PTY/interactive process sessions
- full enterprise policy stack
- full secrets system
- full workflow builder

### What makes it workable

At the end of phase 1, a user should be able to:

- install Nessie locally,
- sign in,
- open the Nessie UI in `/admin`,
- create or join a channel,
- create an agent,
- chat with the agent,
- watch streaming replies,
- let the agent use safe tools,
- see sub-agent activity in the UI.

### Phase 1 exit gate

Phase 1 is not complete until all of these are true:

- `/admin` lint passes
- `/admin` typecheck passes
- `/admin` production build passes
- `/api` lint passes
- `/api` typecheck passes
- `/api` production build passes
- `/worker` lint passes
- `/worker` typecheck passes
- `/worker` production build passes
- local `nessie local up` works in at least one supported mode
- chat, streaming, agent creation, and sub-agent spawning work end to end
- agent activity panel shows live status for all agents via WebSocket
- agent drill-down shows sub-agent tree, tool log, and last 5 messages
- WebSocket reconnect replays current agent status correctly
- Claude CLI review pass has run
- Codex review pass has run
- `max` review pass has run
- Gemini CLI review pass has run
- there are no verified blocking findings left

### Parallel track

The UI/template refinement can run in parallel here:

- refine the existing HTML/template into production React components for `/admin`,
- keep `/web` intentionally minimal as the landing page,
- keep it non-blocking on backend progress,
- do not invent a second UI architecture.
- follow [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md).

## Phase 2: Multi-User Hosted Beta

### Goal

Turn the local-first MVP into a real hosted beta for teams.

### Scope

- GCP hosted deployment:
  - Cloud Run API
  - Cloud Run worker
  - Cloud SQL
  - Pub/Sub/Eventarc
  - GCS
- hosted auth default
- project and team model
- channel privacy levels
- membership-aware discovery
- basic effective policy checks for:
  - channel access
  - agent binding
  - tool visibility
- token ledger v1:
  - usage ingestion
  - summaries
  - monthly estimates
- model-provider inference control plane:
  - provider connectors and credential bindings
  - manual/discovered model catalog and capability overrides
  - routing profiles and tool mediators
  - routing/profile eval suites and eval runs
- approval gating v1 for sensitive actions
- audit trail for control-plane actions

### What makes it workable

At the end of phase 2, an organization should be able to:

- run Nessie as a hosted service,
- onboard users,
- separate work by project/team/channel,
- create shared agents,
- control which agents appear in which channels,
- see token usage and cost estimates,
- configure approved inference providers, models, routing profiles, and evals,
- gate sensitive actions with approval.

### Phase 2 entry gate — memory system review

Before beginning Phase 2 implementation, the memory system (`packages/memory`) must be reviewed:

1. Identify any Phase 2 features that would benefit from memory system integration (e.g., audit events for thought creation, policy scoping for thought visibility).
2. Identify any conflicts between memory system models and new Phase 2 models (e.g., `ThoughtAuditLog` vs `AuditLog`).
3. Document integration points or confirm the two systems remain fully independent.
4. Do not modify `packages/memory` without completing this review.

### Phase 2 exit gate

Phase 2 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots and hosted deployment paths.

Additionally, all 15 Phase 1 → Phase 2 prerequisites must be verified as resolved:

- All critical prerequisites (#1–#4) must be fixed and tested under multi-instance conditions.
- All high prerequisites (#5–#12) must be fixed.
- All medium prerequisites (#13–#15) must be fixed or have documented deferral justification.

### Phase 2 starting state (carried from Phase 1)

Phase 1 shipped several extras beyond its spec. These are established, canonical features. Phase 2 must account for them.

#### Keep as-is — review before modifying

- **Memory system** (`packages/memory`): custom episodic memory with `Thought`, `ThoughtReasoning`, `ThoughtLink`, `ThoughtAuditLog`, `ThoughtRecall` models and pgvector semantic search. Not in any phase spec — this is a standalone capability layer. **Must be reviewed for Phase 2 compatibility before any Phase 2 work touches memory-adjacent code.** The memory system's `ThoughtAuditLog` is distinct from the Phase 2 control-plane `AuditLog` — these are separate systems and must remain so.

#### Already in schema — needs enforcement in Phase 2

- **`ChannelVisibility` enum** (`public`, `protected`, `private`) and `Channel.visibility` field — schema matches Phase 2 Step 2 requirements. Enforcement logic not yet implemented.
- **`AgentCategory` and `AgentCategoryAgent` models** — not in the phase spec but established and in use (column browser). Has `organizationId`. Phase 2 policy engine must include category visibility in policy scoping.
- **`User.pronouns` field** — Phase 3 scope, added early. No action needed in Phase 2.

#### Partially built — needs completion in Phase 2

- **`ModelUsageTracker` and `ModelClient`** (`packages/runtime`): tracks token usage per model call in memory. Phase 2 Step 6 must add the flush-to-DB step via `TokenLedgerEvent` Prisma model and worker ingestion at run completion.
- **`QueueJob.idempotencyKey` field** exists in schema. Phase 2 must add the "already completed" guard in worker to use it (prerequisite #8).
- **`Agent.provider` and `Agent.model` fields**: per-agent model selection works. Phase 3 prompt inheritance must account for these.

### Phase 2 code-level prerequisites (Phase 1 → Phase 2 migration)

These are Phase 1 code assumptions that **must be fixed** before or during Phase 2 feature work. Identified by Codex deep review (2026-04-08). Status updated 2026-04-09.

#### Critical — security / correctness

1. **WebSocket subscriptions bypass channel privacy.** Events were once published at org scope and delivered on org match alone. **Status: FIXED (re-verified 2026-07-23).** All three realtime delivery paths now enforce channel privacy both at subscribe time and at delivery: (a) WS (`api/src/routes/activity.ts:81`) filters requested scopes through `filterAuthorizedScopes` (`api/src/lib/request-helpers.ts:446`) before registration, and delivery re-checks every channel scope via `shouldDeliverWsNotification` + `canAccessChannelEvent` (`api/src/realtime/hub.ts:63,173`); (b) user SSE (`api/src/routes/events.ts:31`) derives scopes from the caller's own memberships via `resolveUserChannelRealtimeScopes` (`api/src/services/realtime-events.ts:73`), delivery re-checks with `getVisibleChannel`, and the `Last-Event-ID` replay (`realtimeEventStore.listAfter`) is scoped to the connection's authorized `channelIds` + org; (c) thread SSE (`api/src/routes/threads.ts:289`) authorizes at subscribe with `findThreadForUser` (public-or-member, org-scoped; `api/src/services/messages.ts:121`) and its `listThreadEvents` replay is bound to that one authorized thread. Regression coverage: `api/test/security-scoping.test.ts` (delivery filter) + `api/test/realtime-subscription-authz.test.ts` (subscribe-time authz).
2. **Shared-agent REST endpoints leak cross-channel history.** Agent status/activity/messages loaders return global history without channel scoping (`api/src/services/agents.ts`). Phase 2 must scope agent data queries to the caller's accessible channels. **Status: NOT FIXED.**
3. **Agent binding has no authorization check.** **Status: FIXED (re-verified 2026-07-23).** `POST/DELETE /api/agents/:agentId/bindings` (`api/src/routes/agents.ts:222,281`) now require channel membership (`getChannelIfMember`), the `owner` role (`requireOwner`), and an `agent`/`bind` policy verdict (`checkPolicy`) before mutating. The service (`bindAgentToChannel`, `api/src/services/agent-bindings.ts:15`) looks up BOTH the agent and the channel scoped to the caller's `organizationId`, so a cross-tenant agent or channel yields `null` and no binding is written. System-managed agents and the Personal Assistant DM are refused. Regression coverage: `api/test/realtime-subscription-authz.test.ts` (cross-org agent bind rejected).
4. **`NESSIE_AUTH_SECRET` fallback to per-process random breaks multi-instance.** API falls back to in-memory random (`api/src/index.ts:150`). On Cloud Run with multiple instances, tokens from one instance fail on another. Phase 2 must require a persistent shared secret or use Cloud KMS. **Status: NOT FIXED.**

#### High — architectural prerequisites

5. **Auth/session contract cannot represent multi-membership users.** `TenantContext` holds one org/project/team. `users.ts` hard-selects first membership. Phase 2 must evolve JWT and `/me` to support project/team switching (see JWT evolution in deployment-modes-and-auth-spec/overview.md). **Status: NOT FIXED.**
6. **Login and SSO auto-provision hardcode bootstrap org/project/team IDs.** All auth paths issue reserved bootstrap container IDs. Phase 2 must resolve user's actual memberships from DB. **Status: NOT FIXED.**
7. **Worker ignores `actorContext`.** Jobs carry context (`packages/schemas`) but `executeRunJob` only unpacks `sessionId`/`userId` (`worker/src/run/execute.ts:532–571`) — never uses it for policy, approval, audit, or ledger. Phase 2 must propagate and enforce. **Status: PARTIAL — carried but unused.**
8. **Run execution is not idempotent.** `QueueJob.idempotencyKey` field exists in Prisma schema but no "already completed" guard in worker. At-least-once queue retries can duplicate output. Phase 2 must add idempotency boundaries per control-plane invariant #2. **Status: PARTIAL — schema field exists, enforcement missing.**
9. **Agent model lacks ownership fields.** `Agent` has no org/project/team owner. `AgentBinding` is unscoped. Phase 2 Prisma migration must add ownership and enforce it. **Status: NOT FIXED.**
10. **No tenant hierarchy consistency constraints in DB.** `Channel` references org and team independently — no FK constraint that the team's project belongs to the same org. Phase 2 should add application-level invariant checks (or DB triggers). **Status: NOT FIXED.**
11. **Public channels require membership to be visible.** Channel listing filters by `channel_members` rows, hiding public channels from non-members. Phase 2 must implement privacy-level-aware listing (uses existing `ChannelVisibility` enum). **Status: NOT FIXED — enum exists, enforcement missing.**
12. **Queue provider not config-switchable.** Worker always boots `PgQueueProvider`. Phase 2 must wire `config.queue.provider` to provider factory. **Status: NOT FIXED.**

#### Medium — operational

13. **Channel listing N+1.** `listChannelsForUser` calls `ensureDefaultThread` per channel with find-then-create race. Phase 2 should use `upsert` and batch. **Status: NOT FIXED.**
14. **Activity queries don't scale.** Snapshot building does per-agent queries; activity loads full history before trimming. Phase 2 should add pagination and indexed queries. **Status: NOT FIXED.**
15. **Admin WS client missing ping.** No keepalive ping per spec (30s interval). SSE client missing `Last-Event-ID` reconnect. Phase 2 must fix both to survive Cloud Run connection cycling. **Status: NOT FIXED.**

### Recommended build sequence inside Phase 2

#### Step 0: GCP infrastructure and deployment pipeline

This must be built first. No hosted feature work can proceed without a deployable environment.

- Terraform modules for Cloud Run, Cloud SQL, Pub/Sub, GCS, KMS, Redis, networking, IAM
- CI/CD pipeline: build → Docker → Artifact Registry → Cloud Run deploy
- `PubSubQueueProvider` implementing `QueueProvider` from [hosted-app-architecture.md](./hosted-app-architecture.md) section 4
- `GcsStorageProvider` implementing `StorageProvider`
- Cloud SQL connector integration (`@google-cloud/cloud-sql-connector`)
- Memorystore Redis connection via VPC connector
- Health check endpoint verification on Cloud Run
- See [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)

#### Step 1: Multi-project/team data model and auth evolution

Schema partially done: `Project`, `Team`, `ProjectMember`, `TeamMember` models exist from Phase 1. Remaining work:

- ~~Prisma schema additions: project CRUD, team CRUD, membership tables~~ (done in Phase 1)
- Add ownership fields to `Agent` model: `organizationId`, `projectId`, `teamId` (prerequisite #9)
- JWT evolution: multi-project support (project/team selection, not hardcoded single project)
- `GET /api/auth/me` returns available projects/teams for the user
- User invitation flow: `POST /api/orgs/{orgId}/users`
- Project creation and membership: `POST /api/projects`, `POST /api/projects/{projectId}/members`
- Team creation and membership: `POST /api/teams`, `POST /api/teams/{teamId}/members`
- Identity Platform integration for hosted auth default
- Fix `NESSIE_AUTH_SECRET` random fallback (prerequisite #4): require persistent shared secret or Cloud KMS
- Fix bootstrap org/project/team ID hardcoding in login/SSO paths (prerequisite #6)
- See [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md)

#### Step 2: Channel privacy and membership-aware discovery

`ChannelVisibility` enum and `Channel.visibility` field already exist in schema. Remaining work is enforcement:

- ~~Channel privacy levels: public, protected, private~~ (enum exists)
- Channel membership enforcement at query and routing time
- Privacy-aware channel listing: `GET /api/teams/{teamId}/channels` (prerequisite #11 — public channels must be visible without membership)
- WebSocket event filtering by channel membership/privacy (prerequisite #1)
- Scope agent REST endpoints to caller's accessible channels (prerequisite #2)
- Membership-aware agent discovery: agents filtered by channel access
- Membership-aware tool discovery: tools filtered by policy scope
- Private channels excluded from search for non-members
- `AgentCategory` visibility scoping through policy engine
- See [organization-governance-spec.md](./organization-governance-spec.md) section 2.2 and 4.1

#### Step 3: Policy enforcement engine

- Prisma models: `PolicyRule`, `PolicyBinding`
- `PolicyEnforcer` service with chain evaluation algorithm
- Policy check integration at: channel access, agent binding (prerequisite #3), tool visibility, admin actions
- Enforce tenant hierarchy consistency (prerequisite #10) — application-level invariant checks
- `GET /api/policy/effective` endpoint
- `POST /api/policy/check` inline access check endpoint
- Default seed policies for new organizations
- Redis-backed effective policy cache with invalidation
- See [policy-enforcement-spec.md](./policy-enforcement-spec.md)

#### Step 4: Approval gating v1

Note: `AgentStatus.waiting_approval` already exists in the Prisma enum (Phase 1 — display-only). What must be added here is `RunStatus.waiting_approval` so runs themselves can be paused. Both coexist: the agent shows the status in the UI, the run holds the state for worker pause/resume.

- Prisma model: `ApprovalRequest`
- Add `waiting_approval` to `RunStatus` Prisma enum and `packages/schemas` (distinct from the existing `AgentStatus.waiting_approval`)
- `approval.resolved` in WsEventMap and `packages/schemas`
- Worker pause/resume flow with continuation tokens
- Wire `actorContext` into approval checks (prerequisite #7)
- API endpoints: create, list, get, resolve approvals
- Expiry sweep periodic job
- Approver resolution based on policy chain
- Frontend: pending approvals badge, approval detail view, approve/reject actions
- See [approval-gating-spec.md](./approval-gating-spec.md)

#### Step 5: Audit trail

Note: `ThoughtAuditLog` already exists for the memory system — that is a separate audit surface for thought lifecycle events. This step adds control-plane audit for org/project/channel/agent/policy actions. The two systems must remain distinct.

- Prisma model: `AuditLog` (control-plane, not to be confused with `ThoughtAuditLog`)
- `AuditEmitter` interface with Postgres-backed implementation
- Audit events emitted at all Phase 2 control-plane actions
- API endpoints: list, get, export audit logs
- Redaction layer for sensitive fields
- See [audit-trail-spec.md](./audit-trail-spec.md)

#### Step 6: Token ledger v1

`ModelUsageTracker` and `ModelClient` in `packages/runtime` already track token usage per model call in memory. What's missing is DB persistence and API surface.

- Prisma models: `TokenLedgerEvent`, `ModelPricingProfile`
- Flush-to-DB step: worker writes `ModelUsageTracker.getUsage()` to `TokenLedgerEvent` rows at run completion
- Summary and rollup endpoints by org/project/team/channel/agent/user/model
- Monthly estimate endpoint
- Pricing profile CRUD with audit trail
- Admin UI: usage dashboard, pricing management
- See [token-ledger-spec.md](./token-ledger-spec.md)

#### Step 7: Inference control plane and evals

- `ProviderConnector` registry and capability catalog from [model-provider-connector-spec.md](./model-provider-connector-spec.md)
- `InferenceProvider`, `InferenceCredentialBinding`, `InferenceModel`, `InferenceCapabilityOverride` admin APIs
- `RoutingProfile` and `ToolMediatorProfile` admin APIs with approval lifecycle
- `InferenceEvalSuite` and `InferenceEvalRun` APIs with stored result snapshots
- Worker/runtime integration on `InferenceService.run()` and `MultiProviderResult`
- Admin-only execution policy for connectors, models, routing profiles, tool mediators, eval suites, and eval runs

#### Step 8: Admin UI extensions for Phase 2

The agent column browser, agent designer studio, and agent categories UI are already built from Phase 1 extras. Remaining Phase 2 admin work:

- Project and team administration pages
- Channel privacy settings UI
- User invitation and membership management
- Approval queue and resolution UI
- Token usage dashboard
- Inference provider/model/routing/eval administration
- Policy rule management (admin-only)
- Audit log viewer
- Admin WS client keepalive ping (prerequisite #15) — 30s interval per spec
- SSE client `Last-Event-ID` reconnect (prerequisite #15)

#### Step 9: Hosted deployment validation

- End-to-end flow on Cloud Run: signup → create project → create channel → chat → approval → audit
- Load test: verify Cloud Run autoscaling under concurrent users
- Pub/Sub delivery verification with dead-letter handling
- Cloud SQL connection pooling under load
- WebSocket reconnect across Cloud Run instance restarts (requires prerequisite #15)
- Cost validation against estimates
- Verify `NESSIE_AUTH_SECRET` is shared across all Cloud Run instances (prerequisite #4)
- Verify queue provider config-switches to Pub/Sub in hosted mode (prerequisite #12)
- Verify idempotency guard prevents duplicate run output on queue retry (prerequisite #8)

### Phase 2 spec references

- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md) — GCP deployment topology and infrastructure
- [policy-enforcement-spec.md](./policy-enforcement-spec.md) — runtime policy enforcement engine
- [approval-gating-spec.md](./approval-gating-spec.md) — approval gating system
- [audit-trail-spec.md](./audit-trail-spec.md) — audit trail system
- [token-ledger-spec.md](./token-ledger-spec.md) — token usage tracking and cost estimation
- [model-provider-connector-spec.md](./model-provider-connector-spec.md) — inference connectors, routing, mediation, and evals
- [organization-governance-spec.md](./organization-governance-spec.md) — multi-tenant governance model
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) — shared type contracts (Phase 2 additions)
- [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md) — auth modes and deployment modes

## Phase 3: Tooling and Knowledge Platform MVP

### Goal

Ship the shared platform primitives that the agent system depends on.

### Scope

- tool registry
- tool manifests/import
- tag/search/discovery endpoints
- checkbox/inherit/allow/deny tool grants
- prompt inheritance model for tools and agents
- deterministic knowledge-base ingestion
- document summaries
- scoped search and read flows
- translation and per-user language delivery
- pronoun-aware translation context
- step-up verification:
  - email code
  - email link
  - TOTP enrollment/challenge
- secrets system v1:
  - scoped secret storage
  - secret grants
  - runtime resolve path

Agent-specific implementation from Phase 3 onward is owned by [plans/2026-04-09-agent-implementation-plan.md](./plans/2026-04-09-agent-implementation-plan.md), including:

- agentic loop enhancements
- triggers and scheduler behavior
- plans and inter-agent coordination
- workflow templates and installations
- marketplace agent capabilities
- generated plugins
- execution environments, runners, and remote workers
- agent builder UX and APIs

### What makes it workable

At the end of phase 3, teams should be able to:

- install and bind tools,
- search available tools without polluting agent context,
- ingest documentation,
- search docs safely,
- store scoped secrets,
- require step-up verification for sensitive secret use,
- collaborate across languages,
- provide the shared control-plane primitives consumed by the agent plan.

### Phase 3 code-level prerequisites (Phase 2 -> Phase 3 migration)

These are Phase 2 code assumptions that **must be fixed** before or during Phase 3 feature work.

#### Critical -- tool system

1. **Hardcoded tool list.** `api/src/services/tools.ts` defines a static `SAFE_TOOLS` array with 3 tools. `worker/src/run/execute.ts` dispatches via if-statements in `executeSafeTool()`. Phase 3 must replace with dynamic tool registry lookup.
2. **Tool endpoint returns unscoped list.** `GET /api/tools` (`api/src/index.ts:680`) returns all tools without filtering by agent grants, user role, or organization scope. Phase 3 must enforce grant-based visibility.
3. **Agent `toolPolicy` field defined but unused.** `api/prisma/schema.prisma` has `toolPolicy Json?` on Agent but nothing reads or enforces it. Phase 3 must define the schema, populate it, and enforce at execution time.
4. **No tool execution enforcement.** Worker tool dispatch (`worker/src/run/execute.ts:297-360`) does not check agent grants before invoking a tool. Phase 3 must add policy check before every tool call.

#### Critical -- secrets

5. **Model API keys read from raw env vars.** `packages/config/src/index.ts` reads `NESSIE_MODEL_API_KEY`, `OPENAI_API_KEY`, and provider-specific fallbacks directly from environment. Phase 3 must integrate secret vault with encrypted storage, `secretRef` resolution, and audit.
6. **OAuth client secrets unencrypted in config.** `api/src/services/external-auth.ts` stores provider credentials in plain config. Phase 3 must use `SecretRecord` for provider secrets.

#### High -- verification and auth

7. **No 2FA/verification fields in User model.** `api/prisma/schema.prisma` has no TOTP seed, verification factor, or challenge tables. Phase 3 Prisma migration must add `VerificationEnrollment`, `VerificationChallenge`, and `VerificationPolicy` models.
8. **Login endpoint has no step-up flow.** `POST /api/auth/session` (`api/src/index.ts:457-575`) does credential check only. Phase 3 must add challenge/verify flow for sensitive actions.
9. **`VerificationFactorType` schema defined but unused.** `packages/schemas/src/index.ts` defines the enum and `AuthorizedActionContext.verification` field but no auth flow uses them. Phase 3 must wire these into the approval and secret resolve paths.

#### High -- knowledge base

10. **Document read tool uses hardcoded filesystem path.** `worker/src/run/tools.ts:70-99` reads from a fixed `docsRoot` with `collectMarkdownFiles`. No access control, no metadata, no scoping. Phase 3 must replace with knowledge-base table lookup and policy-checked reads.
11. **No knowledge-base data model.** No `KnowledgeSource`, `KnowledgeDocument`, or access grant tables exist. Phase 3 Prisma migration must add them.

#### High -- prompt and agent system

12. **Agent stores only direct `systemPrompt`.** `api/src/services/agents.ts:86` and `worker/src/run/execute.ts:466-481` build model prompt from agent's own systemPrompt with no inheritance chain. Phase 3 must resolve prompts through the org -> role -> agent -> tool layer chain.
13. **Agent creation accepts no tool/grant parameters.** `createAgentRecord` (`api/src/services/agents.ts:449-491`) takes only name/role/systemPrompt. Phase 3 must accept tool grants, prompt inheritance config, and policy settings.

#### Medium -- translation and config

14. **No language or translation support.** No i18n framework, no `User.preferredLanguage` field, no message translation pipeline. Phase 3 must add language preference fields and translation service integration.
15. **No per-tenant feature flags.** `packages/config/src/index.ts` uses global env-based config only. Phase 3 should add `RuntimeCapabilities` flags for tool registry, knowledge base, secrets vault, step-up verification, and translation features.

### Recommended build sequence inside Phase 3

#### Step 0: Prisma schema and shared contracts for Phase 3

This must be built first. All Phase 3 features depend on new data models and shared types.

- Prisma models: `ToolRegistryEntry`, `ToolGrant`, `ToolBundle`, `PromptLayer`, `Secret` (maps to `SecretStorageRecord` internally, `SecretRecord` in API), `SecretBinding`, `VerificationEnrollment`, `VerificationChallenge`, `VerificationPolicy`, `KnowledgeSource`, `KnowledgeDocument`, `KnowledgeShareGrant`
- Add `User.preferredLanguage`, `User.pronouns`, `Organization.defaultLanguage` fields
- Add `Thread.languageOverride` field for thread-level language overrides
- Phase 3 types in `packages/schemas` (see [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) Phase 3 additions)
- Phase 3 config additions in `packages/config` (see [config-module-spec.md](./config-module-spec.md))
- Run Prisma migration

#### Step 1: Tool registry and search

- `ToolRegistryEntry` CRUD service
- Tool search with full-text, tags, filters, cursor pagination
- Seed built-in tools into registry from current hardcoded list
- `GET /api/tools` rewritten to query registry with scoping
- `POST /api/tools`, `PATCH /api/tools/{toolId}`, `DELETE /api/tools/{toolId}`
- `POST /api/tools/search`
- See [tool-registry-spec.md](./tool-registry-spec.md)

#### Step 2: Tool grants and execution enforcement

- `ToolGrant` CRUD service with role-based and agent-override grants
- Effective grant resolution (role merge + agent override)
- `GET /api/roles/{roleId}/tools`, `GET /api/agents/{agentId}/tools`
- `PATCH /api/agents/{agentId}/tools/{toolId}`
- Execution enforcement: worker checks grants before every tool call
- Replace hardcoded `executeSafeTool` dispatch with registry-backed dispatch
- See [tool-registry-spec.md](./tool-registry-spec.md)

#### Step 3: Tool manifest import

- `NessieToolBundle` manifest parser (JSON/YAML/MD)
- Schema and signature validation
- `POST /api/tools/bundles/import`, bundle approval flow
- `GET /api/tools/bundles`, `POST /api/tools/bundles/{bundleId}/approve`
- See [tool-registry-spec.md](./tool-registry-spec.md)

#### Step 4: Prompt inheritance

- `PromptLayer` CRUD service
- Prompt resolution chain: global -> role -> agent -> task -> tool-call
- `GET /api/prompts`, `POST /api/prompts`, `PATCH /api/prompts/{promptId}`
- `GET /api/agents/{agentId}/prompts/effective`
- Worker prompt builder rewritten to resolve inheritance chain
- See [tool-registry-spec.md](./tool-registry-spec.md)

#### Step 5: Secret management v1

- `SecretRecord` service with envelope encryption (AES-256-GCM)
- `SecretBinding` access control with deny-first evaluation
- `POST /api/secrets`, `GET /api/secrets`, `POST /api/secrets/{secretRef}/resolve`
- Secret grant endpoints, audit endpoint
- Migrate model API keys from env vars to secret vault
- See [secret-management-spec.md](./secret-management-spec.md)

#### Step 6: Step-up verification

- `VerificationEnrollment`, `VerificationChallenge`, `VerificationPolicy` services
- Email OTP factor: send code, verify code
- Email link factor: send link, confirmation page, verify
- TOTP factor: enrollment with QR, verify code
- Recovery code factor
- Challenge endpoints: `POST /api/verification/challenges`, `POST /api/verification/challenges/{challengeId}/verify`
- Factor endpoints: `POST /api/verification/factors`, `GET /api/verification/factors`
- Policy CRUD: `GET /api/verification/policies`, `POST /api/verification/policies`, `PATCH /api/verification/policies/{policyId}`
- Wire into secret resolve and approval paths
- See [step-up-verification-spec.md](./step-up-verification-spec.md)

#### Step 7: Knowledge base

- `KnowledgeSource` and `KnowledgeDocument` services
- Source ingestion: local file, folder, URL, MCP
- Document summary computation
- Scoped search with deterministic pagination
- `POST /api/knowledge-base/link`, `POST /api/knowledge-base/search`, `POST /api/knowledge-base/read`
- Replace hardcoded document read tool with knowledge-base-backed tool
- See [knowledge-base-requirements.md](./knowledge-base-requirements.md)

#### Step 8: Translation and language

- `LanguagePreferences` service
- Organization default language, user preferred language
- Thread/session language override
- Translation service integration (provider-agnostic)
- `GET /api/orgs/{orgId}/language`, `PATCH /api/orgs/{orgId}/language`
- `GET /api/users/{userId}/language`, `PATCH /api/users/{userId}/language`
- `GET /api/users/{userId}/profile`, `PATCH /api/users/{userId}/profile`
- `PATCH /api/threads/{threadId}/language`, `PATCH /api/sessions/{sessionId}/language`
- `POST /api/translation/preview`
- Pronoun-aware translation context
- See [language-and-translation-spec.md](./language-and-translation-spec.md)

#### Step 9: Admin UI extensions for Phase 3

- Tool registry browser with search and filters
- Tool checkbox matrix (allow/deny/inherit per agent)
- Bundle import review UI
- Prompt layer editor with inheritance preview
- Secret creation modal (out-of-band from chat)
- Verification factor enrollment (QR code for TOTP)
- Knowledge base source management
- Language preference settings
- Usage of all new domain facades

#### Step 10: Phase 3 validation

- End-to-end: import tool bundle -> approve -> grant to agent -> agent uses tool -> audit logged
- End-to-end: create secret -> bind to agent -> step-up verification -> resolve -> tool uses secret
- End-to-end: ingest docs -> search -> read -> agent uses knowledge base
- End-to-end: set language preference -> message translated -> canonical stored in org language
- Prompt inheritance resolves correctly across all layers
- Tool enforcement blocks denied tools
- Secret vault encrypts at rest and redacts in logs
- All Phase 3 audit events emitted correctly

### Phase 3 spec references

- [tool-registry-spec.md](./tool-registry-spec.md) -- tool registry, grants, manifests, prompt inheritance
- [secret-management-spec.md](./secret-management-spec.md) -- secret vault, encryption, access bindings
- [step-up-verification-spec.md](./step-up-verification-spec.md) -- email/TOTP verification factors
- [language-and-translation-spec.md](./language-and-translation-spec.md) -- multilingual delivery model
- [knowledge-base-requirements.md](./knowledge-base-requirements.md) -- document ingestion and scoped search
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) -- shared type contracts (Phase 3 additions)
- [config-module-spec.md](./config-module-spec.md) -- Phase 3 config additions
- [policy-enforcement-spec.md](./policy-enforcement-spec.md) -- Phase 3 integration points (secret, KB, verification, tool registry)
- [audit-trail-spec.md](./audit-trail-spec.md) -- Phase 3 audit action families

### Phase 3 exit gate

Phase 3 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots and capability surfaces.

## Phase 4: Interactive and Remote Execution

### Goal

Add privileged and interactive execution in a controlled way.

### Scope

- hosted runner boundary
- `session:*` interactive process family
- CLI wrapper tools
- single-entry SSH tool with run/session modes
- remote worker protocol
- remote worker registration and policy sync
- worker-scoped API keys
- local-hard-policy intersection
- sandbox controls:
  - allowed roots
  - denied roots
  - read-only mode
  - command allow/deny
  - no-interactive mode

Detailed sequencing for agent-facing runners, execution environments, workflow-launched coding environments, generated-plugin runtime, and remote-worker UX is owned by [plans/2026-04-09-agent-implementation-plan.md](./plans/2026-04-09-agent-implementation-plan.md). This phase keeps only the platform/runtime milestone.

### What makes it workable

At the end of phase 4, a team should be able to:

- run controlled interactive tools,
- open and manage safe long-lived sessions,
- use SSH under policy,
- connect customer-owned machines as remote workers,
- limit remote execution by both local machine policy and cloud policy.

### Phase 4 exit gate

Phase 4 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots, privileged execution surfaces, and remote-worker flows.

## Phase 5: Enterprise Hardening and Release Operations

### Goal

Make the system safe for serious company use.

### Scope

- project safety modes:
  - preflight
  - degrade
  - restore
  - archive
- release/deployment workflows
- stronger audit/export flows
- retention and residency policy hooks
- policy previews and effective-policy explainability
- budget alerts and cost governance
- better runner isolation and scale tuning
- self-hosted operational docs and upgrade paths

Agent-specific release workflows, black-box invocation behavior, marketplace execution controls, and higher-risk operational workflow sequencing are owned by [plans/2026-04-09-agent-implementation-plan.md](./plans/2026-04-09-agent-implementation-plan.md). This phase keeps only the enterprise platform hardening milestone.

### What makes it workable

At the end of phase 5, an organization should be able to:

- use Nessie for higher-risk operational workflows,
- contain mistakes by project boundary,
- audit privileged actions properly,
- manage spend and access more safely,
- run both hosted and self-hosted installations with confidence.

### Phase 5 exit gate

Phase 5 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots, hosted/self-hosted deployment paths, and enterprise control surfaces.

## 2.1) Individual Communications Connector phases

A cross-cutting workstream (independent of the Phase 1–5 platform milestones)
that lets each user connect their own Slack / Google / Microsoft account so
their external communications flow into the shared `CommsEvent` model as a
Chief-of-Staff observation source. The connector layer is strictly
auth/retrieval/sync/normalization — no business intelligence. Foundation
(Prisma models, the `@nessie/comms-connect` provider-agnostic core, and the
worker sync/renewal pipeline) lands first; provider adapters, OAuth routes, and
UI build on it. See
[plans/2026-07-21-individual-communications-connector.md](./plans/2026-07-21-individual-communications-connector.md).

- **Phase 1 — Gmail + Slack (personal):** per-user OAuth connect, history
  back-fill, incremental sync, and webhook/watch ingestion for a single user's
  Gmail and Slack.
- **Phase 2 — Microsoft Graph (partial):** Outlook mail/folders are live through
  delegated OAuth, Graph delta cursors, and bounded five-minute reconciliation.
  Teams chats/channels and Graph change-notification subscriptions remain to be
  built.
- **Phase 3 — enterprise admin:** org-admin-scoped installs, tenant-wide
  consent, and per-team governance over which resources sync.
- **Phase 4 — additional systems:** further communication and collaboration
  sources normalized into the same event model.

## 3) MVP definition

For this roadmap, the MVP is Phase 1 plus the minimum hosted packaging needed to demo it credibly.

That means the true MVP should include:

- usable React web UI
- usable React admin UI
- simple landing page
- real API
- real worker
- users
- channels
- agents
- sub-agents
- streaming chat
- local install
- safe basic tools
- basic admin controls

It should not wait for:

- SSH
- remote workers
- full secrets platform
- full enterprise governance
- workflow builder

## 4) Recommended build sequence inside Phase 1

### Step 0: Monorepo and shared foundations

This must be built first. Nothing else can import types or config until this exists.

- `pnpm-workspace.yaml` with package globs for `api/`, `admin/`, `web/`, `worker/`, `cli/`, `packages/*`
- `turbo.json` with build/lint/typecheck pipeline
- root `tsconfig.json` with project references
- root ESLint config (flat config, strict, shared across all packages)
- `packages/schemas`:
  - all types from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) section 10
  - Zod schemas for each type
  - export branded ID helpers
- `packages/config`:
  - typed config schema with Zod validation
  - env-to-config mapping
  - `RuntimeCapabilities` flags
  - see [config-module-spec.md](./config-module-spec.md)

### Step 1: Prisma schema and database

- `api/prisma/schema.prisma` — see [phase1-prisma-schema.md](./phase1-prisma-schema.md)
- raw SQL migration for `queue_jobs` table
- bootstrap seed logic (deterministic default org/project/team/channel)
- `npx prisma migrate dev` working locally

### Step 2: API service

- `/api` on Fastify
- Fastify auth middleware with JWT validation (see [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md) section 4.3c)
- bootstrap endpoint: `POST /api/auth/bootstrap`
- auth endpoints: `GET /api/auth/providers`, `POST /api/auth/session`, `DELETE /api/auth/session`, `GET /api/auth/me`
- CRUD endpoints:
  - `GET /api/channels`, `POST /api/channels`
  - `GET /api/agents`, `POST /api/agents`
  - `POST /api/agents/{agentId}/bindings`
  - `GET /api/tools`
  - `GET /api/threads/{threadId}/messages`, `POST /api/threads/{threadId}/messages`
- SSE streaming: `GET /api/threads/{threadId}/stream`
- agent activity endpoints:
  - `GET /api/agents/{agentId}/status`
  - `GET /api/agents/{agentId}/activity`
  - `GET /api/agents/{agentId}/messages?limit=5`
  - `GET /api/agents/{agentId}/children`
  - `GET /api/agents/{agentId}/runs/{runId}/tools`
- WebSocket: `WS /api/activity` with subscription protocol (see [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) section 5)
- pgqueue adapter for local mode
- job submission to worker via queue

### Step 3: Worker and run model

- `/worker`
- queue consumer using `QueueProvider` interface
- run execution: model API calls, streaming delta emission
- sub-agent spawn: create child agent record, create task, enqueue child job
- basic task/run state machine
- tool execution for safe tools (web search, document read)
- emit WebSocket events via shared event emitter (agent.status, agent.tool.start/end, agent.spawned, run.updated, message.new)
- worker jobs carry `AuthorizedActionContext` from `packages/schemas`

### Step 4: React admin UI

- `/admin` on React + Vite
- UI stack: Tailwind CSS + shadcn/ui for primitives, custom components on top
- TanStack Query via `QueryProvider`
- provider tree: `AppProvider` > `AuthSessionProvider` > `ApiClientProvider` > `QueryProvider` > `ThemeProvider`
- React Router (`createBrowserRouter`) for routing, channel selection via URL state
- domain facades: `auth`, `channels`, `agents`, `tools`, `threads`, `messages`, `runs` (see [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md) section 5.2)
- auth flow: bootstrap detection, login form, SSO redirect
- channel list and thread view
- agent drawer
- basic tools surface
- agent activity panel (always visible, WebSocket-driven status dots)
- agent detail drill-down (sub-agent tree, tool log, last 5 messages)
- `AgentThoughtStream` stub with placeholder
- channel/user/agent administration shell
- all mandatory components from [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md) sections 8 and 9.4

### Step 5: Landing page

- `/web` — minimal landing page only
- keep non-blocking on backend/admin progress

### Step 6: Local packaging

- `/cli` launcher package
- `nessie local up --docker` / `--no-docker`
- `nessie local doctor`
- `nessie local down`, `status`, `logs`, `reset`
- Docker Compose config at `infrastructure/compose/`
- non-Docker child process startup

## 5) Quality gates

Phase 1 must ship with strict gates for both `/admin` and `/api`:

- lint must fail the build
- typecheck must fail the build
- production build must fail on unresolved warnings/errors that affect correctness
- CI must run the same gates locally and in hosted builds

Minimum gate set:

- `/admin`: ESLint, TypeScript, production build
- `/api`: ESLint, TypeScript, test suite, production build
- shared formatting rules should be enforced repo-wide

## 6) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md)
- [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [phase1-prisma-schema.md](./phase1-prisma-schema.md)
- [config-module-spec.md](./config-module-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [approval-gating-spec.md](./approval-gating-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [token-ledger-spec.md](./token-ledger-spec.md)
- [tool-registry-spec.md](./tool-registry-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [step-up-verification-spec.md](./step-up-verification-spec.md)
- [language-and-translation-spec.md](./language-and-translation-spec.md)
- [knowledge-base-requirements.md](./knowledge-base-requirements.md)
- [external-tool-integration.md § Remote MCP Servers](./external-tool-integration.md#remote-mcp-servers-self-hosted-runners)
- [phase-review-process.md](./phase-review-process.md)
- [functionality.md](./functionality.md)
