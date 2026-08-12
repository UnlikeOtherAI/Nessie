# Executor Protocol and Threat Model

**Status:** Phase 1 pairing control plane in progress

This is the implementation contract for paired Nessie executors. It implements
the approved [executor integration plan](plans/2026-08-11-executor-integration.md)
and is the authoritative replacement for the former remote-MCP-worker design.
No executor schema, endpoint, companion, or UI may ship while contradicting
this document.

## 1. Scope and non-goals

An executor is a paired, capability-bearing endpoint that runs a constrained
workspace sandbox or a managed coding session on a user-controlled machine. It
is neither an MCP server instance nor an existing Docker/GCloud execution
environment.

The first executable release supports macOS 15+ on Apple Silicon only. It uses
a per-session Linux micro-VM created by `Virtualization.framework`; unsupported
hosts advertise no executable capability. It does not provide SSH, an ambient
remote shell, an attachment to an existing tmux server, cloud-side stdio, or an
arbitrary local-network proxy.

## 2. Trust boundaries

| Principal | Can do | Cannot do |
| --- | --- | --- |
| Human user | Pair an executor and manage it when entitled; confirm access or invocation changes. | Expand a locally denied policy or act without current entitlement. |
| Agent, including Personal Assistant | Invoke an already available operation; prepare a proposed access change for its requesting user. | Administer access, approve itself, select a free-form executor, alter local policy, or apply a prepared change. |
| Nessie control plane | Resolve availability, bind a run, lease commands, retain redacted audit facts, and send policy narrowing. | Dial a machine, widen local policy, access host credentials, or treat terminal text as an authorization/outcome. |
| Executor daemon | Enforce local policy, pair outward, run the VM/gateway/broker, and acknowledge commands. | Expand scope, accept stale/replayed work, expose host workspace/credentials directly, or send raw local data to audit. |
| Guest VM / coding CLI | Work in a COW sandbox through the gateway. | Reach host files/credentials, direct network/DNS, or promote a host change. |

A descriptor signed by an executor key proves that paired key made the claim;
it does not prove the host is uncompromised. That limitation is deliberate and
must be visible in the UI.

## 3. Scope, availability, and authority

Every executor has exactly one immutable scope:

| Scope | Invocation rule | Human access management |
| --- | --- | --- |
| `private` | Requesting user and exact invoked agent are both named assignees; both required. | An assigned human `admin` only. Agents have `use` only. |
| `project` | Requesting user is entitled to the exact project and the immutable run project matches it. | Project administrators. |
| `organization` | Requesting user has organization entitlement. | Organization owner/admin. |

An `ExecutorPrivateAssignment` is valid only for `private`. A user has `use`
or `admin`; an agent has `use` only. At least one active human private admin is
required while the executor is usable. Direct removal of the final admin fails.
If an offboarding transaction leaves none, the executor stops new work, drains,
and revokes. An organization owner can perform revocation-only break-glass
without seeing private roster, sessions, or content; private access is never
silently transferred.

`ExecutorAgentOperationGrant(executorId, agentId, operationKey)` controls one
exact executor operation. It is required in addition to the stable logical
tool grant. New descriptor operations start denied. This prevents an allowance
for one executor from authorizing another and prevents a capability refresh from
silently granting new power.

The one resolver used by API, worker, UI, realtime, and PA evaluates:

```text
available(operation, human, agent, immutableRunContext) =
  human may discover executor
  ∩ exact executor-agent-operation grant allows operation
  ∩ stable logical tool grant allows operation
  ∩ scope matches immutable run context
  ∩ executor is online and descriptor is approved
  ∩ local policy permits operation
```

Connector availability follows its existing `@nessie/mcp-manage` authority and
adds usable credential state only for the requesting user. The resolver returns
safe reason codes, never another user's private executor roster or credential
state. Clients and models receive opaque candidate handles, not a selectable
executor ID. Consuming a handle creates the binding transactionally.

## 4. Pairing and machine identity

### 4.1 Cryptographic choices

- Executor signing keys are Ed25519 key pairs generated on the machine and
  stored in OS-protected owner-only storage.
- All signed payloads use RFC 8785 JSON Canonicalization Scheme bytes prefixed
  with an ASCII domain separator, for example
  `nessie.executor.descriptor.v1\n`.
- The server holds only the public key, fingerprint, enrollment verifier, and
  short-lived certificate metadata. It never stores the private machine key.
- All transport uses TLS 1.3. Phase 1 claim and heartbeat requests prove
  possession of the Ed25519 key over a short-lived server challenge or exact
  connection epoch. The server certificate is validated through the normal
  public PKI chain; a client must not accept a self-signed Nessie endpoint.
  Client certificates are required before command dispatch is enabled.

### 4.2 Enrollment

1. An entitled human creates an executor with immutable scope. For private
   scope, the user and agent assignments are explicit in the same transaction.
2. The server creates `ExecutorEnrollment` with a 256-bit random challenge,
   stores only its SHA-256 verifier, and expires it in ten minutes. Its single
   use is linearized under an enrollment advisory lock.
3. The daemon generates its signing key, displays its fingerprint and proposed
   local policy, then submits `{ enrollmentId, challenge, publicKey,
   descriptorDigest, proof }`. `proof` signs the canonical enrollment object
   with `nessie.executor.enrollment.v1` domain separation.
4. The server consumes the verifier once, records the pending key/fingerprint,
   and presents the exact fingerprint and data boundary to the human.
5. The human confirms in web or companion UI. The executor remains offline
   until its daemon proves possession of the paired key; pairing may never
   complete from chat text or a terminal transcript.

Enrollment fails closed with `ENROLLMENT_EXPIRED`, `ENROLLMENT_USED`,
`ENROLLMENT_PROOF_INVALID`, `FINGERPRINT_NOT_CONFIRMED`, or
`SCOPE_ENTITLEMENT_DENIED`.

### 4.3 Phase 1 daemon presence

The daemon obtains a rate-limited, one-minute, HMAC-authenticated server
challenge for its executor ID, then signs that opaque value using
`nessie.executor.daemon.claim.v1`. The server persists only the challenge's
SHA-256 digest and atomically consumes it with the successful claim, so a
captured challenge cannot reconnect or advance a fence twice. A successful
claim advances the durable connection epoch under the executor advisory lock
and fences prior daemons.
Every heartbeat signs its executor ID, epoch, and timestamp under
`nessie.executor.daemon.heartbeat.v1`; timestamps outside one minute are
rejected and a stale epoch cannot update liveness. Replaying an old heartbeat
therefore cannot extend its last-seen time. This channel reports availability
only: it cannot lease or execute a command.

While it owns the current connection epoch, a daemon may submit a higher
descriptor revision. The descriptor's own `nessie.executor.descriptor.v1`
signature is verified against the paired raw Ed25519 key. Reusing a revision
with different policy facts or sending an older revision fails closed; a newer
revision is stored as `pending_review`, never immediately activated. This lets
a human see and approve a narrowed or expanded local policy before it affects
availability.

### 4.4 Rotation and recovery

A key rotation is a two-proof transaction: the old key signs a canonical
rotation request containing the new key and a fresh connection epoch; the new
key signs the same request. The server invalidates prior client certificates
only after both proofs and any policy-required human confirmation succeed. A
machine that lost its key cannot recover by claiming the executor record: it is
revoked and re-enrolled as a new executor. Certificate renewal requires a live
proof from the current key and may not bypass revocation.

## 5. Outbound control connection and descriptors

The daemon makes outbound HTTPS/WSS connections only. Nessie never calls into a
laptop or uses a catalog endpoint as a machine transport.

Before binding a run, Nessie resolves each logical operation into an opaque,
short-lived availability candidate. The database keeps only a SHA-256 digest of
the handle with the selected executor, reviewed capability revision, requester,
agent, scope context, authorization revision, expiry, and eventual consumption
receipt. Candidate responses never contain an executor ID. A later binding
must consume exactly one unexpired digest and revalidate every recorded gate;
the candidate is not an authorization cache or a caller-selectable machine.

The initial `nessie-executor` CLI requires an explicit HTTPS API origin and an
owner-only local state directory. It generates and stores the machine key
locally, submits the signed enrollment proof, and after the human confirms the
fingerprint, claims a connection and sends heartbeats. Its initial companion
profile is deliberately limited to daemon-owned COW workspace operations:
`file.list`, `file.read`, `file.write`, `workspace.review`, and
`sandbox.stop`. It refuses shell, browser, coding, host-promotion, and every
unimplemented operation.

`nessie-executor configure --operations ...` can narrow or restore that fixed
COW subset in local owner-only state. A proposal that adds `workspace.promote`
also requires `--native-helper` to name an absolute, owner-only, non-link,
owner-executable native binary; the daemon rechecks that binary before every
apply. It increments the local descriptor revision but does not submit or
activate it. The daemon must next claim/connect and sign the proposal; its
**Overview → Local policy proposals** row then lets an entitled person prepare
and explicitly confirm the review. Activating a revision requires fresh human
verification. Neither an agent nor the Personal Assistant can activate a
proposal, and no direct descriptor-review endpoint bypasses this confirmation
path. The Personal Assistant can inspect the same signature-free proposal
summary for a manager and prepare a review link, but it cannot submit the
confirmation on the person's behalf.

On connection, the daemon sends a `hello` frame:

```json
{
  "type": "executor.hello.v1",
  "executorId": "uuid",
  "connectionId": "uuid",
  "connectionEpoch": 42,
  "descriptor": { "revision": 17, "policyDigest": "sha256:..." },
  "signature": "base64url-ed25519"
}
```

The server takes the executor connection advisory lock, accepts one active
connection epoch only, and fences prior streams. A stale epoch or descriptor
rollback is rejected. Idle daemons heartbeat with the signed descriptor digest;
an interactive session holds its outbound control stream while live.

A descriptor lists structural facts only: supported operation schemas,
resource/network limits, platform facts, and local-policy digest. A revision is
monotonic for one key. A newly advertised operation is pending review and
ungranted until an entitled human prepares and confirms its activation. The
descriptor cannot nominate a host path or create cloud authority.

## 6. Binding, queue lifecycle, and command receipts

`ToolCall` and `queue_jobs` remain the sole invocation lifecycle. An
`ExecutorCommand` is exactly-one protocol metadata attached to that queue job
and `ToolCall`; it never owns a second poller, lease, retry loop, or terminal
state.

The server creates `ExecutorBinding` under a PostgreSQL transaction-scoped
advisory lock derived from `(runOrSessionId, operationKey)`. It reads the opaque
candidate, then takes the executor lock and rechecks initiating human, agent,
scope/project membership, approved current descriptor, exact operation grant,
logical policy grant, online status, and authorization revision. Only then does
it consume the candidate and advance the executor's separate monotonic binding
fence. It stores executor, descriptor revision, that fence, and the consumed
candidate digest. A retry reuses that binding. Before each command dispatch,
Nessie repeats the same user, agent, scope, membership, descriptor, operation,
logical-policy, lifecycle, and revision checks under the executor lock. Dispatch
then advances the existing queue lease; it cannot select another executor after
retry, policy change, or revocation.

The only command transition receipts are:

```text
leased → accepted → started → result-acknowledged
```

Every frame binds `commandId`, `ToolCall`/run provenance, binding fence,
capability revision, expiry, idempotency key, canonical argument digest, and
payload digest. The daemon rejects mismatches, stale policy, replay, and a
completed command with another digest. It emits structured results only.

The daemon polls `/api/executor-daemon/commands/poll` with a fresh signed
`poll` payload; this signature domain is separate from claim, heartbeat, and
receipt. A command is released only while its existing queue job is processing.
The queue payload contains only the command id. Raw arguments and terminal
structured results are AES-256-GCM encrypted under the deployment secret while
at rest; the database retains only bounded ciphertext and canonical digests.
The daemon sends each receipt under a distinct signed `receipt` domain, and the
server recomputes the supplied terminal result digest before accepting it.

The initial local backend has `file.list`, `file.read`, `file.write`,
`workspace.review`, and `sandbox.stop`. It can execute a server-authored
`workspace.promote` command only after its local policy has the separate
owner-verified native-helper configuration described above; that command is
not model-facing. Nessie can create it only from the originating user's
reviewed-draft confirmation flow; there is no general-purpose promotion API.
Pairing requires one existing absolute
workspace directory; the daemon stores only its canonical path in owner-only
local state. File requests accept only relative paths, reject traversal and
every symbolic-link component, re-check that the configured root is still an
ordinary directory, and return bounded structured results without a host path.
`file.write` first creates a bounded daemon-owned COW tree under the secure
state directory using the server-provenanced run ID; it never opens the paired
root for write, and later file reads/lists for that run use the draft tree.
`workspace.review` emits at most 100 changed relative paths with kind and byte
count plus a canonical manifest digest only when the fully encoded result fits
the command receipt cap; otherwise it fails closed. It never reads the paired
root for write or applies a change. It is not yet a micro-VM or network isolation
boundary. No command, browser, or coding operation is advertised until its
isolated backend is implemented and reviewed. Host promotion remains unavailable
unless that user-confirmation and server-binding flow creates its exact command.

The receipt remains content-free, but its manifest digest binds the complete
local manifest: every changed path's base and draft SHA-256 values are included
in the digest calculation. A later promotion must reconstruct the exact same
manifest locally, so a same-length post-review edit cannot reuse a review.

The daemon's owner-only runtime directory already contains a per-run COW
substrate for that later backend. It atomically snapshots a paired root into a
daemon-owned scratch tree, rejecting every symbolic link, hard-linked file,
special file, and source tree over the file/byte limits. Scratch writes can
never touch the paired host root, and `sandbox.stop` can remove only the exact
derived run directory. `file.write` and the read-only `workspace.review` are
the only advertised consumers of this substrate after normal descriptor and
grant review. The daemon records a hash-only base manifest alongside the draft,
so review can report its exact COW delta without trusting a mutable host tree.
It is not a substitute for the required guest VM/forced egress. Its native
promotion primitive remains unavailable until the separate user-confirmation
and server-command flow can bind it to the exact review.

Before the worker adds an executor logical schema to a model request, a human
must bind one opaque candidate to the exact run. The user-facing launch endpoint
`POST /api/threads/:threadId/executor-runs` creates the human message, pending
run, task, bindings, and `run.execute` job in one transaction for one selected
bound channel agent. It accepts an agent id, one opaque candidate handle,
content, and a small exact operation bundle—but never an executor id. Every
operation is independently rechecked and bound before the candidate is
consumed, so a failed member rolls back the complete bundle. The older
`POST /api/runs/:runId/executor-bind` route is limited to binding one
already-created run operation. Both paths use the same fenced binding helper
and the schema carries no executor id; dispatch only sees that binding.
The worker creates the regular `ToolCall` before command dispatch and completes
that same row when the terminal receipt returns. It also creates the existing
`executor.command` queue job; its worker subscription holds the ordinary queue
lease while the daemon executes. Loss of the terminal receipt marks the command
`unknown_outcome` and fails the run retry-safely rather than returning a result
to the model.

If any acknowledgement is lost, Nessie does not invent at-most-once success.
It records `unknown_outcome` on the command metadata and follows the existing
queue/run `needs_setup` recovery path. The already-delivered command can still
provide its exact terminal receipt, which durably resolves that ambiguity; no
new logical side effect is created. Cancellation and revocation fence future
work immediately, signal the daemon, and retain the same ambiguous-outcome rule
until a terminal receipt is known.

## 7. Approval and access-change continuations

`ExecutorApproval` (invocation) and `ExecutorAccessChange` (access diff) share
one continuation implementation: canonical subject digest, actor user,
executor/policy/descriptor revisions, expiry, fencing token, one-time
consumption, and audit receipt.

The PA can prepare an access diff, but only a human can apply one:

1. `*_prepare` records the exact user/agent/operation diff and returns an
   opaque single-use confirmation token.
2. Web or companion renders a structural confirmation control bound to that
   token; chat text is never confirmation.
3. Private assignment, elevation, and revocation always require a fresh
   server-side password re-proof in the Phase 1 control plane; accounts without
   a password fail closed pending the shared SSO/WebAuthn verifier. The opaque
   verification binding is retained on the continuation for that upgrade.
   Other actions still require the structural user confirmation. Factor
   material never enters a prompt, transcript, database record, or log.
4. Confirmation rechecks every entitlement, revision, and digest before commit.

PA preparation is valid only in the requesting user's personal-assistant DM,
never a shared channel, scheduled job, child run, or arbitrary agent run. The
PA has no confirmation tool: confirmation is a user-owned web or desktop
control. Audit records the acting user and PA delegation provenance separately.

## 8. Sandbox, forced egress, and credentials

The initial backend is a per-session Linux micro-VM. The selected workspace is
read-only through virtiofs. It has no host shell, home, Docker socket, SSH
agent, host mount beyond that root, inherited environment, or direct network.

The guest's only virtual NIC terminates at the daemon's authenticated egress
gateway. There is no NAT bridge or direct DNS resolver; firewall rules deny
direct TCP, UDP/QUIC, proxy bypass, and alternate DNS. Chromium must use this
gateway. The gateway enforces HTTP(S), CONNECT, WebSocket, redirect, origin,
download, and upload policy. It uses `@nessie/runtime` `safeFetch` or
`pinnedFetch` for validated, IP-pinned connection and redirect handling, rather
than implementing a second SSRF policy.

Codex/Claude runs inside the same guest in a dedicated tmux server. The host
`~/.codex`, `~/.claude`, keychain, and global CLI tokens are never mounted.
A root-owned daemon credential broker keeps any renewable credential outside
the guest workspace identity and provides only short-lived executor/session
authorization through the forced gateway. Guest processes cannot read a
reusable bearer; broker or executor revocation closes the route immediately.

Raw local data can reach a model provider only within the explicit bounded run
consent. Nessie persists only redacted manifests, argument/policy digests,
result digests, and structured status. Raw file content, terminal output,
browser DOM, credentials, and factor material are forbidden from database
records, audit, logs, realtime events, and error reports.

## 9. Promotion is the sole host-write boundary

Guest work—including coding sessions—uses a copy-on-write scratch workspace.
`workspace.promote` is the only host-write operation. It requires its own
executor-operation grant, logical tool grant, local policy decision, binding,
approval, fence, and accepted/started/result-acknowledged receipts.

The guest cannot provide host paths or apply changes. The daemon constructs the
manifest from COW state, verifies the expected base snapshot, validates every
path beneath the granted root, and rejects symlinks, hardlinks, special files,
mount crossings, and conflicts. It applies a validated manifest through a root
directory descriptor with no-follow operations and daemon-owned staging. A
durable all-or-recover journal ensures a crash finishes the validated manifest
or restores the base before another promotion begins. Policy may require a
visible local/human confirmation.

The checked-in native component at `executor/native` keeps both commands
descriptor-only: it receives the paired root and COW draft exclusively as
already-open directory descriptors on file descriptors 3 and 4; it receives
neither path as JSON or an argument. `workspace-preflight` re-opens every
manifest component relative to those descriptors with no-follow calls, rejects
links, special files, mount crossings and malformed relative names, recomputes
both the host base and draft hashes, and reports only a ready/rejected result.
It also recomputes the canonical manifest digest rather than trusting a digest
provided by its caller.

`workspace-apply` is a daemon-internal native primitive, **not an executor
descriptor or worker tool**. Before its first host rename it re-runs preflight,
copies every draft file into a daemon-controlled `.nessie-executor-promotions`
journal beneath the paired root, and persists the complete manifest plus the
opaque approval digest and binding fence. It moves base files to that journal
with no-replace, then moves staged drafts into the existing parent paths with
no-replace. A later invocation rolls an uncommitted journal back before it
does any new work; a committed journal is only cleaned up. The journal and
every descendant must be private to the daemon user, and malformed journals
fail closed. `.nessie-executor-promotions` is a reserved root path: it is
excluded from sandbox snapshots and listings, and all sandbox/native manifest
operations reject it. New nested paths must already have a safe host parent;
this primitive does not create host directories.

`workspace.promote` has no model-facing worker schema. Instead, **Your
reviewed drafts** shows only reviews from runs the current user originated.
That person prepares a single-use continuation, then supplies a fresh password
before confirmation. The server rechecks the exact acknowledged review result
digest, manifest digest, originating run/user/agent, executor authorization
revision, operation grant, logical grant, active local policy, and server-held
executor identity. It atomically binds `workspace.promote`, derives an approval
digest over the review and binding fence, creates the encrypted command plus
its normal queue/ToolCall records, and consumes the continuation. The daemon
rebuilds its local manifest and refuses a changed digest before it invokes the
native helper. Thus no agent, PA, browser, or caller-provided host path can
turn a draft write into a host write.

The native primitive cannot mint or independently verify server facts; it only
records the command-bound approval digest and fence after the companion has
verified the signed command. A promotion remains unavailable whenever the
daemon has not proposed and had a human activate its native-helper policy.

## 10. State and error contract

Executor state is:

```text
pending_pairing → online ↔ offline
        │             ↓
        └──────────→ draining → revoked
                         ↓
                       error
```

`paused` is an online executor with command acceptance disabled. `draining`
accepts no new binding and sends cancellation to active commands. `revoked`
invalidates client certificates and all candidate handles. `error` exposes a
sanitized reason but no raw machine diagnostics.

Stable reason/error codes include:

```text
EXECUTOR_NOT_DISCOVERABLE        EXECUTOR_OFFLINE
EXECUTOR_SCOPE_MISMATCH          EXECUTOR_OPERATION_UNGRANTED
EXECUTOR_DESCRIPTOR_UNREVIEWED   EXECUTOR_POLICY_CHANGED
EXECUTOR_BINDING_FENCED          EXECUTOR_COMMAND_REPLAY
EXECUTOR_COMMAND_UNKNOWN_OUTCOME EXECUTOR_APPROVAL_STALE
EXECUTOR_CANDIDATE_INVALID       EXECUTOR_PROMOTION_CONFLICT
EXECUTOR_PROMOTION_UNSAFE_PATH   EXECUTOR_EGRESS_DENIED
EXECUTOR_CREDENTIAL_REVOKED
```

Errors are safe for the caller's access level and never disclose a private
executor, other users, local paths, credentials, or raw output.

## 11. Threat model and mandatory verification

| Threat | Required control |
| --- | --- |
| Stolen pairing link or key replay | Short-lived single-use verifier, proof of possession, human fingerprint confirmation, certificate/key rotation fencing. |
| Confused deputy through shared agent | Exact private human **and** agent assignment plus exact operation grant and immutable run context. |
| Browser/CLI SSRF or DNS bypass | Guest-only forced gateway, no direct DNS/UDP/QUIC, pinned fetch on every route/redirect. |
| Guest writes host workspace | COW only; daemon-owned `workspace.promote` with no-follow manifest validation, approval, fencing, journaled recovery. |
| Lost command acknowledgement | Durable receipts and `unknown_outcome` mapped to existing `needs_setup`, never presumed success. |
| PA prompt injection mutates access | Prepare/structural-confirm/step-up flow in PA DM only; actor user rechecked at commit. |
| Host credential exfiltration | No host CLI home/keychain mount; brokered short-lived gateway authorization; raw-data retention bans. |
| Terminal spoofing | Typed lifecycle events are authoritative; terminal/ANSI output is display-only. |

Contract tests must cover enrollment replay and race, descriptor rollback, dual
connection fencing, availability and roster non-leakage, final-admin
offboarding, grant/revoke during binding, stale candidate handles, receipt-loss
recovery, forced egress bypasses, broker revocation, hostile promotion
manifests, interrupted promotion, and PA confirmation/step-up replay.
