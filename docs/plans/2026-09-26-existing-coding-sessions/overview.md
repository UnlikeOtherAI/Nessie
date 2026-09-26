# Interact with existing Codex and Claude sessions

Status: researched implementation plan; no production feature implemented.
Research date: 2026-09-26. Nessie base: `abd544dbd99ede1d9615fc782e1cc52e1fb552d1`.

## Outcome

From a Nessie conversation, the machine's pairing owner can ask their agent
to find an existing coding session, inspect a bounded overview and send it
an instruction. The instruction must reach that exact conversation, including
a conversation the person opened themselves. Support macOS, native Windows
and Linux. Provider desktop, terminal and IDE clients are separate compatibility
cases; an SDK or terminal success does not establish desktop support.

The [provider findings](provider-findings.md) distinguish observations from
unverified behaviour. The central acceptance test remains unproven: discovery
works in several cases, but external delivery to an already-open desktop
conversation has not been demonstrated. Complete phase 0 before choosing the
production attachment transport. Do not declare the requested feature complete
by shipping inspection alone or only sessions Nessie starts.

## Keep from the supplied brief

- Discover independently of launch; keep stable provider identity and honest
  per-session capabilities.
- Make **Queue** the default. **Steer** and **Interrupt** are separate actions
  with separate local grants.
- Reuse executor pairing, command dispatch, WebSocket connection, audit,
  disclosure rules and the existing Sessions surface.
- Keep provider mechanics inside executor adapters. Report unsupported actions
  with a reason; never substitute a new/resumed process for live attachment.
- Prefer native events; bound metadata reads and recent context. No background
  model is needed to watch sessions.

Use Nessie's existing list/status/send/interrupt vocabulary instead of adding
eight overlapping public verbs. No new message board, scheduler, agent
hierarchy, repository sync, merge engine or terminal emulator is needed.
Keep full message bodies in restricted conversation/delivery storage, rather
than copying them into general audit logs.

## Existing code and the required seam

| Reuse | Change required |
| --- | --- |
| `executor/src/coding-session/bridge.ts`, `bridge-server.ts`, `bridge-tools.ts` | Extend the existing bridge with external inventory, attachment references and action dispatch. Refactor its responsibilities before adding more branches; `bridge.ts` is already large. |
| `codex-driver.ts`, `claude-driver.ts`, `host.ts` | These own launched processes. Keep that lifecycle for managed sessions; externally attached sessions must never enter its spawn/kill/restart paths. |
| `coding-sessions-daemon.ts` | Reuse owner stamping and transport. Distinguish detaching an external session from closing a managed one in every teardown path. |
| `packages/schemas/src/executor-coding-sessions.ts` | Add domain-owned contracts for external sessions and action outcomes, with bounded strict schemas; avoid another central barrel. |
| `packages/executor-manage/src/executor-coding-session-owner.ts` | Preserve private-executor/pairing-owner checks at command creation and collection; add session/action grants without widening authority. |
| `worker/src/run/coding-session-tools.ts`, `executor-coding-sessions.ts`, `executor-command-dispatch.ts` | Extend first-class coding tools, action descriptions and disclosure stamping. Keep the generic MCP bypass closed. |
| `ExecutorLocalMcpPanel` → `ExecutorCodingSessions` | One Sessions list and detail, including managed and external rows with accurate ownership and actions. |
| Local executor console and CLI | The machine owner discovers sessions and grants/revokes access locally. Linux gets the same policy through CLI commands. |

### Lifecycle invariant

An external attachment grants permission to communicate; it does not transfer
ownership of the process. Executor shutdown, unpairing, lease expiry, policy
revocation, config change, ticket reassignment and lost connectivity must stop
new dispatch and detach. They must not kill, restart, close or archive a
human-owned session. Existing managed-session teardown remains intact.

Do not implement external sessions by fabricating managed `meta.json` records
or handing a foreign PID to `host.ts`. Use a discriminated origin and a
separate adapter lifecycle behind the same bridge. Explicit native interruption
of the current turn is the only MVP stop operation for an external session.

## Provider decisions

### Codex

Use the owning app-server's native thread ID and control connection where
available. The installed protocol exposes listing, metadata reads, steer,
interrupt and experimental `thread/queue/*` methods. Prefer a verified native
queue over an executor completion-event/`turn/start` workaround.

A fresh app-server can see saved threads without owning their running turns.
Do not use its `notLoaded` response as proof that a conversation is inactive.
Do not resume an externally active thread in a second runtime. Probe the
actual CLI and desktop binaries separately; they differ on these machines.

Never implement queue as “read idle; call turn/start”: a human can start a
turn between those operations, and the installed start contract includes
steering behaviour. Require native queue semantics or a provider-proven atomic
idle precondition. Otherwise advertise queue as unavailable.

If the desktop's owning runtime has no supported external connection, record
that precise blocker and seek a documented provider integration. Private app
IPC, writing Codex's database or rollout files, and simulated keystrokes are
not the production adapter. The task's in-app Codex tools are not an API the
standalone Nessie executor can assume it possesses.

### Claude Code

Use `claude agents --json` for active inventory where supported. It returned
native IDs and busy/idle state for desktop-hosted processes on macOS and
Windows. An empty Linux result only proves an empty query succeeded.

For enrolled sessions, investigate a small executor channel implemented over
Claude's native MCP stdio transport. The channel connects to the local executor
using owner-protected IPC; the existing executor connection carries remote
commands. Enrolment must bind the native session ID, OS user, provider profile
and runtime incarnation using trusted provider lifecycle metadata, never a
model-supplied session ID or just a PID. Prove this binding in phase 0.

Channel notification delivery is distinct from a normal user turn. The docs
describe batching events received while busy, and provide no delivery
acknowledgement. Expose it as **Push event**, with its actual guarantees;
do not relabel it Queue or Steer. No steer/interrupt capability is granted by
the channel contract alone. Omit permission-relay capability from this adapter.

An existing session that never opted into the channel is discoverable but not
therefore controllable. Test whether supported in-session enrolment is possible
in terminal and desktop clients separately. If enrolment requires stopping and
resuming, disclose that limitation: it does not pass live attachment acceptance.
Custom-channel distribution/allowlisting is a release requirement; the
development preview flag is a test tool, not silent production setup.

## Identity, policy and delivery

### Session reference

Return an executor-generated opaque handle backed by provider, configured
provider-profile identity, native session ID and runtime/endpoint identity.
Namespace by executor and OS account; do not accept an arbitrary endpoint or
path from the model. Reuse the handle after restart only when native continuity
is proven; grants to control a runtime are revalidated for its new incarnation.
Never select by title, list position, repository name or PID alone. Two windows
with the same title/root must remain distinguishable.

Separate fields describe:

- Origin: managed or external.
- Runtime: active/idle/waiting/failed/interrupted/unknown, with observation time
  and source; unknown is not idle.
- Availability: reachable, unavailable, or a persisted record whose live state
  is unknown; only label it inactive when the provider proves that.
- Capabilities: provider support, local grant, currently usable, and refusal
  reason for inspect, queue, push, steer, interrupt and native events.

Overview includes bounded title, configured root alias, native client/runtime
identity, observed turn ID/time, pending permission category and Nessie delivery
state. Git branch/commit describe a timed filesystem observation, not guaranteed
turn metadata. Recent text is opt-in, capped and subject to the same disclosure
rules as all executor output. Never upload full transcript history by default.

### Local authority

Discovery is available to the local machine owner. External sessions remain
hidden from remote agents until the owner grants visibility to a named paired
connection and agent. Inspect, queue, push, steer and interrupt are independent
permissions. No inheritance from an existing broad coding-launch grant, and no
automatic grant to all future sessions. Attachments do not make ordinary local
machine command rules a sandbox for the coding agent.

Effective authority is the intersection of the server's current binding and
entitlement, the local per-session grant, the provider's support and live
identity. Check at admission and again immediately before dispatch. Bind the
request to actor, agent, executor, session, operation, policy revision, expiry
and command ID. The model cannot supply the reserved owner context. Revocation
cancels locally pending work and attempts cancellation of native queued entries
where supported; already consumed input cannot be recalled. Show that outcome.

Inspect results, titles, paths, audit details and events remain owner-private
unless the existing disclosure mechanism explicitly permits the recipient.
Every read that reaches a run feeds `ConsumedSourceSink`. A machine-management
role alone must not expose a person's external session metadata. Keep UOA as
identity/membership authority; add no duplicated user profiles or memberships.

### Reliable outcomes

Persist an owner-private delivery journal outside the checkout, using existing
state-directory permissions (POSIX modes / Windows DACL). Reuse executor command
IDs for idempotency, plus a stable provider message ID where supported. Store
the action, trusted actor reference, session/incarnation, policy revision,
timestamps and provider acknowledgement. Attribute visible input to Nessie and
the sending agent. Never disguise it as the human's own message.

Represent accepted locally, queued natively, written to transport, confirmed
consumed, failed, cancelled, expired and outcome unknown distinctly. A socket
write is not confirmed delivery. After an ambiguous disconnect, reconcile the
native message ID; if impossible, leave outcome unknown and do not blindly
resend. Do not promise exactly-once processing without provider evidence.
For Claude, an optional authenticated reply tool can confirm a particular event;
it is not an additional model watcher or a guarantee every event gets a reply.

Use per-session ordered dispatch, bounded queue length/payload/retention, and a
local generation fence to prevent two paired executor connections from driving
the same native session concurrently. Pin steer and interrupt to an observed
turn ID; a completed turn cannot cause the operation to affect its successor.
Provider methods without that guarantee remain unavailable until an equivalent
native precondition is proven.

Keep native event subscriptions in the long-lived executor adapter host, not
the short-lived MCP bridge. Reconnect using bounded metadata reconciliation;
ignore old-incarnation events. Extend typed messages on the existing executor
WebSocket only where its present command/result/heartbeat messages are
insufficient. Slow consumers get coalesced metadata and a resync marker, never
unbounded transcripts. Metadata polling is acceptable for a provider with no
event stream; do not poll with model calls.

## Home and doorways

- **Home:** Agents → Executors → selected machine → existing Sessions surface.
  Show provider/client, title/root, observed state, access and last observation.
  The detail owns overview, message composer, delivery status and audit.
- **Conversation doorway:** the existing executor selector and session result
  link open that same scoped detail; do not introduce a second session view.
- **Local control doorway:** the menu bar/tray team's Permissions page exposes
  discovery, session selection and action grants. Linux has equivalent CLI
  list/grant/revoke/status commands, with exact IDs and JSON output.
- Default composer action is Queue only when supported and granted. A
  Claude-only Push event is labelled and selected explicitly. Steer and
  Interrupt remain distinct actions; unavailable controls explain the reason.
  Disconnect revokes attachment, and never means kill the coding process.
- Use the navigation framework, shared dialog/composer/tab primitives, theme
  tokens and existing owner-private session access patterns. No new dashboard.

## Delivery sequence and gates

### 0. Prove attachment before production implementation

Create disposable test conversations manually outside Nessie, in isolated
worktrees, on all three machines. Record provider/client versions and exact
IDs. Do not inject into unrelated live work. Resolve the owning endpoint,
Claude native-ID enrolment and provider release-channel restrictions.

For every proposed supported client: discover two simultaneous sessions with
the same title/root; inspect their live state; submit to one; prove the other
unchanged and the original conversation/process retained. Test idle input,
busy delivery, visible attribution/history and response observation. Where
advertised, test queue without steering, active-turn steer, interruption and
subsequent reuse, lifecycle events, permission wait, reconnect and restart.
For Channels send at least 50 uniquely identified events to one long-lived
session, including a busy burst, and account for all outcomes without restart
or replacement. Verify terminal, IDE and desktop independently, including
Linux desktop if offered by the tested provider version.

**Exit:** a compatibility matrix with PASS/FAIL/BLOCKED/NOT TESTED and evidence
for each advertised operation. The user's macOS/Windows/Linux exact-existing-
conversation requirement is a release gate. If supported APIs cannot meet it,
report the provider limitation and the required upstream capability before
building a narrower substitute. An API declaration is not a PASS.

### 1. Add the executor attachment boundary

Implement origin/identity/capability contracts, local policy, inventory,
adapter lifecycle, delivery journal and typed outcomes. Refactor the bridge's
managed dispatch boundary without changing managed process ownership. Add
fake-provider tests for wrong session, stale incarnation, duplicate command,
two-connection races, reconnect, revoked grant, queue bounds, and all teardown
reasons leaving the external process alive. Test POSIX and Windows ACL/IPC
behaviour on their native hosts.

### 2. Connect verified provider adapters

Implement only phase-0-proven operations. Pin and probe compatibility; fail
closed on unsupported versions/protocols, provider profile changes and absent
listeners. Native queue is preferred for Codex. Claude's event push keeps its
separate semantics. Re-run the real provider tests on all three hosts.

### 3. Ship authority and usable surfaces together

Extend the existing command services, first-class worker tools, API views,
local permissions console/CLI and Sessions UI. Cover all reads with disclosure
stamps and redact audit summaries. Update protocol, local-controls, agent-tool
and testing docs; update AGENTS/CLAUDE signposts for changed MCP contracts.
Do not ship a server capability without these doorways.

### 4. Verify and review before release

- Unit/contract tests: lifecycle split; local and server policy intersections;
  action semantics; stale-turn rejection; unknown-delivery handling; metadata
  privacy; injection cannot change actor, endpoint, cwd or permission mode.
- Database tests: revoked/expired binding at dispatch, cross-user/agent/tenant
  denial, audit and delivery transitions. Run through Turbo with dedicated
  `DATABASE_URL`; follow worker-before-API ordering or isolated databases.
- Headless Playwright: discover → grant locally → open from chat → inspect →
  Queue/Push → see outcome; separate Steer/Interrupt; revoke while queued;
  stale/offline/unsupported states; Back/forward, reload and narrow viewport.
  Capture and inspect screenshots of every changed surface.
- Native hosts: macOS, Minis Windows and Ubuntu run the same revision through
  Git in dedicated worktrees. Test native Windows, including paths with spaces
  and named-pipe/DACL or provider-selected transport; WSL is separate coverage.
  Follow build/signing standards before release builds and install on each
  named platform. Report CLI, packaged executor and actual provider-client
  evidence separately.
- Kimix reviews implementation against this brief, security/architecture,
  delivery semantics, privacy and recorded rendered flows. Resolve findings
  before the single final feature PR. Required green checks precede merge;
  production promotion and native installation get explicit separate status.

The present change publishes planning and research only. It must not be
reported as installed, implemented, cross-platform delivery-tested or ready
to control existing desktop conversations.
