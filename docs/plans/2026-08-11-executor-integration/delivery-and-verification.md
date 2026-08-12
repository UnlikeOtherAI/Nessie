# Executor Integration Plan — Delivery and Verification

Companion chapter for the [executor integration plan](../2026-08-11-executor-integration.md).

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
