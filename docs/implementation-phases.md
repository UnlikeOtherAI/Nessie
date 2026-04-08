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
  - local bootstrap path for first-user creation (see [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) section 4.3a)
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
- gate sensitive actions with approval.

### Phase 2 exit gate

Phase 2 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots and hosted deployment paths.

### Phase 2 code-level prerequisites (Phase 1 → Phase 2 migration)

These are Phase 1 code assumptions that **must be fixed** before or during Phase 2 feature work. Identified by Codex deep review (2026-04-08).

#### Critical — security / correctness

1. **WebSocket subscriptions bypass channel privacy.** Events are published at org scope (`worker/src/run/execute.ts`, `api/src/index.ts`), and the hub delivers on org match alone (`api/src/realtime/hub.ts`). Phase 2 must filter WS events by channel membership/privacy before delivery.
2. **Shared-agent REST endpoints leak cross-channel history.** Agent status/activity/messages loaders return global history without channel scoping (`api/src/services/agents.ts`). Phase 2 must scope agent data queries to the caller's accessible channels.
3. **Agent binding has no authorization check.** Any user who can see a channel can bind any known agent (`api/src/index.ts`, `api/src/services/agents.ts:498`). Phase 2 must enforce policy check on `agent.bind`.
4. **`NESSIE_AUTH_SECRET` fallback to per-process random breaks multi-instance.** API falls back to in-memory random (`api/src/index.ts:103`). On Cloud Run with multiple instances, tokens from one instance fail on another. Phase 2 must require a persistent shared secret or use Cloud KMS.

#### High — architectural prerequisites

5. **Auth/session contract cannot represent multi-membership users.** `TenantContext` holds one org/project/team. `users.ts` hard-selects first membership. Phase 2 must evolve JWT and `/me` to support project/team switching (see JWT evolution in deployment-modes-and-auth-spec.md).
6. **Login and SSO auto-provision hardcode bootstrap org/project/team IDs.** All auth paths issue reserved bootstrap container IDs. Phase 2 must resolve user's actual memberships from DB.
7. **Worker ignores `actorContext`.** Jobs carry context (`packages/schemas`) but `executeRunJob` never uses it for policy, approval, audit, or ledger. Phase 2 must propagate and enforce.
8. **Run execution is not idempotent.** No idempotency key on enqueue, no "already completed" guard in worker. At-least-once queue retries can duplicate output. Phase 2 must add idempotency boundaries per control-plane invariant #2.
9. **Agent model lacks ownership fields.** `Agent` has no org/project/team owner. `AgentBinding` is unscoped. Phase 2 Prisma migration must add ownership and enforce it.
10. **No tenant hierarchy consistency constraints in DB.** `Channel` references org and team independently — no FK constraint that the team's project belongs to the same org. Phase 2 should add application-level invariant checks (or DB triggers).
11. **Public channels require membership to be visible.** Channel listing filters by `channel_members` rows, hiding public channels from non-members. Phase 2 must implement privacy-level-aware listing.
12. **Queue provider not config-switchable.** Worker always boots `PgQueueProvider`. Phase 2 must wire `config.queue.provider` to provider factory.

#### Medium — operational

13. **Channel listing N+1.** `listChannelsForUser` calls `ensureDefaultThread` per channel with find-then-create race. Phase 2 should use `upsert` and batch.
14. **Activity queries don't scale.** Snapshot building does per-agent queries; activity loads full history before trimming. Phase 2 should add pagination and indexed queries.
15. **Admin WS client missing ping.** No keepalive ping per spec (30s interval). SSE client missing `Last-Event-ID` reconnect. Phase 2 must fix both to survive Cloud Run connection cycling.

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

- Prisma schema additions: project CRUD, team CRUD, membership tables
- JWT evolution: multi-project support (project/team selection, not hardcoded single project)
- `GET /api/auth/me` returns available projects/teams for the user
- User invitation flow: `POST /api/orgs/{orgId}/users`
- Project creation and membership: `POST /api/projects`, `POST /api/projects/{projectId}/members`
- Team creation and membership: `POST /api/teams`, `POST /api/teams/{teamId}/members`
- Identity Platform integration for hosted auth default
- See [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)

#### Step 2: Channel privacy and membership-aware discovery

- Channel privacy levels: public, protected, private
- Channel membership enforcement at query and routing time
- Privacy-aware channel listing: `GET /api/teams/{teamId}/channels`
- Membership-aware agent discovery: agents filtered by channel access
- Membership-aware tool discovery: tools filtered by policy scope
- Private channels excluded from search for non-members
- See [organization-governance-spec.md](./organization-governance-spec.md) section 2.2 and 4.1

#### Step 3: Policy enforcement engine

- Prisma models: `PolicyRule`, `PolicyBinding`
- `PolicyEnforcer` service with chain evaluation algorithm
- Policy check integration at: channel access, agent binding, tool visibility, admin actions
- `GET /api/policy/effective` endpoint
- `POST /api/policy/check` inline access check endpoint
- Default seed policies for new organizations
- Redis-backed effective policy cache with invalidation
- See [policy-enforcement-spec.md](./policy-enforcement-spec.md)

#### Step 4: Approval gating v1

- Prisma model: `ApprovalRequest`
- `RunStatus.waiting_approval` in Prisma enum and `packages/schemas`
- `approval.resolved` in WsEventMap and `packages/schemas`
- Worker pause/resume flow with continuation tokens
- API endpoints: create, list, get, resolve approvals
- Expiry sweep periodic job
- Approver resolution based on policy chain
- Frontend: pending approvals badge, approval detail view, approve/reject actions
- See [approval-gating-spec.md](./approval-gating-spec.md)

#### Step 5: Audit trail

- Prisma model: `AuditLog`
- `AuditEmitter` interface with Postgres-backed implementation
- Audit events emitted at all Phase 2 control-plane actions
- API endpoints: list, get, export audit logs
- Redaction layer for sensitive fields
- See [audit-trail-spec.md](./audit-trail-spec.md)

#### Step 6: Token ledger v1

- Prisma models: `TokenLedgerEvent`, `ModelPricingProfile`
- Ledger event ingestion from worker on every model call
- Summary and rollup endpoints by org/project/team/channel/agent/user/model
- Monthly estimate endpoint
- Pricing profile CRUD with audit trail
- Admin UI: usage dashboard, pricing management
- See [token-ledger-spec.md](./token-ledger-spec.md)

#### Step 7: Admin UI extensions for Phase 2

- Project and team administration pages
- Channel privacy settings UI
- User invitation and membership management
- Approval queue and resolution UI
- Token usage dashboard
- Policy rule management (admin-only)
- Audit log viewer

#### Step 8: Hosted deployment validation

- End-to-end flow on Cloud Run: signup → create project → create channel → chat → approval → audit
- Load test: verify Cloud Run autoscaling under concurrent users
- Pub/Sub delivery verification with dead-letter handling
- Cloud SQL connection pooling under load
- WebSocket reconnect across Cloud Run instance restarts
- Cost validation against estimates

### Phase 2 spec references

- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md) — GCP deployment topology and infrastructure
- [policy-enforcement-spec.md](./policy-enforcement-spec.md) — runtime policy enforcement engine
- [approval-gating-spec.md](./approval-gating-spec.md) — approval gating system
- [audit-trail-spec.md](./audit-trail-spec.md) — audit trail system
- [token-ledger-spec.md](./token-ledger-spec.md) — token usage tracking and cost estimation
- [organization-governance-spec.md](./organization-governance-spec.md) — multi-tenant governance model
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) — shared type contracts (Phase 2 additions)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) — auth modes and deployment modes

## Phase 3: Tooling and Knowledge Platform MVP

### Goal

Make Nessie useful as a serious agent platform rather than only a chat surface.

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

### What makes it workable

At the end of phase 3, teams should be able to:

- install and bind tools,
- search available tools without polluting agent context,
- ingest documentation,
- search docs safely,
- store scoped secrets,
- require step-up verification for sensitive secret use,
- collaborate across languages.

### Phase 3 code-level prerequisites (Phase 2 -> Phase 3 migration)

These are Phase 2 code assumptions that **must be fixed** before or during Phase 3 feature work.

#### Critical -- tool system

1. **Hardcoded tool list.** `api/src/services/tools.ts` defines a static `SAFE_TOOLS` array with 3 tools. `worker/src/run/execute.ts` dispatches via if-statements in `executeSafeTool()`. Phase 3 must replace with dynamic tool registry lookup.
2. **Tool endpoint returns unscoped list.** `GET /api/tools` (`api/src/index.ts:680`) returns all tools without filtering by agent grants, user role, or organization scope. Phase 3 must enforce grant-based visibility.
3. **Agent `toolPolicy` field defined but unused.** `api/prisma/schema.prisma` has `toolPolicy Json?` on Agent but nothing reads or enforces it. Phase 3 must define the schema, populate it, and enforce at execution time.
4. **No tool execution enforcement.** Worker tool dispatch (`worker/src/run/execute.ts:297-360`) does not check agent grants before invoking a tool. Phase 3 must add policy check before every tool call.

#### Critical -- secrets

5. **Model API keys read from raw env vars.** `packages/config/src/index.ts` reads `NESSIE_MODEL_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY` directly from environment. Phase 3 must integrate secret vault with encrypted storage, `secretRef` resolution, and audit.
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

- Prisma models: `ToolRegistryEntry`, `ToolGrant`, `ToolBundle`, `PromptLayer`, `SecretRecord`, `SecretBinding`, `VerificationEnrollment`, `VerificationChallenge`, `VerificationPolicy`, `KnowledgeSource`, `KnowledgeDocument`, `KnowledgeShareGrant`
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
- `GET /api/orgs/{orgId}/language`, `PATCH /api/users/{userId}/language`
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

### What makes it workable

At the end of phase 5, an organization should be able to:

- use Nessie for higher-risk operational workflows,
- contain mistakes by project boundary,
- audit privileged actions properly,
- manage spend and access more safely,
- run both hosted and self-hosted installations with confidence.

### Phase 5 exit gate

Phase 5 is not complete until the mandatory end-of-phase review gate in section `1.1` passes for all affected roots, hosted/self-hosted deployment paths, and enterprise control surfaces.

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
- Fastify auth middleware with JWT validation (see [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) section 4.3c)
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
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
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
- [remote-worker-spec.md](./remote-worker-spec.md)
- [phase-review-process.md](./phase-review-process.md)
- [functionality.md](./functionality.md)
