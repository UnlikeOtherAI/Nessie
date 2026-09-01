# Executor Integration Plan — Delivery and Verification

Companion chapter for the [executor integration plan](../2026-08-11-executor-integration.md).

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
updates, the forced egress topology, guest-private auth-file boundary,
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
   drain, and revoke all produce deterministic status and audit receipts.
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

Add the dedicated tmux backend, the initial Codex launch adapter, observe-only
sessions launched by the executor, and session-local authenticated hooks. Ship
the session list/detail through the same Executors surface with read-only state,
terminal attention states, stop actions, and links back to the originating
Nessie task. A Claude adapter and any interactive control lease are separate,
later delivery slices.

Only after observe/control, replay, reconnect, and revocation tests pass may
an agent receive `coding.prompt`. The implementation must not modify a user's
global Codex or Claude configuration; injected hooks/settings are session-local
and fail open to observation only.

Progress: the coded slice exposes the exact
`coding.launch`, `coding.observe`, `workspace.review`, and `sandbox.stop`
bundle on a fresh, otherwise unbound run. The guest proves the dedicated-server
mechanics privately: it
creates a root-configured, guest-owned socket directory before privilege drop;
uses the manifest-pinned tmux and Codex argv directly; accepts only a fixed
session/pane target; retains exited panes; and bounds/sanitizes observation.
Codex has an additional launch-time conformance gate: a
workspace-write child and a nested Codex sandbox that asks for
danger-full-access must both fail to read the private future auth home or the
executor-control directory, connect to tmux's Unix control socket, or reach the
known-live guest-local egress proxy.
This is the required credential-principal
boundary; same-UID modes and an inherited proof are not. A local
`configure-codex` command validates an owner-private Codex auth source and the
pinned guest artifacts; the source path alone is stored in owner-only companion
state. A session copies it only into a root-only transient initrd, transfers it
to the guest's private auth home before privilege drop, and removes the initrd
leaf. The descriptor, daemon, agent grants, Executors surface, and Personal
Assistant user-confirmed management are wired through that exact bundle. No
terminal capture, interactive prompt/control, or Claude launch is exposed.

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
  token, or reusable bearer; VM, private auth-home, initrd, and gateway teardown
  cuts off a live session without exposing credential material in model, audit,
  or log data;
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
- the Codex launch path is tested against its declared supported versions, and
  a Claude path requires its own equivalent test and source-adoption/licence
  matrix before it is exposed;
- existing Docker/GCloud environment provisioning and current MCP HTTP/SSE
  security tests continue to pass unchanged.

## Explicit non-goals for the first release

- turning every connected laptop into a generic remote shell or SSH proxy;
- connecting to arbitrary pre-existing tmux sessions; a separately consented
  local-attachment design is a later design, not an initial-release shortcut;
- cloud-side stdio execution, private-network URL probing, or user-authored
  connector process spawning;
- silently transmitting a developer's source tree, terminal history, browser
  profile, home directory, Docker socket, or local credentials;
- replacing the current execution-environment provider/runner system.
