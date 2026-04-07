# Organization-Scale Multi-Agent Governance (Nessie Target-State)

> Status: target-state design.

## 1) Objective

Design a multi-tenant, multi-user, multi-agent control plane where:

- Any authenticated user can interact with Nessie via web, MCP, and operator tooling.
- Teams/organizations can run shared agents without sharing full system privilege.
- Access to agents, channels, tools, and capabilities is scoped by explicit ACLs.
- Channel and team boundaries remain private by default and must be enforceable at routing and tool-execution time.
- Projects are first-class release isolation boundaries so operational mistakes are contained.

This is the source of truth for organization and access-control requirements before implementation.

## 2) Core governance model

### 2.1 Topology

- `Organization` is the trust boundary top-level unit.
- `Organization` also owns canonical communication settings such as default storage language.
- `Project` is an isolation boundary for release, documentation, secrets, tooling, and agent access.
- `Team` is a functional circle inside a project.
- `Workspace` is legacy/migration-only and is not a first-class boundary in new APIs.
- `Channel` is the communication audience inside a team (chat, routing, and visibility scope).
- `User` may belong to one or more teams/channels.
- `ManagedAgent` may be owned by one team/project and surfaced in multiple channels.
- `Tool` is capability surface (registry entry) with policy metadata and execution constraints.
- `Role` is optional semantic tag (e.g. orchestrator, reviewer, researcher) used for inherit/override policy.
- `Session` is a thread/thread-keyed conversation context.

### 2.2 Privacy levels for channels and teams

- `public`: discoverable and subscribable by organization members.
- `protected`: membership required for read/write or invocation.
- `private`: invitation-only and hidden from non-members, including from search.

Rules:

- Messages to `public` channels may be visible in directory/search based on visibility settings.
- `protected` and `private` channels must not be resolvable via generic tool/agent listing unless caller has explicit channel membership.
- Read and write permissions are separate in the policy model.

## 3) Policy and permission model

Use a merged policy chain with explicit deny support:

1. Organization base policy
2. Project policy
3. Team role policy
4. Channel policy
5. Agent policy
6. Tool policy
7. User custom override
8. Resource-specific explicit bindings (for example secret grants or knowledge-base share grants)

Defaults are inherited down the chain and can be narrowed by explicit deny at any layer.

### 3.1 Actions and resources

Each permission is a matrix on:

- `resourceType`: `agent`, `channel`, `project`, `tool`, `session`, `task`, `review`, `approval`, `admin`, `secret`.
- `action`: `view`, `invoke`, `create`, `edit`, `assign`, `approve`, `review`, `search`, `export`, `admin`, `readSecret`, `resolveSecret`, `rotate`, `revoke`.
- `scope`: `thread` / `team` / `channel` / `agent` / `organization` / `project`.
- `context`: teamId, projectId, channelId, agentId, toolId, sessionId.

### 3.2 Identity binding

- Every command and tool call must carry a signed actor context:
  - actor type (`user`, `agent`, `service`)
  - actor ID
  - roles
  - team memberships
  - project memberships
  - active sessions
- `workspace` must be canonicalized to `project` before policy evaluation where backward-compatibility input is accepted.
- Actor context is required at:
  - routing time (`handleUserMessage`/session ingress),
  - tool resolution time,
  - tool execution time,
  - approval/review workflows.

## 4) Functional requirements

### 4.1 Organization and channel access

- Only users in project membership can read/write or invoke project-scoped agents/tools in that project unless explicitly elevated.
- Team membership applies inside project scope unless policy states broader project-level access.
- Organization policy may define one canonical communication language for stored chat and audit content.
- Users may define their own preferred delivery language without changing the canonical organization-language record.
- Users should also be able to define their own pronouns/profile references so translation and rendering can preserve correct grammatical forms across languages.
- Channel-specific visibility:
  - hidden/private channels not shown in global search unless caller has membership,
  - explicit channel membership check on every routing candidate.
- Channel access can be dynamic:
  - user add/remove by org admin,
  - bot-agent membership by approval workflow,
  - auto-expiry for temporary access tokens.

### 4.2 Team-gated agent inventory

- Each team has visible roster of agents:
  - default roster (team-owned),
  - shared roster (explicitly shared from another team),
  - restricted roster (by tool class or function domain).
- Discovery endpoints must support filtered scoped search:
  - `scope=team`,
  - `scope=channel`,
  - `scope=shared`,
  - `scope=all` with permission gate.
- Non-member callers must not get full agent details, and should only see denied placeholders if channel is discoverable by policy.

### 4.3 Team-gated tool access

- Tools are available only when:
  - caller can resolve to an accessible channel/team,
  - agent can resolve tool in inherited policy,
  - tool policy allows call in current context.
- `ssh` is explicitly categorized as privileged unless explicitly delegated:
  - requires explicit `tool=ssh` allow in team and channel policy,
  - requires host allowlist policy and optional key allowlist,
  - may require explicit approval for sessions longer than configured TTL or non-read-only commands.
- Tool categories:
  - filesystem/network-sensitive tools default-restricted to admin/restricted teams,
  - read-only tooling default-allowed for broader teams where safe,
  - destructive tooling requires explicit approval and elevated role.
- Tool config values must be preserved as arbitrary JSON (`Record<string, unknown>`) per tool instance so any future CLI/tool-specific flags can be passed by CLI and marketplace manifests.

### 4.4 Slack-style routing in org context

- Organizer routing must remain silent by default in all scoped channels.
- For implicit queries, organizer chooses one visible responder from permitted channel + team + agent + tool policy.
- For explicit `@channel`/`@agent`, visibility is narrowed to target and only shown when caller has invoke permission.
- For `@all`/broadcast, organizer composes output only from members where both user-to-channel and agent-to-channel permissions pass.
- `agent.pointOfView` traces may be kept private and revealed when user requests multi-perspective mode.

### 4.5 Approval gating

- Certain actions must require explicit approval even when tool allowlist permits:
  - destructive filesystem writes outside safe roots,
  - network calls outside approved egress domains,
  - command tools in elevated privilege mode,
  - user impersonation and automation commands.
- Approval is scoped:
  - who can request,
  - who can approve,
  - who can reject,
  - expiry and reason retention.

### 4.6 Step-up verification add-on

- High-risk actions may require a verification factor in addition to approval:
  - email code verification,
  - link-based confirmation,
  - QR-based authenticator enrollment,
  - TOTP challenge,
  - future factor types via the same policy model.
- Step-up verification must be transferable across deployments, email sends, secret rotation, and other privileged actions.
- The verification proof must attach to the same control action envelope used by approval gating.
- TOTP enrollment secrets and recovery codes are treated as secrets and must be stored outside chat with scoped access.
- Cross-link: [step-up-verification-spec.md](./step-up-verification-spec.md).

### 4.7 Multilingual communication and translation

- each organization may define one canonical storage language for communication.
- each user may define one preferred delivery language for UI and chat rendering.
- thread/session-level temporary language overrides are allowed, but they do not change canonical storage language.
- inbound non-canonical-language messages must be normalized into the organization default language before persistence and routing.
- outbound messages may be translated per-recipient at delivery time.
- cross-link: [language-and-translation-spec.md](./language-and-translation-spec.md).

### 4.8 Token ledger and pricing governance

- every organization should have a token ledger for all model usage across all providers and models.
- ledger must record input tokens, output tokens, and cached-token metrics when providers expose them.
- organization owners/admins can define pricing overrides for estimation when they do not want to rely on provider default pricing.
- team owners should be able to view team-scoped usage and cost rollups.
- monthly estimates should be available by org, team, project, channel, agent, and model.
- cross-link: [token-ledger-spec.md](./token-ledger-spec.md).

## 5) API/contracts required

### 5.1 Discovery and search

- `GET /orgs/{orgId}/teams` with member filtering
- `GET /orgs/{orgId}/projects` with membership-aware visibility
- `GET /teams/{teamId}/channels` with privacy-aware search
- `GET /projects/{projectId}/members?roleOnly=true`
- `GET /projects/{projectId}/agents?search=...`
- `GET /teams/{teamId}/agents?search=...`
- `GET /channels/{channelId}/members?roleOnly=true`
- `POST /channels/{channelId}/members`
- `POST /channels/{channelId}/agents`
- `GET /agents/search`
  - query filters: `orgId`, `teamId`, `channelId`, `teamScope`, `toolIds`, `role`, `search`, `tag`
  - pagination: deterministic cursor
- `GET /tools/search`
  - query filters: `orgId`, `teamId`, `channelId`, `scope`, `transport`, `permission`, `tags`, `allow`

### 5.2 Policy reads (for organizer + UI)

- `GET /orgs/{orgId}/policy/effective?teamId=&channelId=&agentId=&toolId=`
- `GET /teams/{teamId}/policy`
- `GET /channels/{channelId}/policy`
- `GET /agents/{agentId}/policy`
- `GET /tools/{toolId}/policy`
- `GET /access/check`
  - input includes actor, resource, action, scope
  - deterministic allow/deny response
- `POST /secrets/access/check`
  - secret-specific access check for pre-execution path
  - reason codes aligned to secret runtime contract
- `POST /projects/{projectId}/safety/preflight`
  - deterministic impact graph for destructive or credential-changing actions before approval
- `POST /projects/{projectId}/safety/degrade`
  - force project into safe mode (deploy and write actions blocked)
- `POST /projects/{projectId}/safety/restore`
  - restore project from safe mode after approval
- `POST /projects/{projectId}/archive`
  - stop project routing and tooling; keep data available under read-only scopes
- `POST /projects/{projectId}/restore`
  - reactivate archived project and restore previous bindings
- `POST /projects/{projectId}/delete`
  - destroy project resources under policy and retention guardrails
- `GET /projects/{projectId}/policy`
  - project-level merged policy for routing and execution
- `GET /projects/{projectId}/audit`
  - immutable project audit events (policy + secret + tool access)

### 5.1a MCP parity for governance actions

- Governance APIs should be mirrored as MCP tools where action intent is operator-driven:
  - `org.create`, `org.update`, `org.list`
  - `project.create`, `project.update`, `project.members.add`, `project.members.remove`
  - `project.channels.create`, `project.channels.update`, `project.channels.members.search`
  - `agent.register`, `agent.update`, `agent.bind`, `agent.unbind`
  - `tool.import`, `tool.update`, `tool.bind`, `tool.unbind`
  - `role.assign`, `role.revoke`
  - `channel.member.add`, `channel.member.remove`
  - `policy.effective`, `policy.preview`, `policy.apply`
- MCP parity requirements:
  - deterministic input schema,
  - action idempotency (where safe),
  - actorContext + approvalProof where mandatory,
  - same allow/deny reason model and same paginated responses as HTTP search endpoints.

### 5.1b Chat operator surface as a control mirror

Every governance action in the table above must also be callable from chat by parsing to the same control action envelope.

- Chat command patterns should be deterministic and versioned in the UI surface (for audit and replay), not free-form.
- examples:
  - `create project <projectName> in org <orgId>` -> `project.create`
  - `add user <userId> to team <teamId>` -> `project.members.add` with explicit team binding
  - `bind agent <agentId> to channel <channelId>` -> `agent.bind`
  - `import toolset <toolsetPathOrUrl> into project <projectId>` -> `tool.import`
- rejected commands must return a reason and canonical recovery hint (e.g. `missing_channel`, `missing_role`, `requires_approval`, `approval_expired`).
- chat commands inherit current thread channel unless an explicit `channelId`/`scope` override is supplied.

### 5.3 Audit and incident visibility

- `GET /audit/permissions?orgId=&actor=&resourceId=` with immutable event records.
- Event fields:
  - `actor`,
  - `resource`,
  - `requestedAction`,
  - `decision`,
  - `policySource`,
  - `reasonCode`,
  - `evidence` (channel membership IDs, route candidate IDs).

## 6) Data model additions

- `OrganizationPolicy`
- `WorkspacePolicy` (legacy alias only; no new bindings)
- `Project`
- `ProjectPolicy`
- `ProjectMember`
- `ProjectAgentBinding`
- `TeamPolicy`
- `ChannelPolicy`
- `UserMembership`
- `AgentBinding`
- `ToolBinding`
- `ResourcePermissionGrant`
- `ActorContext`
- `SessionScope` and `SessionVisibility`

### 6.1 Canonical access context

All policy operations and checks MUST include this context envelope in a deterministic order:

```ts
type AccessActor = {
  actorType: 'user' | 'agent' | 'service';
  actorId: string;
  roles?: string[];
};

type AccessContext = {
  actor: AccessActor;
  tenant: {
    organizationId: string;
    projectId?: string;
    teamId?: string;
    channelId?: string;
  };
  actionContext: {
    teamId?: string;
    channelId?: string;
    agentId?: string;
    toolId?: string;
    taskId?: string;
    sessionId?: string;
    threadId?: string;
    requestId: string;
    correlationId?: string;
    purpose?: string;
  };
  approval?: {
    approverId?: string;
    approvalId?: string;
    approvalProof?: string;
    approvalContext?: Record<string, string>;
  };
  verification?: {
    challengeId: string;
    proof: string;
    factorType?: 'email_otp' | 'email_link' | 'totp' | 'webauthn';
  };
};
```

This is the canonical base envelope for policy checks. Resource-specific contracts may extend it, but they must not rename these fields.

### 6.2 Project safety baseline contracts

- Project lifecycle operations are auditable, reversible where possible, and require explicit approval for unsafe transitions:
  - `archive`, `degrade`, `restore`, `delete`.
- Events must include `tenant.projectId`, target actor, and reason chain to keep cross-project safety review deterministic.
- A project cannot be deleted while active release sessions exist; preflight must fail with explicit reason set and remediation hints.

Required invariants:

- channel/agent/tool visibility decisions are always computed from explicit policy IDs; no implicit defaults for unknown combinations.
- `effectivePolicy` writes are computed on read with cache-friendly hashes to avoid stale authorization decisions.
- every deny path must include first-match-of-deny reason for forensic debugging.

## 7) Security and trust boundaries

- `/chat`, `/mcp`, and WS endpoints must require auth on non-local deployments.
- Tokens can be scoped to organization, project, team, and service claims.
- Secrets should never be transmitted in plain-text tool configs or chat context.
- Secret access requires explicit allow bindings by actor scope (`org`, `project`, `team`, `channel`, `agent`, `service`, `thread`, `user`) and deny-first evaluation.
- Tool-call execution must enforce:
  - path policy,
  - env allow/deny,
  - command allowlists,
  - output and time limits,
  - interactive session scope.

## 8) Migration and implementation checks

### 8.1 MVP gating order

1. Add org/team/channel membership model with read/write ACL.
2. Add gated search endpoints for channels/agents/tools.
3. Add permission resolver used by routing and tool invocation.
4. Add nested organizer routing with org-aware candidate filtering.
5. Add explicit audit trail and policy-reasoning logs.
6. Add admin workflows for bulk team/channel membership and tool grants.

### 8.2 Non-goals (first phase)

- full HR identity management (rely on SSO provider),
- billing policy and quota enforcement,
- cross-organisation federation.

## 9) Current state (Nessie as-of-2026-04-07)

- No organization-level entity hierarchy exists yet.
- No team/channel membership ACL persisted for user-to-channel or user-to-agent.
- No team-aware filtering on `handleUserMessage`, tool execution, or MCP handlers.
- `channel` concept exists only as routing target placeholder in future-state docs.
- No organization-wide policy check layer; role/tool checks are not fully enforced in execution path.
- No multi-project model yet (`Project`, `ProjectAgentBinding`, `ProjectMember`, and project-scoped policies unresolved).

## 9.1) Heavy enterprise and regulated-workload use cases

Beyond release safety, the platform must support:

- Multi-tenant client services:
  - multiple external accounts per organization, each with dedicated channels, dedicated secrets, and separate audit streams.
- MLOps and data-plane governance:
  - regulated data projects with explicit egress restrictions, model-run budgets, and output retention controls.
- Finance/legal/HR operations:
  - role-bound workflow approvals, traceable access to payroll/legal tools, and immutable deny reasoning.
- Incident response and SOC-style playbooks:
  - pre-authorized responders, temporary elevated channels, and emergency `project.degrade` actions with automatic audit.
- Shared vendor / contractor model:
  - short-lived channel and tool grants, immediate revocation on contract end, and minimal context footprint.
- Compliance and residency:
  - region-bound projects, explicit data locality fields, and explicit dual-approval for destructive actions.

This section should be treated as mandatory acceptance context for later implementation and testing.

## 10) Reference targets

- [agent-communication-spec.md](./agent-communication-spec.md)
- [agent tool capabilities](./agent%20tool%20capabilities/index.md)
- [functionality.md](./functionality.md)
- [openclaw-agent-teams-implementation.md](./openclaw-agent-teams-implementation.md)

## 11) "Codex in background" execution plan

This requirement set should be executed through 4 parallel tracks:

- **Track A (Governance)**: model and enforcement layer (policy/ACL, actor context, access-check API).
- **Track B (Routing)**: multi-user organizer, private channel routing, team-aware candidate selection.
- **Track C (Tools)**: organization-aware tool catalog, tool search, tool import, CLI/PTY wrapper controls.
- **Track D (Compliance)**: audit trail, deterministic visibility, attack-surface hardening, test plans.

Each track should run as an independent workstream, push artifacts back into this spec, and reconcile through weekly checkpoint sessions to avoid interface drift.
