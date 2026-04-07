# Secret Management and Retrieval Design

> Status: target-state design.

## 1) Objective

Store and use secrets without ever placing plaintext secrets in chat, prompts, model context, or normal tool metadata.

Every secret use must follow:
- write once through a secure REST API
- strict scope-based access control
- retrieval only when the actor and tool path is authorized
- aggressive redaction in all logs and UI events.

This document is **target-state design**. Secret services must be implemented outside model context.

## 2) Scope model

Secret scope is explicit and non-implicit:

- `org`: visible within one organization boundary and governed by organization policy.
- `global`: visible to users/agents allowed at organization scope.
- `project`: dedicated release-safety boundary for deployment, keys, and documentation.
- `team`: bounded to team membership and policies.
- `channel`: bounded to channel membership and policies.
- `agent`: visible only to that agent and allowed managers/operators.
- `thread`: bounded to a specific conversation/thread.
- `user`: personal operator-only secret.
- `service`: bounded to non-human callers (CI, orchestrator service, worker service).

`workspace` is accepted only through legacy compatibility parsing and mapped internally to `project` before policy evaluation.

Only one scope (or a hierarchy of scopes) may be chosen at secret creation time.

## 3) Lifecycle behavior

1. A UI secret form opens a secure modal.
2. User enters:
   - name and optional description
   - scope and scope target
   - allowed actors/channels/agents
   - optional expiry and rotation period
3. The UI sends only the plaintext through a secure POST endpoint and receives back a `secretRef` (`secret_...`) and metadata.
4. Tool or agent stores only the reference in configuration, not the raw value.
5. Runtime components resolve secrets from the store when required and immediately redact them after use.

If a secret is scoped narrower than the actor’s existing privilege, normal privilege is insufficient without explicit binding.

## 4) Data model (target)

### 4.1 Secret definition

```ts
type SecretRecord = {
  id: string;                 // internal ID
  ref: string;                // human-safe reference ID returned to UI/tools
  name: string;
  scopeType: 'org' | 'global' | 'project' | 'team' | 'channel' | 'agent' | 'thread' | 'user' | 'service';
  organizationId: string;     // required anchor for namespace boundary
  // one of the following is used as scopeTargetId, required for non-global scopes
  scopeId: string;
  secretType: 'api_key' | 'password' | 'token' | 'cert' | 'other';
  ownerId: string;            // user or service that registered it
  createdByActorId: string;
  createdAt: string;          // ISO timestamp
  updatedAt: string;
  rotateAt?: string;
  expiresAt?: string;
  status: 'active' | 'revoked' | 'expired';
  // encryptedBlob stores cipher + nonce + version + keyRef
  encryptedBlob: string;
  cipherMeta: {
    alg: 'aes-256-gcm' | 'xchacha20poly1305';
    keyRef: string;
    ivOrNonce: string;
    tag: string;
    version: number;
  };
  labels?: string[];
};
```

### 4.2 Access bindings

```ts
type SecretBinding = {
  secretId: string;
  principalType:
    | 'org'
    | 'project'
    | 'team'
    | 'channel'
    | 'agent'
    | 'thread'
    | 'user'
    | 'service';
  principalId: string;
  allowedActions: Array<'read' | 'resolve' | 'update' | 'rotate' | 'revoke' | 'delete'>;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
};
```

### 4.3 Access precedence

- deny-first policy evaluation
- evaluate in order:
  1. organization policy
  2. project policy (if present)
  3. team policy (if present)
  4. channel policy (if present)
  5. agent policy (if provided in invocation context)
  6. tool policy (if tool path restriction exists)
  7. user custom override (if present)
  8. secret explicit bindings
- explicit deny blocks read and resolve even when higher-level allows exist.

### 4.4 Canonical actor and request envelope

Deterministic authorization and secret operations require a single normalized context object.

```ts
type SecretAccessContext = AuthorizedActionContext & {
  actionContext: AuthorizedActionContext['actionContext'] & {
    purpose: string;
  };
};
```

Rules:

- `SecretAccessContext` extends the shared canonical contract from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- `actionContext.purpose` is mandatory for `resolve`, `rotate`, `revoke`, and `delete`
- secret APIs must not redefine actor, tenant, approval, or verification fields independently

## 5) Encryption requirements

- minimum encryption standard: 256-bit strong encryption.
- encryption must be symmetric AES-256-GCM or equivalent strong AEAD.
- required encryption metadata:
  - algorithm
  - key identifier
  - nonce/IV
  - authentication tag
  - format/version
- key strategy:
  - envelope encryption with a long-lived key (KEK) + per-secret data key (DEK) is preferred.
  - `NESSIE_SECRETS_MASTER_KEY` can be a bootstrap default, but KMS-managed key IDs should be supported.
- secrets in transit must use HTTPS/TLS.
- no secret value is ever returned in list, metadata-only endpoints, or UI autocomplete.

## 6) API contracts

### 6.1 Core endpoints

- `POST /secrets`
  - accepts secret payload and scope binding
  - requires `actorContext` in request body (see Section 4.4)
  - returns `{ secretRef, id, createdAt }` only
- `GET /secrets`
  - metadata-only list, filter by scope/name/tags/owner
  - requires query context: `organizationId`, optional `projectId`, optional `teamId`, optional `channelId`, optional `threadId`
- `GET /secrets/{secretRef}`
  - returns metadata only
- `PATCH /secrets/{secretRef}`
  - update metadata, scope, expiry, labels
  - requires `SecretAccessContext`
- `POST /secrets/{secretRef}/rotate`
  - replaces ciphertext; optional rotate key + audit entry
  - requires actor context and optional approval proof
- `POST /secrets/{secretRef}/revoke`
  - mark revoked and invalidate cached in-memory copies
  - requires actor context and project-scope checks for scoped secrets
- `DELETE /secrets/{secretRef}`
  - hard delete or encrypted tombstone depending on policy
  - requires actor context, explicit reason, and approval for high-impact secrets
- `POST /secrets/{secretRef}/resolve`
  - returns plaintext only to authorized service code paths
  - never emits in SSE/chat/agent-visible event payloads
  - request body MUST include full `SecretAccessContext`
- All core endpoints should have equivalent MCP actions in the control-plane registry for programmatic operators:
  - `secrets.create`, `secrets.list`, `secrets.get`, `secrets.update`, `secrets.rotate`, `secrets.revoke`, `secrets.delete`,
  - `secrets.resolve`, `secrets.access_check`.
- MCP and REST contracts must keep the same `action`, `SecretAccessContext`, reason-code model, and audit fields.

### 6.2 Access binding endpoints

- `POST /secrets/{secretRef}/grants`
  - body includes `SecretAccessContext`, principal type/id, actions, scope override, optional expiry
- `DELETE /secrets/{secretRef}/grants/{grantId}`
  - requires caller authorization at binding-manager scope
- `GET /secrets/{secretRef}/grants`
  - returns explicit bindings with resolved precedence order

### 6.3 Context safety endpoints

- `GET /secrets/audit`
  - immutable event list: who resolved/created/updated/revoked/rotated
- `POST /secrets/access/check`
  - evaluate allow/deny and reason code before tool execution
  - request body:
    ```ts
    {
      secretRef: string;
      action: 'read' | 'resolve' | 'rotate' | 'revoke' | 'delete';
      context: SecretAccessContext;
    }
    ```
  - when policy requires step-up verification, `context.verification` must be present and valid or the request fails with a verification reason code.

## 7) Tool/agent runtime integration

- Tool calls must pass secret references, not plaintext (`secretRef` fields only).
- Orchestrator and MCP adapter must resolve secrets in a non-chat path:
  - pre-execution check: policy -> step-up verification (when required) -> secret resolve -> execute -> immediate erase.
- Denied actions must emit structured deny reason codes (`NO_SCOPE_MATCH`, `DENIED_BINDING`, `BAD_CONTEXT`, `SECRET_EXPIRED`, `SECRET_REVOKED`, `SECRET_NOT_FOUND`, `POLICY_DENY`, `RATE_LIMITED`).
  - step-up failures should use dedicated verification reason codes such as `VERIFICATION_REQUIRED`, `VERIFICATION_FAILED`, `VERIFICATION_EXPIRED`, and `VERIFICATION_REUSED`.
- In-memory secret cache:
  - optional, short TTL (e.g., 30–60s),
  - actor/thread scoped,
  - no cross-thread reuse,
  - explicit flush after task completion.

Project-scoped guardrails:

- Project-bound secrets must include a concrete `scopeId` that maps to a valid project.
- Resolve operations with missing `projectId` in context are denied (`BAD_CONTEXT`).
- Cross-project reads are denied unless there is an explicit project-share binding in secret or project policy.

## 8) Runtime event contract

- `secret.access_check`
  - emitted when pre-execution policy + scope check passes
  - no secret value in event payload
- `secret.access_denied`
  - emits `reasonCode` for policy/debug and `policySourceIds` used to resolve the decision
- `secret.resolve`
  - emitted when plaintext is issued to service runtime
  - no secret value in event payload; only metadata and call hash

Project lifecycle tie-ins:

- `projectId` should be included on audit records for all secret events.
- When a project is not in `active` state, only read/search operations are allowed according to policy.

## 9) Secret lifecycle, governance, and risk controls

- Expiry/rotation required for high-risk secret types (provider tokens, deploy keys, DB passwords).
- Verification enrollment secrets, TOTP seeds, and recovery codes are also secrets and must use the same `secretRef` handling.
- Never store credentials in chat; require secret popup entry every time unknown secret is needed.
- Never embed secret values in generated diffs, diagnostics, tool call payloads, or logs.
- Audit records should include hash of action path and policy source; do not log plaintext secret content.
- Support emergency purge by org admin (all secrets owned by user/channel/thread).

## 10) UI requirements

- Secret creation UI must be out-of-band from chat input.
- Dialog must include scope selector:
  - global/project/team/channel/agent/thread/user/service
- Must show explicit recipient set (agents + channels + operators allowed).
- Should support copy of secret reference only (never full secret).
- Should show last-used + last-rotated status with risk warning on stale/expiring secrets.

## 11) Open questions to resolve before implementation

- Do we need org-level secret vault isolation by deployment region?
- Do we require hardware-backed KMS (default/enterprise mode) or local master key in `.env`?
- Should thread-scoped secrets auto-expire on thread close or only on explicit expiry?
- Should we support split custody (dual control) for high-risk secret mutations by policy type and actor role?

## 11.1) Non-release enterprise use cases (secret model)

- Customer service and partner onboarding:
  - temporary secrets per client with project-scoped expiry and auto-revocation at contract end.
- Financial and healthcare environments:
  - strict retention plus dual-control rotations for provider tokens used in production change windows.
- Vendor and contractor contexts:
  - project-limited delegated access with explicit `read` only unless explicit escalation is approved.
- Incident forensics:
  - emergency secret freeze per project and immediate read suppression for non-critical scopes.
- Data residency and sovereign constraints:
  - secret keys tied to project region and blocked from cross-region resolution without explicit policy override.

## 12) Validation against current app state

- Current runtime currently reads provider keys from process env for backend services.
- No first-class secret vault exists yet.
- No secret grant model is enforced for tool/tool-call execution.
- No secret audit trail or resolve endpoint exists.
- No UI-only secret capture flow exists yet.

## 13) Release safety scenario to preserve (must be supported before wide rollout)

- A user can define multiple isolated `project`s under one organization.
- Each project has:
  - dedicated secrets for CI/CD providers, infrastructure, and deployment targets,
  - dedicated documentation corpus in the knowledge base,
  - dedicated agent and channel memberships.
- Failure in one project must not impact DNS, domains, or secrets in any other project.
- Project deletion/rotation flows must require project-scoped approvals and clear blast-radius audit before irreversible actions.
- A project that loses access to its primary provider credentials should degrade safely and cannot auto-affect unrelated projects in the same organization.

Cross-link:
- [agent tool capabilities](./agent%20tool%20capabilities/index.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [functionality.md](./functionality.md)
