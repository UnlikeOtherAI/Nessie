# Executor Integration Plan

**Status:** approved — Phase 1 pairing control plane in progress

## Current implementation boundary

The current Phase 1 slice provides the durable executor record, scoped pairing,
private human/agent roster, exact operation grants, user-confirmed access
changes, the Executors home with a project doorway, Personal Assistant
prepare-only management, a signed daemon-presence handshake, and the
`nessie-executor` companion's secure key/state, enrollment, descriptor, and
heartbeat workflow. It now also projects stable logical executor operations
into the existing tool registry and resolves durable, opaque availability
candidates only when the human scope, exact executor-operation grant, explicit
logical policy, approved descriptor, local capability, and online state all
agree.
It now consumes an opaque candidate into a durable `ExecutorBinding` under an
exact `(run, operation)` lock. Binding re-reads the initiator, agent, scope,
membership, approved current descriptor, exact operation grant, logical grant,
online state, and authorization revision. It then consumes the candidate and
advances a binding-specific monotonic fence; daemon connection epochs and
binding fences remain separate. A retry must reuse the same candidate and
binding or fails closed.

The paired daemon now has a signed outbound command poll and a domain-separated
receipt channel. Queue payloads hold only a command id; operation arguments and
structured terminal results are AES-256-GCM encrypted at rest, bounded to 64
KiB, and linked to the existing queue job and `ToolCall`. The daemon receives a
short-lived envelope only after the linked job is processing and must emit
monotonic `accepted → started → result_acknowledged` receipts. The current
companion executes `sandbox.stop` plus bounded `file.list`, `file.read`,
`file.write`, and `workspace.review`. Reads start at one canonical, explicitly
paired workspace root; writes create a bounded daemon-owned COW tree keyed to
the server-provenanced run ID, and subsequent file reads/lists for that run use
that same draft tree. Review returns a bounded hash-backed change manifest from
the COW base, never a host-write command.

The worker dispatch adapter is now enabled for a run only after a human has
submitted an opaque availability handle. The normal launch path is
`POST /api/threads/:threadId/executor-runs`: it atomically creates the human
message, pending run, task, bindings, and existing `run.execute` queue job for
one bound channel agent. The launch accepts a small exact operation bundle;
each member is independently revalidated against the same opaque candidate in
one transaction. `POST /api/runs/:runId/executor-bind` remains the narrow
internal/continuation binding seam for an already-created single operation.
Neither endpoint accepts an executor id; the model receives only the bound,
explicitly granted logical operations and never a selection parameter. Command creation
reserves the normal `ToolCall`, creates an existing `executor.command` queue
job, and blocks on the encrypted receipt.
The queue handler retains its lease while the paired daemon works. Before
dispatch, the server rechecks the bound human, agent, scope/membership,
descriptor, operation and logical grants, lifecycle, and revision under the
executor fence. An absent terminal receipt becomes `unknown_outcome` and is
fatal/retry-safe, never a model-visible success; a late receipt for that exact
already-delivered command can resolve it without issuing new work. The model
schemas permit only bounded file operations, `workspace.review`, and
`sandbox.stop`; no host-promotion schema is present.

It does **not** dispatch host promotion, commands, browser work, or coding
sessions; those operations remain unavailable until their concrete isolated
backends are delivered. The paired root is a path-constrained local read
boundary: it rejects traversal and every symbolic link, keeps a fixed canonical
root in owner-only daemon state, bounds every listing/read result, and returns
no host paths. `file.write` is narrower: it creates a COW draft in an
owner-only per-run scratch directory, records a hash-only base manifest, rejects
links, special files and oversized source trees, and discards only that exact
scratch directory on stop. `workspace.review` can disclose at most 100 changed
relative paths, kinds, byte counts, and a digest after the same exact grants,
but fails closed if JSON encoding would exceed the command-receipt cap; it
cannot mutate the host. These operations are dispatched only after descriptor
review, the exact executor-operation grant, logical-tool grant, and a
human-bound run choice. Until the micro-VM,
forced egress, and reviewed promotion protocol exist, the paired host root
remains read-only.

The native promotion substrate remains unreachable from agents. Its
`workspace-preflight` command accepts the host root and COW draft only as
already-open descriptors, resolves each supplied relative path with native
no-follow calls, recomputes the canonical manifest digest, checks each current
host base and scratch digest, and returns a bounded ready/rejected result. Its
`workspace-apply` companion stages the verified draft in a private,
same-filesystem journal and either commits no-replace renames or restores an
uncommitted transaction on the next invocation; it requires existing safe host
parent directories. The owner-only companion can execute its
`workspace-apply` primitive only for a server-authored `workspace.promote`
command after a separately reviewed local policy names a verified native
helper. There is no worker schema for a model: only the originating user sees a
reviewed draft, prepares a short-lived continuation, and confirms it with a
fresh password. Confirmation rechecks the exact review/result digest, user,
run, agent, executor authorization, operation/logical/local-policy grants and
server-derived executor identity before atomically creating one bound encrypted
command, queue job and ToolCall. The native receipt is delivered through the
existing command protocol; a changed local manifest or host conflict fails
closed rather than applying a draft.

The next backend substrate is checked in at `executor/vm`: an Apple Silicon
macOS 15+ `Virtualization.framework` bootstrap validator. It accepts only
owner-owned, non-link, single-link kernel/initrd/disk files, validates a
bounded CPU/memory allocation and a read-only disk, and intentionally configures
neither a NIC, host filesystem share, graphics device, nor host process bridge.
It is not command-reachable and advertises no new descriptor operation. The
browser/coding slice must add guest COW transport and a forced-egress broker as
one reviewed unit; it may not turn this validator into a host-browser fallback.
Its only guest-control primitive is a fixed virtio socket on the individual VM:
the guest initiates one connection and the host rejects a replacement while it
is live. It is not a host network listener and carries no executable protocol
or descriptor operation on its own.

The companion now also contains the inactive foundation for that egress broker:
an owner-only Unix-socket HTTPS CONNECT gateway whose local policy names exact,
distinct HTTPS origins. It has no TCP listener, generic HTTP forwarding, proxy
mode, browser descriptor, or guest transport. Before it opens one raw tunnel it
uses `@nessie/runtime`'s shared `pinnedConnect` primitive, which validates the
target then dials the vetted literal IP without another DNS lookup. The eventual
VM bridge must pair this gateway with a guest-only interface and enforce the
remaining download/upload and credential rules; this groundwork is not browser
availability.

Executor managers can now inspect the latest bounded COW review receipts on the
executor's Overview tab. That surface decrypts only the server-held result for
the exact `workspace.review` command and renders its manifest digest plus the
relative path, change kind, and byte count—never draft contents or a host path.
It is deliberately manager-only: a management screen must not become a way for
an organization/project member to browse another person's executor run data.
The originating user also has a **Your reviewed drafts** doorway on the
Executors page. That same bounded summary lets them prepare and then explicitly
password-confirm a promotion; managers cannot use the overview review list to
promote another person's draft. Neither surface exposes the planned availability
union with connectors.

The availability endpoint deliberately creates a five-minute, one-use opaque
candidate and returns no machine identifier. The next binding slice consumes
that record under the run/operation lock and rechecks its recorded capability
and authorization revisions; it will not accept an executor selected by a
model, browser, or API caller. Confirming an executor-operation access change
updates the corresponding explicit logical-tool policy first, then the exact
executor grant. If confirmation becomes stale, that ordering can only leave a
logical policy without an executor grant, which remains deny-by-default.

## Decision

Introduce an **executor** as a first-class, paired, capability-bearing endpoint
that performs work on a user-controlled machine or isolated runtime. An executor
is not an agent, MCP catalog entry, Docker provider, or execution environment:

| Term | Meaning |
| --- | --- |
| **Executor** | A durable, paired endpoint with a local policy ceiling and a signed capability descriptor. |
| **Execution environment** | A disposable Docker/GCloud resource launched from an existing template. |
| **Execution runner** | The Nessie worker process that currently provisions Docker/GCloud environments. |
| **Executor session** | A bounded interactive capability owned by an executor, such as a browser sandbox or a Codex/Claude tmux session. |

The first two executor profiles are:

1. **Workspace sandbox** — an isolated local workspace with explicitly granted
   folders, command execution, and a browser profile. The companion is where
   the machine owner selects the folders, read/write level, command policy,
   browser/network policy, and resource limits.
2. **Coding session** — an opt-in, observable and controllable Codex or Claude
   Code session in a dedicated tmux server. It supports remote development
   without granting Nessie an ambient shell or access to unrelated tmux
   sessions.

This extends Nessie's workflow rather than creating a parallel product:
executor operations project into the existing tool registry, while an exact
executor binding is resolved and pinned on the run or session. Existing tool
grants remain one input to authorization; they are not the complete executor
permission model.

### Executor scope is exclusive

Every executor is created in exactly one immutable scope:

| Scope | Audience and use boundary |
| --- | --- |
| **Private** | An explicit, named allow-list of users and agents within one organization. For example, it can be assigned to two users and four agents. It is never discoverable or selectable through organization or project membership alone; only an assigned human user may manage that allow-list. |
| **Project** | Members entitled to one exact Nessie project. It may be selected only for a run whose project is that exact project. |
| **Organization** | Members entitled to the executor's organization. It may be selected for eligible organization work, subject to the normal agent and tool grants. |

There is no team-scoped executor and no generic cross-scope sharing record.
The same daemon may enroll separate executor identities for private, project,
and organization use, each with independent local policy and capabilities; it
must not widen an existing executor's scope. A private executor's named
assignments can be edited only by a private-administrator user, never by an
agent, but moving it between private, project, and organization scope is a new
enrollment, not an in-place update. Team, channel, and run context can further
narrow access, but they never silently select or expand the executor's scope.

Availability is a server-side decision, not a browser or model-side
intersection of lists. For one operation it is true only when the requesting
human may discover the resource, the exact agent has resource-operation access
and the logical tool grant, the immutable run context matches the scope, and
the executor is online/approved with a local policy that permits it. Connector
availability adds usable credential state for the requesting human without
revealing another person's credential status. The shared resolver returns only
safe readiness/reason codes and is called by list, detail, Agent Designer,
selection preview, run launch, dispatch, activity, realtime, and PA tools.

## Why this shape

DeepTest demonstrates the right local-executor boundary: the machine connects
outward, the local app is the source of truth for folder and network grants, and
the browser never needs a publicly reachable port. Its companion keeps the
configuration legible and makes the local ceiling visible before a run starts.

Coder demonstrates the distinct interactive-session boundary: tmux is a session
host, not an authorization mechanism. A secure implementation uses a dedicated
owner-only tmux socket, exact session targeting, a validated executable, typed
events, and separate observe/control permissions. Terminal prose must never be
accepted as proof that a task completed or that an approval was granted.

### Source-adoption and licence gate

No DeepTest or Coder source is copied in the first delivery. We adopt the
design lessons above, not their implementation. Before any later reuse, record
the candidate file, licence/provenance, compatible licence, maintained seam,
and test obligations in a source-adoption matrix reviewed by legal/security.
In particular, DeepTest's pairing/relay code and Coder's platform-specific tmux
code must be evaluated separately; no transitive vendor directory is an
approved source by implication.

Nessie already has useful foundations:

- `ExecutionEnvironment*`, `ExecutionRunner`, and `ExecutionLease` provision
  Docker/GCloud environments, but only from the hosted worker and have no user
  surface.
- The tool registry and grant system can expose executor capabilities without
  expanding every agent's context.
- `@nessie/mcp-manage` is the shared connector/projection seam, while the
  current cloud transport deliberately rejects local or stdio connectors.
- `desktop/` is a minimal Tauri shell and can become the graphical companion;
  it should supervise an executor daemon rather than run privileged execution
  inside the webview.

We will preserve the first foundation as the **managed-environment control
plane**. Executors get their own lifecycle and leases: an executor may launch
or host an environment later, but a user machine is not a `docker` or `gcloud`
runner and cannot be modelled as one.

## Target architecture

```text
Agent run / workflow
        |
  grant + scope + approval check
        |
Tool registry entry (transport = executor)
        |
Executor dispatch service ---- existing queue job + ToolCall + command receipts
        |                                      |
  outbound authenticated control stream         audit: metadata only
        |
Nessie Executor daemon <----> desktop companion (local policy + UI)
        |
   workspace sandbox       dedicated tmux session
  files / command / web      Codex or Claude Code
```

The executor daemon makes only outbound TLS connections. Idle executors use a
signed heartbeat and policy synchronisation; an executor with an attached
interactive session holds an outbound control stream for the life of that
session. Nessie never opens a socket to a laptop, and a catalog endpoint can
never be substituted for a paired executor. Executor is the sole paired
reverse-connection substrate: the unimplemented remote-worker protocol in
`external-tool-integration.md` is superseded, rather than implemented beside
this one. Local MCP proxying becomes an executor capability.

## Product surface: a home and its doorways

The owning surface is **Agents → Executors** at `/agents/executors`. It shows
the decision an owner needs to make: which machines are available, what each is
permitted to do, which agents can use it, whether a coding session currently
has control enabled, and whether local policy has changed.

It is not a stranded configuration page. The initial delivery includes these
doorways:

- Agent Designer's tool-policy section shows compatible executors and links to
  their access configuration. An agent with no granted executor has a direct
  **Connect an executor** action.
- The existing channel task/composer flow gets a deliberate **Run on executor**
  choice only when an executor-enabled agent is invoked. It displays the data
  boundary and selected executor before the run is queued. Workflow test/run
  detail gets the equivalent choice for an executor-requiring step. There is no
  fictional generic launch page.
- A tool-call/activity row links to its executor and, for permitted viewers, to
  the exact executor session. Invocation-only viewers see final sanitized state;
  inspect viewers may see the approved bounded transcript.
- **Executors → Attention** is the owning surface for pending
  `ExecutorApproval`s and coding-session attention. It is reachable from the
  originating run detail, the tool-call/activity row, and the desktop
  companion. An assigned human approver can approve, reject, or recover an
  exact suspended invocation there; an agent can never act on that decision.
  A coding attention state links to the same session detail and its originating
  task, rather than leaving a terminal state stranded in a transcript.
- The desktop companion opens the same executor detail after pairing, with
  local controls for folders, sandbox profile, browser/network access, and
  Codex/Claude session controls.

The list is entitlement-scoped. Private executors appear only to their named
user assignees and private administrators; project executors appear only to
people entitled to their exact project; and organization executors appear only
to people entitled to that organization. An optional project filter narrows the
result only when the caller asks; it must not default to session claims that
happen to be present at login.

## Availability and access-management experience

An executor is a resource; an operation is a logical tool; an agent grant says
which logical tools an agent may invoke. The UI keeps those decisions separate
so that assigning a person access to a machine cannot silently authorize an
agent, and enabling an agent cannot silently reveal every machine.

### Homes and reusable access panel

`/agents/executors` is the executor home. Each executor has **Overview**,
**Access**, **Operations**, **Sessions**, and **Attention** tabs:

- **Overview** answers whether it is available now, its scope, data boundary,
  local policy, descriptor revision, and pause/drain state.
- **Access** is the sole place to manage its scope-specific access and agent
  capability grants. It identifies the human who made each change and shows
  the effective result, not merely an inherited role.
- **Operations** is the per-agent matrix of exact allowed/denied logical
  operations and descriptor-review deltas. A private `use` assignee sees only
  their own effective access, never a roster or another agent's grants.
- **Sessions** owns bounded coding/browser inspection and control-lease state.
- **Attention** owns pending approvals, assignment changes awaiting human
  confirmation, and coding attention states.

Existing connector instances remain owned by **Integrations** (`/integrations`)
and the **MCP Store** (`/mcp/store`); tool registry entries remain owned by
**Tools** (`/tools`). Integrations adds the same parameterized **Access** panel
component used by executor detail. The component receives a resource kind and
the valid scope/management actions, so connectors retain their current
`@nessie/mcp-manage` scope model while executors expose only private, project,
and organization scope. This is one access surface, not a second connector or
executor policy editor.

### How a person finds and enables a capability

Agent Designer's Tools section adds an **Executors & connectors** group. It
lists only logical operations compatible with the selected agent, each with its
source, scope, local data boundary, explicit-grant state, and an explanation
of why it is unavailable. A user with the right to change it can use one of
three exact actions:

1. **Grant to agent** opens the resource Access/Operations panel and creates
   one exact executor-operation grant plus one logical policy-key update through
   the existing locked targeted-policy mutation seam. Executor operations
   always require both explicit grants; inherited/absent is deny.
2. **Connect an executor** begins scoped pairing when no eligible executor
   exists, then returns to the same Access panel after fingerprint confirmation.
3. **Manage connector** deep-links to its existing Integrations instance;
   Nessie does not duplicate connector installation, OAuth, secret, or
   lifecycle controls in Agents.

The channel composer has a **Run on executor** doorway for bound channel
agents. It asks the server for the initiating human's safe, short-lived
availability choices only after the person chooses an agent and read-only
capability, then creates the message, task, run, binding, and queue job in one
transaction. It shows only a scope label and capability—not an executor ID,
label, or private roster—and never exposes a private executor merely because
an agent has an operation grant. It currently offers the companion's concrete
`file.list` and `file.read` backends; write, browser, and coding choices remain
absent until their isolated implementations are reviewed. Tools shows executor entries as
managed `transport: 'executor'` rows that link back to the resource detail; its
generic lifecycle, credential, and registry-mutation paths reject them.

Project Settings gains an **Executors** tab for the exact project: it lists
project-scoped executors, offers **New project executor**, and links to the
shared Access panel. This is the only place a project is selected; it is never
derived from the active session. Organization-scoped executors are created and
managed from `/agents/executors` by organization administrators.

### Scope-specific access rules

| Scope | Access panel control | Eligibility to invoke |
| --- | --- | --- |
| Private | An assigned human `admin` can add/remove named users and agents; agents can only have `use`. The pairing user starts as a human admin. | The initiating user and invoked agent must both be exact `use`/`admin` assignees, plus the operation grant and normal invocation checks. |
| Project | No per-person allow-list. Project administrators manage the executor and grant compatible logical operations to exact project agents. | The initiating user is entitled to the same project, the run declares that exact project, and the agent has its explicit operation grant. |
| Organization | No per-person allow-list. Organization owners/admins manage it and grant compatible logical operations to exact organization agents. | The initiating user has organization entitlement and the agent has its explicit operation grant. |

An agent never receives authority to create an executor, alter scope, alter
private assignments, grant another agent, or approve an operation. It may only
use an operation that a qualifying human has configured and the resolver still
allows for the current run.

### Personal Assistant management is user-mediated

The Personal Assistant exposes executor management through the same shared
authority layer used by web routes; it re-derives the requesting user's rights
from durable records and does not trust model-supplied scope, IDs, or claims.
It can offer these tools:

| PA operation | Result |
| --- | --- |
| `availability_list`, `availability_explain` *(next)* | Will return only executor and connector capabilities visible to the requesting user, optionally for one agent and immutable context, plus safe readiness reasons. |
| `executor_list`, `executor_inspect` | Entitlement-scoped status, capability, scope, and data-boundary summary. |
| `executor_pair` | Opens the user-owned setup surface; the user selects the immutable scope and assignments, and the companion completes the cryptographic pairing. |
| `executor_pause`, `executor_drain`, `executor_revoke` | Creates a reviewed lifecycle-change draft only; the user confirms it in the Executors surface. Revoke always requires fresh verification. |
| `executor_agent_access_prepare` | Produces an exact grant/revoke diff for a selected agent and logical operations. |
| `executor_private_assignment_prepare` | Produces an exact add/remove/change diff for named users and agents, only when the requesting user is a private administrator. |
| `executor_workspace_promotion_prepare` | Prepares only the requesting user's acknowledged COW review for the separate password-confirmed host-promotion control. |

`*_prepare` mutations create an `ExecutorAccessChange` draft containing the
canonical diff digest, actor user, executor/policy revisions, expiry, and a
single-use confirmation token. The PA cannot apply a draft itself. The web or
desktop client renders an explicit confirmation control bound to that token;
the confirmation endpoint re-checks the current human user's entitlement,
revisions, and the exact digest before applying it. When policy requires
step-up—or always for a private-assignment change, access elevation, or
revocation—the confirmation requires a fresh, server-side password re-proof in
the first control-plane slice. An account without a password fails closed until
the platform's SSO/WebAuthn verifier is connected to this continuation contract;
the opaque verification binding remains on the continuation for that upgrade.
No factor code or proof is ever placed in chat or a model prompt. This preserves the rule
that only a user—not the Personal Assistant, an arbitrary shared agent, or
terminal text—may manage user or agent access, while allowing the PA to carry
prepare a confirmed user request. The same confirmation mechanism governs
project/organization agent grants. Every prepared, expired-on-confirmation,
rejected, and applied change is audit logged.

Existing PA `connector_*` operations continue to manage connector lifecycle
through `@nessie/mcp-manage`. Add a safe availability view to `connector_list`
and deep links to the shared Access panel; do not create a second executor-like
connector authority or route pairing keys through the connector secret store.

## Domain and persistence

Add these executor-owned records rather than changing existing environment
records in place:

- `Executor`: immutable `scopeKind` (`private`, `project`, or
  `organization`), one owning `organizationId`, optional exact `projectId` for
  project scope, pairing owner, label, profile set, platform facts, machine
  public-key fingerprint, status
  (`pending_pairing`, `online`, `draining`, `offline`, `revoked`, `error`), and
  last-seen time. A database constraint requires an exact project in the same
  organization for project scope and rejects a project for private or
  organization scope.
- `ExecutorPrivateAssignment`: a private-scope-only, exact assignment to one
  user or one agent in the executor's organization. An agent can hold only
  `use`; a user can hold `use` or `admin`. The pairing user is the initial user
  administrator. It is the only sharing mechanism for a private executor; a
  database uniqueness constraint prevents duplicate principals and a scope
  constraint rejects it for project or organization executors.
- `ExecutorAgentOperationGrant`: exact executor, agent, and stable operation
  key, with allowed/denied state, revision, and audit fields. It is distinct
  from the logical tool grant: an agent must have both, so an allowance for
  `command.run` on executor A cannot authorize executor B. Descriptor-added
  operations begin ungranted. For private scope, this grant does not replace
  the agent's private assignment; it narrows that assignment to operations.
- `ExecutorEnrollment`: single-use, short-lived pairing challenge and its
  terminal receipt. The server stores only a verifier and public-key
  fingerprint; the private machine key remains owner-only on the machine.
- `ExecutorCapabilityRevision`: immutable, signed descriptor snapshots and a
  local-policy digest. A new descriptor cannot expand cloud authority until an
  authorized owner reviews and enables its newly discovered capabilities.
- `ExecutorCommand`: an idempotent, leased tool invocation with a stable
  command ID, expected capability revision, state, retry data, and content-free
  result digest. It is executor-specific protocol metadata on exactly one
  existing `queue_jobs` record and its `ToolCall`, not a second scheduler:
  queue claiming, idempotency, lease renewal, retry exhaustion, run recovery,
  and `needs_setup` remain the established lifecycle. It records only the
  outbound accepted/started/result-acknowledged receipts and maps an uncertain
  acknowledgement into that lifecycle's explicit recovery state.
- `ExecutorSession`: the narrow lifetime record for a browser sandbox or coding
  session, its executor, exact workspace grant, control lease, initiator,
  status, and terminal receipt. It never stores a tmux name as the security
  identifier.
- `ExecutorBinding`: the server-authored run/session pin from one logical
  operation to one eligible executor and capability revision. It is selected
  once under a PostgreSQL transaction-scoped advisory lock derived from the
  run/session and logical operation, gets a monotonically increasing fencing
  token, and is never supplied by the model or browser. Dispatch advances the
  existing queue lease only after rechecking that token under the same lock, so
  a retry cannot select a different executor or revive a revoked binding.
- `ExecutorApproval`: a durable continuation for a write/control operation.
  It binds the canonical argument digest, executor and session, descriptor and
  local-policy revisions, actor, expiry, and fencing token. Any mismatch or
  retry with changed input invalidates it.
- `ExecutorAccessChange`: a durable continuation for a PA-prepared access
  change. It binds the canonical assignment/grant diff, actor user, executor
  and policy revisions, expiry, and one-time confirmation token. It shares the
  same continuation, expiry, digest, receipt, and audit implementation as
  `ExecutorApproval`; only the subject differs.

`ToolCall` remains the canonical user-visible invocation/audit record. It gains
executor and session references plus a retained, redacted manifest of the
approved operation, argument digest, policy revisions, actor, decision, and
result digest. It must not persist raw terminal output, browser DOM, file
contents, or local credentials. `ExecutorCommand` may retain the minimum
encrypted, short-lived delivery payload needed for a retry, then deletes it on
terminal acknowledgement according to a documented retention window.

Add one entitlement resolver with these actions: `discover`, `invoke`,
`inspect`, `control`, `share`, and `revoke`. It intersects executor bindings,
membership, actor context, and explicit tool grants with deny precedence. Lists,
pairing, task launch, dispatch, activity, websocket delivery, and revocation
all call this resolver. The resolver first enforces the executor's immutable
scope: private requires an exact user assignment **and** an exact agent
assignment for the run (or private-admin authority from an assigned **user**
for administration), project requires exact project entitlement and a matching
run project, and organization requires organization entitlement. A private
administrator user manages private assignments; an agent is never authorized
to add, remove, or elevate a user or agent assignment. Organization
owners/admins administer organization executors and, according to
project-administration rules, project executors. No wider membership
substitutes for the required scope entitlement.

Private scope must retain at least one active human administrator while it is
usable; the transaction that removes the final administrator fails. On user
deactivation, organization removal, or agent deletion, the principal-lifecycle
transaction takes the executor lock and rechecks assignments and operation
grants. If an offboarding event leaves no active private administrator, the
executor immediately stops accepting new work, drains and revokes; it is never
silently transferred to an organization administrator. An organization owner
may use a revocation-only break-glass action without seeing the private roster,
session, or data. A private `use` assignee can see only their own effective
access, never other assignees or agents.

The existing `ExecutionEnvironmentTemplate`, `ExecutionEnvironmentInstance`,
`ExecutionRunner`, `ExecutionLease`, and `ExecutionUsageLedger` remain intact.
Later, a workflow environment template may name an executor requirement, but
that is a compatibility link, not a migration of a laptop into the existing
provider enum.

## Capability and tool contract

The companion advertises a versioned, signed descriptor. It contains structural
facts only: profile, platform, supported operation schemas, effective limits,
and a digest of the local policy. Nessie does not infer a capability from a
machine label, installed executable name, or terminal text.

Initial operation families are deliberately narrow and schema-first:

| Profile | Operations | Notes |
| --- | --- | --- |
| Workspace sandbox | `file.list`, `file.read`, `file.write`, `workspace.review`, `command.run`, `browser.open`, `browser.observe`, `browser.act`, `workspace.promote`, `sandbox.stop` | Paths and command argv are validated locally for every call. `workspace.review` is a bounded COW delta only. Browser actions run in the executor's isolated profile; promotion is a separate host-write operation. |
| Coding session | `coding.launch`, `coding.attach`, `coding.observe`, `coding.prompt`, `coding.interrupt`, `coding.close` | `prompt` and `interrupt` are control operations; they are never implicit in observation. |

Each approved **logical operation** becomes one stable, scoped
`ToolRegistryEntry` with a new `transport: 'executor'`; it is not duplicated
for every machine. On task launch, `ExecutorBinding` atomically selects an
eligible executor and exact capability revision, then pins both to the run or
session. Dispatch accepts only that server-authored binding, so callers and
models cannot substitute an executor ID, session ID, capability revision, or
operation name. Descriptor rollover marks an old binding unavailable for new
runs but leaves in-flight work on its pinned revision; grants remain attached to
the logical operation rather than disappearing on a descriptor refresh. This
prevents name collisions, stale projections, and exploding model context while
retaining existing registry search, approval, grant, tool-context loading, and
tool-call lifecycle. Add the executor adapter at the tool-dispatch seam; do not
create a second bespoke agent-tool bus or pretend the reverse connection is a
generic public MCP URL.

An executor operation is available only when both the exact
`ExecutorAgentOperationGrant` and the stable logical tool grant allow it.
Agent Designer, the composer, and the PA call a server-side availability
preview that returns opaque candidate handles plus safe reason codes; neither
the browser nor the model receives a free-form executor ID to select. Run
creation consumes one unexpired candidate handle and creates its binding under
the advisory lock. A capability refresh can never grant a new operation by
default, and generic registry, credential, or lifecycle mutations reject
executor-managed entries.

Local MCP servers can be exposed only as a later executor capability. They will
be projected through `@nessie/mcp-manage` by a managed executor adapter, with
the same approval and grant rules; the adapter reuses its existing projection
and transport-resolution seam rather than creating executor-specific MCP
projection logic. The cloud continues to reject user-authored stdio and
private-network endpoint URLs.

## Authorization, isolation, and privacy

Every command is allowed only when all four checks pass:

1. **Machine hard policy** — set locally in the companion; it is the immutable
   ceiling. It includes approved roots, access modes, cwd, command policy,
   resource/network limits, browser origin policy, and whether interactive
   control is allowed. A cloud policy can narrow this ceiling but never widen
   it.
2. **Executor capability state** — the exact signed descriptor revision is
   current, online, approved, and has not been locally paused or revoked.
3. **Nessie resource and tool policy** — the caller can discover the executor,
   the agent has the projected tool grant, and the executor's immutable scope
   plus channel constraints allow this run.
4. **Live actor context** — the run's immutable user, organization, team,
   channel, agent, and approval/step-up state permit this exact operation.

For a write, command, browser action, or coding control operation, a successful
policy decision creates an `ExecutorApproval` when the effective policy requires
approval. The worker suspends the exact invocation; it never turns approval into
a generic `tool_denied` result. Resumption rechecks the canonical argument
digest, actor, binding, descriptor, local-policy digest, expiry, and fencing
token before one command is leased. A command has `accepted`, `started`, and
`result-acknowledged` receipts, so lost acknowledgements and restarts resolve to
an explicit `unknown_outcome`/operator-recovery state instead of claiming
at-most-once side effects from an idempotency key alone.

Important rules for the companion:

- Pair through a short-lived QR/link challenge and user-confirmed public-key
  fingerprint. Store rotating machine credentials and the private key with
  owner-only permissions. Revocation invalidates new work immediately; draining
  commands receive an explicit cancellation signal and must acknowledge it. Use
  a documented signature algorithm and canonical encoding, a monotonic
  anti-rollback counter, key rotation/recovery, enrollment race handling,
  stale-connection fencing, and authenticated desktop-to-daemon IPC. A signed
  descriptor proves that paired key made the claim; it does not prove a host is
  uncompromised or that another tenant should trust the machine.
- Bind each command to its command ID, capability revision, expiry, run/tool
  provenance, and idempotency key. The executor rejects replay, stale policy,
  mismatched scope, or a command already completed under a different digest.
- Resolve paths on the machine immediately before use, following symlinks and
  checking the granted root/access. Use descriptor-provided paths only as local
  policy facts; the server cannot nominate a new root.
- Commands use an argv schema and a validated working directory, never a
  cloud-supplied shell string. The initial sandbox profile has no ambient home,
  Docker socket, SSH agent, cloud credentials, or inherited secret environment.
  It runs only in the named, concrete fail-closed backend for the initial
  release: a per-session Linux micro-VM created with macOS
  `Virtualization.framework`. The selected workspace reaches the guest as a
  read-only virtiofs mount; the guest has no host shell, Docker socket, SSH
  agent, cloud credentials, or host mounts beyond that root, and uses a
  non-root user, bounded tmpfs/resource limits, and a network namespace with
  no default egress.
- Browser network limits are enforced by the browser/sandbox runtime, not by a
  prompt or an allow-list displayed in the UI. The guest has no direct network
  route or DNS resolver: its sole virtual NIC terminates at the daemon's
  authenticated egress gateway, with no NAT bridge, direct DNS, or UDP/QUIC
  escape. Chromium is configured to use that gateway and host firewall rules
  deny every alternate browser/CLI path. The gateway enforces HTTP(S), CONNECT,
  WebSocket, and redirect-hop policy and uses `@nessie/runtime`
  `safeFetch`/`pinnedFetch` for URL validation and pinned connections; it must
  not reimplement a divergent SSRF policy. It rejects private, link-local,
  loopback, metadata, DNS-rebinding, IPv6-bypass, download, and upload escapes.
  File and browser data sent back to an agent are explicitly bounded and
  visible in the run consent.
- Local credentials resolve locally and are never uploaded. Redaction reduces
  telemetry exposure but is not an information-flow boundary. The consent
  explicitly states whether raw bounded file/browser/terminal data reaches
  Nessie's configured model provider; the server stores only the redacted audit
  manifest and result digest.

Coding sessions add these non-negotiable rules from Coder's model:

- New Codex/Claude sessions run in a dedicated, owner-only tmux server inside
  that per-session micro-VM. The daemon validates the absolute tmux/helper
  executables and uses exact session targets; it does not execute tmux through
  `PATH` or interpolate a session name into a shell command.
- The initial release launches and observes only sessions created in that
  dedicated server. Attaching a pre-existing/default-server tmux session is
  deferred to a separately consented broker design; it is not smuggled through
  the dedicated-server guarantee.
- Observe, create, input, interrupt, and close are separately advertised and
  granted. Control is off by default; enabling automated input requires an
  owner-approved, time-bounded control lease and follows the configured
  per-action approval policy.
- Authenticated lifecycle hooks and process observation may establish an
  outcome. Screen text is untrusted: it can produce a redacted attention state
  but cannot approve, complete, or fail a Nessie workflow by itself.
- The local adapter has fixed Codex/Claude argv shapes, version-gated lifecycle
  adapters, binary/ANSI output bounds, executable inode/ownership/permission
  checks before launch, a single-writer control lease, and an explicit trust
  profile for the CLI home and its credentials. The coding profile is not the
  credential-free workspace-sandbox profile. It never mounts the host
  `~/.codex`, `~/.claude`, keychain, or a global CLI token into the guest.
  Instead a root-owned daemon credential broker holds any renewable credential
  outside the guest workspace identity and the forced egress gateway injects
  only short-lived, executor/session-bound upstream authorization. The CLI and
  workspace processes receive neither a reusable bearer nor a host credential;
  revocation closes the broker session and gateway route immediately.
- A coding session works in its own copy-on-write guest workspace. It may edit
  that scratch copy, but it cannot write the selected host workspace directly;
  the same explicit, reviewed `workspace.promote` operation used by mutating
  sandbox work is the only path back to the host.

`workspace.promote` is a privileged operation, never an implicit side effect
of `file.write`, `command.run`, or a coding session. It requires its own exact
executor-operation and logical-tool grants, local policy, server binding and
fencing, durable approval/receipts, and a visible local or human confirmation
when policy requires it. The guest cannot nominate host paths or apply the
change itself: the daemon reconstructs an exact change manifest from the
copy-on-write workspace, checks its base snapshot for conflict, and rejects
paths outside the granted root, symlinks, hardlinks, device files, sockets, and
other special entries. The daemon applies the validated manifest through a
root directory descriptor with no-follow operations, daemon-owned staging, and
a durable all-or-recover journal; crash recovery either finishes the validated
manifest or restores the base state before another promotion can begin.

### Initial platform contract

The first executable release supports **macOS 15 or later on Apple Silicon**
only, because its sandbox boundary is the `Virtualization.framework` Linux
micro-VM above. Both the workspace and coding profiles run inside that backend;
tmux is not a macOS-host escape hatch. Linux and Windows may not enroll an
executable profile, advertise a workspace/browser/coding capability, or accept
commands in the first release. Windows gets no WSL fallback. A later platform
is supported only after it has an explicitly named equivalent backend, its own
escape/egress test matrix, and a documented tmux availability decision; until
then the product shows it as unsupported rather than silently degrading.

## Companion delivery

Create a dedicated `nessie-executor` daemon rather than embedding privileged
execution in the web admin or Tauri webview. It owns the key, local policy,
outbound connection, sandbox backends, and tmux adapter. The existing `desktop`
Tauri app is the first graphical companion and supervises that daemon; the same
daemon also has CLI/service installation for headless developer machines.

Suggested ownership boundaries:

- `packages/schemas/src/executor.ts`: versioned public descriptor, pairing,
  command, session, and policy schemas shared at process boundaries.
- `packages/executor-manage`: the one shared executor authority for
  entitlement/availability resolution, private-assignment validation,
  operation grants, descriptor review, candidate handles, and PA/web mutation
  preparation. API routes and worker PA tools consume it; neither reimplements
  an access rule. It uses `@nessie/mcp-manage` only for the established tool
  projection seam, leaving connector lifecycle there.
- `api/src/services/executors/*` and `api/src/routes/executors/*`: enrollment,
  access, command leasing, lifecycle, descriptor review, and audit projection
  through the shared authority.
- `worker/src/run/executor/*`: registry-backed executor dispatch and run/tool
  lifecycle integration, with injectable protocol clients.
- `executor/`: the daemon, local policy enforcement, sandbox/browser backends,
  and tmux/Codex/Claude adapters. This is a focused executable workspace, not
  an addition to the developer-only `cli/` package.
- `desktop/`: daemon lifecycle, native folder-selection and local policy UI;
  it never becomes the authority for an executor paired by another machine.
- `admin/src/facades/executors` and focused feature components: the one web
  management/view surface re-used by pairing, Agent Designer, workflows, and
  activity detail.

No file should become a general "execution helper" bucket; protocol, policy,
pairing, command delivery, sandboxing, and tmux control stay separate and
injectable.

## Delivery sequence

### 0. Contract and migration design

This is a hard prerequisite, not a deferred implementation note. In the same
change, write the executor protocol and threat model **and** update
`external-tool-integration.md` to delete/supersede its unimplemented
`McpServerInstance(protocol=remote)` lifecycle in favour of this sole paired
reverse-connection substrate. Define exact ownership/visibility, the action
matrix, retention, content handling, signature/key-rotation protocol, status
transitions, error codes, command replay, result acknowledgement, cancellation,
and how an uncertain command maps into the existing queue/tool-call/run
recovery states. Define the availability resolver, exact
`ExecutorAgentOperationGrant` semantics, private-admin succession/offboarding,
candidate-handle consumption, required `ToolRegistrySource`/transport enum
updates, the forced egress topology, guest credential-broker boundary,
`workspace.promote` manifest/commit protocol, and the step-up action policy.
Add contract tests before an executor schema migration, companion pairing, or
UI implementation can land.

### 1. Pairing and visible control plane

Deliver a reachable, no-execution slice:

1. An owner chooses private, project, or organization scope and creates that
   executor from `/agents/executors`. Private scope explicitly selects its user
   and agent assignees (and any private administrators); project selection is
   an explicit choice and is never inferred from the active session.
2. The desktop companion (or headless daemon) consumes the pairing challenge;
   the owner confirms the machine fingerprint and selects a strict initial
   policy locally. Local configuration produces a signed revision proposal
   only; it cannot activate a new operation.
3. The daemon reports a signed descriptor and heartbeats. The owner can inspect
   its policy, pause/drain/revoke it, and see its data boundary from the web
   home and companion. A local policy revision remains pending until an
   entitled person prepares and confirms descriptor activation; activation
   requires fresh verification.
4. Pairing replay, descriptor rollback, competing active connections, offline,
   drain, and revoke all
   produce deterministic status and audit receipts.
5. Ship the empty-state and contract-backed **Executors → Attention** surface,
   including direct links from a synthetic suspended tool call and the
   companion. It is a hard prerequisite for a later mutation or
   `coding.prompt`; no approval continuation can first appear without a home
   and doorway.
6. Ship the read-only **Access** and **Operations** tabs plus the shared
   availability-explain API. They show exact effective user/agent operation
   access and safe unavailability reasons, but do not execute work yet.
7. Ship PA `availability_*`, inspection, pairing, and prepared-access-change
   flows with web/desktop user confirmation and required verification. The PA
   never gains a direct assignment or operation-grant mutation.

The initial UI needs both the web home and the companion controls; a working
API or daemon without either is not a completed slice.

### 2. Read-only workspace sandbox

Ship one concrete supported backend, or advertise no workspace operations on
that platform. The initial companion grants one explicit, canonical read-only
workspace root; file list/read reject traversal and symbolic links, use only
relative paths, and have bounded output. It is deliberately not described as a
micro-VM: the isolated COW sandbox is a prerequisite for any write, command,
browser, or coding operation. Add the channel task/composer doorway, binding
selection/pinning, registry projection, bounded result handling, and an
inspect-safe activity receipt. Agent Designer's exact executor-operation grants
and their PA prepare/confirmed-apply counterpart must be live before the
composer can present a candidate.

### 3. Browser observe and workflow binding

Add browser open/observe only through the enforced egress proxy. Add project or
worktree selection and executor requirements to workflow test/run detail. A
workflow resolves and pins an eligible executor once at launch and records that
choice on its run rather than re-selecting after a retry. Keep the existing
Docker/GCloud environment flow intact.

### 4. Mutating sandbox operations

Add file write, argv-command, and browser-act only after `ExecutorApproval`,
fencing, acknowledgement/recovery, and revocation-mid-call semantics pass.
Use a copy-on-write/scratch workspace for the first mutating profile so a
successful sandbox command cannot silently alter the selected host workspace.
Promoting an explicit change back to the host is the separate,
approval-gated `workspace.promote` operation, performed only by the daemon
from a validated, conflict-checked manifest.
This slice is blocked until the Attention surface has passed its run-detail,
activity-row, and companion doorway tests.

The native preflight helper may land before that promotion slice because it is
strictly non-mutating: it verifies the exact root/draft descriptor-relative
manifest and current conflict state, but cannot expose `workspace.promote` or
modify a host entry. The apply helper, approval continuation, journal/recovery,
and all UI doorways remain one delivery unit.

### 5. Coding-session executor

Add the dedicated tmux backend, Codex and Claude launch adapters, observe-only
sessions launched by the executor, and session-local authenticated hooks. Ship
the session list/detail through the same Executors surface with read-only/control
state, a visible control-lease timer, terminal attention states, stop/detach
actions, and links back to the originating Nessie task.

Only after observe/control, replay, reconnect, and revocation tests pass may
an agent receive `coding.prompt`. The implementation must not modify a user's
global Codex or Claude configuration; injected hooks/settings are session-local
and fail open to observation only.

### 6. Expansion and hardening

Add platform-specific sandbox backends, local MCP proxy capability, service
installers for macOS/Linux/Windows, encrypted local transcript cache with a
user-configured retention policy, policy previews, and capacity/budget
scheduling. Consider hosted ephemeral executors only as a separate profile
with its own isolation and commercial review.

## Verification gates

Each slice must prove all of the following:

- a user without entitlement cannot discover, select, or inspect an executor;
  a private run requires both the exact assigned user and exact assigned agent,
  and cannot leak to other users or agents; project scope cannot run outside
  its exact project; organization scope cannot cross organizations; and an
  explicit scope filter never grants access;
- every executor operation requires both its exact
  `ExecutorAgentOperationGrant` and its logical tool grant; a new descriptor
  operation is ungranted, a resource grant cannot spill to another executor,
  and candidate handles cannot be forged, reused, or widened by model input;
- private use assignees cannot read a roster, the final active human private
  administrator cannot be removed, offboarding drains/revokes instead of
  transferring private access, and break-glass revocation cannot inspect data;
- cloud grants cannot bypass a locally denied path, command, browser origin,
  read-only root, interactive-control setting, or resource ceiling;
- pairing, command replay, policy revision mismatch, network loss, reconnect,
  draining, revocation, and cancellation have deterministic, idempotent
  outcomes;
- executor dispatch has exactly one queue-job and one `ToolCall` lifecycle per
  operation; an `ExecutorCommand` cannot create a second lease, retry loop, or
  terminal state, and uncertain acknowledgement follows the existing
  `needs_setup`/recovery path;
- pairing replay/cross-organization races, descriptor rollback, dual active
  connections, daemon/server restarts, disconnect before and after command
  acknowledgement, and revocation mid-call fail closed or enter explicit
  operator recovery;
- sandbox tests cover symlink, hardlink, mount, child-process, DNS, private
  network, redirect, download/upload, WebSocket, and file-to-web exfiltration
  attempts; guest DNS, direct TCP, UDP/QUIC, CONNECT, and proxy-bypass attempts
  cannot evade the forced egress gateway; unsupported platforms advertise no
  stronger operation than they enforce;
- no workspace or coding process can read a host CLI home, keychain, global
  token, or reusable bearer; broker/gateway credential revocation cuts off a
  live session without exposing credential material in guest, model, audit, or
  log data;
- `workspace.promote` alone can modify a host workspace and requires its own
  grants, approval, local policy, binding, and receipts; hostile COW manifests,
  base-snapshot conflicts, symlink/hardlink/special-file paths, interrupted
  commits, and revocation during promotion cannot produce an unreviewed host
  write or leave an unrecoverable partial change;
- approval replay with changed arguments or policy fails, and a retained
  redacted approval manifest proves what was approved without storing raw data;
- every pending approval and coding attention state is actionable from its
  Executors Attention home and reachable from run detail, activity, and the
  companion; an agent cannot approve, reject, or alter private assignments;
- PA access changes require a current user-bound structural confirmation and
  the configured step-up challenge where required; an expired/replayed/stale
  diff, a shared-channel PA run, or a scheduled/child agent cannot apply it;
- a coding action cannot target a prefix-matched/wrong tmux session, and
  terminal text, hostile ANSI, or binary output cannot manufacture a success,
  failure, or approval;
- commands and tool calls retain stable provenance without retaining raw local
  files, terminal output, browser DOM, or credentials; raw content is absent
  from database records, audit, logs, realtime telemetry, and error reports;
- the web management page, Agent Designer doorway, run/workflow selector, and
  companion each work in a real Playwright browser/desktop verification flow;
- Codex and Claude launch paths are tested against declared supported versions
  and the source-adoption/licence matrix is complete before any external code is
  reused;
- existing Docker/GCloud environment provisioning and current MCP HTTP/SSE
  security tests continue to pass unchanged.

## Explicit non-goals for the first release

- turning every connected laptop into a generic remote shell or SSH proxy;
- connecting to arbitrary pre-existing tmux sessions; a separately consented
  broker is a later design, not an initial-release shortcut;
- cloud-side stdio execution, private-network URL probing, or user-authored
  connector process spawning;
- silently transmitting a developer's source tree, terminal history, browser
  profile, home directory, Docker socket, or local credentials;
- replacing the current execution-environment provider/runner system.
