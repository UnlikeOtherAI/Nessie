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

1. React CSR shell:
   - `/admin`:
      - auth entry
      - one shared auth/session provider
      - channel list
      - thread view
      - agent drawer
      - basic tools surface
      - agent activity panel (always visible, WebSocket-driven status dots)
      - agent detail drill-down (sub-agent tree, tool log, thought stream, last 5 messages)
      - channel/user/agent administration shell
      - TanStack Query via `QueryProvider`
   - `/web`:
     - landing page only
2. API + Postgres schema:
   - `/api`
   - API base path:
     - all HTTP routes live under `/api/...`
     - Phase 1 SSE streaming also lives under `/api/...`
   - bootstrap data model:
     - every organization gets one default project
     - every default project gets one default team
     - channels and agents bind inside that default containment model
    - users
    - projects
    - teams
    - channels
    - agents
    - threads
    - messages
   - `queue_jobs` table for pgqueue local adapter
   - minimum Phase 1 API surface:
     - `POST /api/auth/bootstrap` (first-user creation, see [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) section 4.3a)
     - `GET /api/auth/providers`
     - `POST /api/auth/session`
     - `DELETE /api/auth/session`
     - `GET /api/auth/me`
     - `GET /api/channels`
     - `POST /api/channels`
    - `GET /api/agents`
    - `POST /api/agents`
    - `POST /api/agents/{agentId}/bindings`
    - `GET /api/tools`
    - `GET /api/threads/{threadId}/messages`
    - `POST /api/threads/{threadId}/messages`
    - `GET /api/threads/{threadId}/stream`
   - agent activity and observability:
    - `GET /api/agents/{agentId}/status`
    - `GET /api/agents/{agentId}/activity`
    - `GET /api/agents/{agentId}/messages?limit=5`
    - `GET /api/agents/{agentId}/children`
    - `GET /api/agents/{agentId}/runs/{runId}/tools`
    - `WS /api/activity` (WebSocket for real-time agent status, tool execution, sub-agent lifecycle events)
3. Worker and run model:
   - `/worker`
   - streaming
   - sub-agent spawn
   - basic task/run records
   - canonical actor context comes from the auth/session layer, not page-local helpers
   - worker jobs carry the same `AuthorizedActionContext` from `packages/schemas`
4. Safe tools:
   - web
   - docs/knowledge read
5. Basic admin flows:
   - create channel
   - create agent
   - bind agent
   - invite user
6. Local packaging:
   - Docker path
7. Shared foundations:
   - `packages/schemas`
   - `packages/config`
   - non-Docker path
   - `nessie local doctor`
   - `nessie local up`

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
- [organization-governance-spec.md](./organization-governance-spec.md)
- [remote-worker-spec.md](./remote-worker-spec.md)
- [functionality.md](./functionality.md)
