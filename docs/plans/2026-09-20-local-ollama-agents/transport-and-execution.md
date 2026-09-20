# Transport and execution

Part of [Local Ollama agents](overview.md).

## Two host modes, one inference protocol

```text
Nessie worker: ordinary agent loop, grants, approvals, disclosure, checkpoints
    |
    | bounded local inference attempt, stored with a run fence
    v
Nessie API + Postgres: authenticated delivery, receipts, streaming spool
    ^                                      ^
    | outbound HTTPS                       | outbound HTTPS
paired executor                       running Nessie Desktop
    | shared inference host module         | same module, app-supervised
    v                                      v
loopback Ollama                         loopback Ollama
```

The executor is an application-level relay for a typed inference request,
never a reverse HTTP proxy. It cannot forward an arbitrary URL, headers, path
or method. It receives the request, calls local Ollama, and returns normalized
model output. The existing executor's pairing, current active capability
revision, grants, connection fence and revocation still apply.

Direct Desktop means the main app owns the inference connection and lifecycle.
It requires **no executor installation, executor record, workspace folder,
VM, browser/MCP grant, or independently running daemon**. Implement its bridge
as an inference-only entry point in a shared `@nessie/local-inference-host`
package, supervised by Tauri using the packaged Node runtime already used for
local components. The executor imports that same package. This is an internal
implementation process, not a second product the person configures. Refactor
runtime packaging to include this package without starting the executor.

The native wrapper exposes narrow commands: inspect local availability,
confirm/start hosting, pause, forget, and open verified help.
It launches only its signed/package-verified entry point with fixed arguments;
enrollment secrets travel on stdin/IPC, never argv. No generic process or fetch
command reaches the hosted webview. Every command requires
`window.label == "main"` and the currently configured, TLS-verified Nessie
origin; secondary document windows cannot pair. Consent accepts only an opaque
challenge id. Native code fetches canonical display fields from that origin,
verifies the signed server response, current signed-in custodian and
organisation, and displays them outside webview-controlled text before signing.
A custom self-hosted origin is chosen in native settings, confirmed locally,
certificate-verified and pinned by origin; changing or clearing it signs out,
stops hosting, rotates the connection epoch and makes bindings require
reconsent. A deep link or web document cannot set this trust.

The bridge runs while Desktop's process runs, including a minimized window. On
full Quit or sign-out it stops accepting requests and sends a signed goodbye;
on crash the lease expires. It does not add autostart or a hidden persistent
daemon. On macOS, closing the last window may leave the app running: copy says
“while Nessie is running”, not “while this window is open”. A later launch may
resume an unrevoked locally enabled host only after the same custodian and
organisation authenticate; it does not reauthorize a revoked grant.

An executor can remain available after Desktop quits. On Windows, the executor
service may run under a different OS account than the per-user Ollama app;
probe its reachable loopback API, never another user's profile/PATH. A logout
that stops Ollama is ordinary loss of availability. On Linux, a user service
and a system Ollama installation may coexist; the reachable API is the source,
not a guessed model-store path. macOS uses the same API whether Ollama is in
Applications or launched by the person. No platform needs a VM for inference.

## Automatic discovery

Discovery begins when the eligible person opens “Local Ollama” and accepts the
local one-time “Find Ollama on this computer” action, or when an already
consented host starts. This gives automatic detection an explicit privacy
boundary without turning normal setup into a form. On an executor the local
“Use Ollama for Nessie agents” action establishes this consent; the server can
request a refresh only after that local permission exists.

1. Try the saved canonical socket first, then `http://127.0.0.1:11434` and
   `http://[::1]:11434`, deduplicated, in that deterministic order. A user-
   entered `localhost` becomes an explicit IPv4/IPv6 choice before dialing,
   never a DNS lookup. Probe at most three endpoints for two seconds each under
   one sweep. If more than one distinct daemon identity/model set responds,
   stop and ask the local custodian which exact socket to bind; response timing
   never chooses. Re-probe that canonical socket immediately before consent and
   dispatch. No port scan, mDNS discovery, WSL enumeration, registry crawl or
   network sweep.
2. Check `/api/version`; list `/api/tags`; read `/api/show` only for displayed
   candidates and the selected model. Bound JSON sizes, names and capability
   arrays. Only the name, manifest digest, model size and supported features
   may leave local memory after the person publishes that model. Do not send
   `modelfile`, template, licence text, paths or environment variables.
3. Native installation hints may detect a registered Ollama application in
   the current user's normal application locations on macOS/Windows, or a
   known executable path on Linux. Existence is a hint, never permission to
   execute it or proof the server works. No command discovered via an untrusted
   PATH is run. A failed probe says “Ollama isn't responding”; only verified
   installation evidence changes the action to “Open Ollama”.
4. Display installed local chat models, grouping aliases with the same digest
   while preserving the selected tag. Do not pick the largest, first, newest,
   or a model based on its name. A single compatible model is preselected,
   multiple models require one choice, and Save/Use confirms either. Embedding
   models and unsupported cloud-backed Ollama entries are ineligible with an
   explanation. A selectable entry must have empty `remote_host` and
   `remote_model` in both `/api/tags` and `/api/show`, a non-empty manifest
   digest, locally populated model metadata, and no remote marker in any chat
   frame. These are official Ollama structural fields, not a name heuristic.
   Unknown locality is ineligible. A release fixture installs/observes a real
   cloud entry and proves rejection while monitoring outbound traffic.
5. No inference, loading, downloading or service start is part of discovery.
   After the person chooses “Use this model”, perform one bounded capability
   smoke call (at most 64 output tokens, 60 seconds, no private content), then
   activate consent. Explain that the first load can take a moment. A failed
   test preserves the previous active selection and names the remedy.

The fast path is therefore “Local Ollama → detected model → Use this model”;
manual endpoint entry appears only under “Ollama is using another local port”.
It accepts a loopback port, not an arbitrary URL. Retain
`assertLoopbackOrigin`'s literal-only, no credentials/path/query/fragment,
no-redirect invariant after its extraction. LAN origins, public origins,
metadata addresses, unix-socket paths, proxy environment settings and DNS
rebinding are refused. VM/WSL Ollama that is not already reachable through a
user-created host-loopback forward is unsupported; Nessie neither creates nor
documents a LAN endpoint, firewall rule or WSL forward. LAN support is outside
this release.

Refresh the selected model every 30 seconds while hosting, on wake/reconnect,
on explicit retry, and immediately before dispatch. Refresh the unselected
local list on opening the picker or pressing Refresh; no background harvesting
of all model names. Scan failure never becomes an empty list. A tag whose digest
changes makes the binding `model_changed`; show “Use updated model” and require
the exact new digest confirmation. A removed model makes it unavailable;
reinstalling the same verified digest may restore connectivity, but a prior
revocation, authorisation failure or explicit pause still requires repair.

The observed manifest digest identifies the model the host claims it will run.
Ollama's unauthenticated loopback API cannot attest the responding process or
prevent a hostile local administrator changing the tag during a call. Check
the selected digest immediately before and after a call; refuse a changed
result, but do not claim this removes the race. The trust boundary includes
the OS user, Ollama and the host software. Do not run `/api/copy` or rewrite
someone's model merely to simulate cryptographic attestation.

## Pairing, authentication and encryption

Executor mode reuses the machine key and live `activeConnectionEpoch`; add
purpose-separated signed inference routes to the existing daemon admission.
Direct mode uses an app-installation machine key and the same extracted
challenge-verification primitives, with its own host id and epoch. Extract and
test reusable canonical-signature and challenge logic first; do not clone
`executor-daemon.ts` into an almost-identical device service.

Desktop enrollment starts from the authenticated custodian's session, then
requires local native confirmation of origin, org and intended agent/model.
The one-use enrollment challenge expires after five minutes and is bound to
the proposed public key, custodian and org. Store only its digest. Connecting
consumes a server-issued 60-second challenge in the same transaction that
increments the connection epoch. Another connection fences the old process.
Each message signs purpose, protocol version, host/org id, connection epoch,
strictly increasing sequence per message purpose, sent time and canonical body
digest. Serialize each purpose's requests locally; independent heartbeat/poll/
frame sequences keep a long poll from blocking cancellation or liveness. Accept a
maximum 30-second clock skew, but calculate expiry from server receipt time.
Purpose-specific domains prevent replaying a heartbeat as a consent or result.
Use the existing database-backed rate-limit boundary for enrollment, challenge,
claim and frame intake, keyed by authenticated principal/host plus source IP
before authentication. Initial bounds are five enrollment attempts per person
per minute and sixty challenge/claim attempts per host per minute; payload
credit is the frame limit. An unknown host and an unauthorised host return the
same refusal, and rate-limit bodies contain no inventory or tenant metadata.

Long-lived private keys never enter the webview or server. Executor mode keeps
the existing owner-only state/ACL discipline. Direct Desktop stores its key
under platform-protected app data (Keychain on macOS, DPAPI for the current
user on Windows; Secret Service on Linux), delivered to the native bridge
through private IPC. If a Linux credential store is unavailable, setup says so
and fails closed; it must not silently introduce a plaintext-key fallback.
No new password account or UOA credential store is created. Re-pairing or
secure-store repair rotates the key, increments host authorization and
connection epochs, fences all previous attempts, receipts and sessions, and
makes every binding `needs_rebinding`; no consent is inherited.

All remote links use authenticated HTTPS with certificate verification. The
host connection is outbound; NAT needs no listener, public Ollama bind or
router configuration. Persist short-lived prompt/result bodies encrypted
with the existing server runtime encryption/keyring facilities, authenticated
against org/attempt/fence/digest as associated data. Separate this retention
from the normal authorised transcript. TLS and storage encryption are not
end-to-end encryption against Nessie: the server already assembles the prompt.
Local Ollama traffic is HTTP only over literal loopback. No credentials or
arbitrary remote headers are forwarded to Ollama.

Requests remain data. Tool arguments, errors and prompt text cannot choose
destinations, grant scope, model names outside the selected binding, file paths,
executables or shell flags. No local filesystem observation tools are added.
Signed capabilities prove which host responded, not that its answer is true.

## API and event contract

New contracts belong to `packages/schemas/src/local-agent-inference.ts` and
domain-owned API contracts; derive TypeScript DTOs from schemas. Every listed
identifier, path, query and stored JSON field is validated. New list responses
use the existing cursor/limit/total schema, with limit at most 100.

| Door | Contract and authorization |
| --- | --- |
| `GET /api/local-inference/hosts` | The current stable subject's own entitled hosts/models only, optionally evaluated for an explicit destination team. Never an org-wide or team machine inventory. |
| `POST /api/local-inference/hosts/enroll` | Authenticated eligible custodian, native confirmation pending; direct mode only. Returns five-minute one-use enrollment material, `no-store`. |
| `POST /api/local-inference/hosts/:id/pause`, `/resume`, `/revoke` | Custodian only in V1. Resume cannot cure reauthorization. Native local pause is always possible offline. |
| `POST /api/agents/:id/local-inference/prepare` | Agent editor + eligible scope + eligible host. Returns expiring exact selection digest/challenge; no active lane change yet. |
| `POST /api/agents/:id/local-inference/confirm` | Signed host consent plus fresh revalidation of the prepared editor and owner stable identity/epoch and the prepared host authorization/connection epochs; changes only the exact inactive binding to `consented_pending_activation`. Conflicts are 409; it never changes the agent lane. |
| Existing Agent Designer Save mutation | Sole activation commit. Locks agent, binding and policy version, compares the prepared form/host/model/setting revisions, revalidates live authority and locality, then atomically swaps the agent lane. Any mismatch is 409 and leaves the prior lane intact. |
| `DELETE /api/agents/:id/local-inference` | Normal agent field authority; revoke binding and require explicit replacement model, never implicit cloud. |
| `GET /api/agents/:id/availability` | Existing agent visibility predicate; presence plus safe reason/action and revision, no host address, inventory or private activity. Lists may batch this projection for visible ids. |
| `POST /api/local-inference/daemon/challenge`, `/claim` | Paired host key, one-use challenge, epoch CAS. Executor variant delegates to the executor authority. No bearer user session substitutes for machine proof. |
| `POST /api/local-inference/daemon/heartbeat` | Signed epoch/sequence; protocol capabilities, published model observations, local pause, capacity and progress references. Reply includes server time, policy revision and pending cancellation ids. |
| `POST /api/local-inference/daemon/poll` | Signed host request; leases one eligible attempt or waits at most 20 seconds. Delivers only that host's encrypted-at-rest payload over TLS. |
| `POST /api/local-inference/daemon/frames` | Signed attempt id/fence, sequence range, bounded deltas or terminal result/usage; duplicates accepted only with identical digest. Reply cumulatively acknowledges and grants byte credit. |
| `POST /api/local-inference/daemon/goodbye` | Signed current epoch; sets that connection unavailable without revoking consent. Delayed old-epoch goodbye cannot disconnect a new session. |

Local host health uses the ordinary durable alert substrate, not a new device
notification channel. The reader validates every row against the current
`LocalInferenceHost`: it is visible only to that host's current custodian in
the same organisation while a non-paused repairable health reason remains.
The bell deliberately carries no hostname, model name, or raw failure detail;
its recovery link opens that exact host in **Connected accounts → AI inference
provider → Local Ollama**. The shared reader/parser and owner-only recovery
surface land before a health writer, so a rolling deployment cannot emit a
kind older API/admin replicas reject.

Worker dispatch calls an injected domain service, not its own HTTP route.
Each request carries `protocolVersion`, attempt/invocation/run ids, host and
binding ids/revisions, model tag+digest, run/host fences, deadline, maximum
input/output/context, normalized messages/tools, and allowed inference options.
It carries no URL. Host refusal/error vocabulary includes `policy_denied`,
`needs_reauthorization`, `offline`, `busy`, `ollama_unreachable`,
`unsupported_version`, `no_models`, `model_missing`, `model_changed`,
`unsupported_capability`, `source_not_allowed`, `context_too_large`,
`resource_exhausted`, `cancelled`, `deadline_exceeded`, `connection_fenced`,
`protocol_error`. Raw exception messages, model templates and host paths are
never customer-facing details.

Before local dispatch can serialize a request, source adapters issue one opaque
coverage token for every ordered provider component: prompt assembly covers
system, memory, checkpoint, conversation and direct-input components; the
catalogue, delegated loop, compaction, tool-result and generated-utility
adapters cover the components they create. `ProvenancedProviderInput` finalizes
only when every component has one distinct, non-empty token; otherwise it
returns the structural error `unclassified_input`. An empty coverage set is
never a public-only shortcut. The opaque handle owns a frozen structural copy
and the dispatcher checks it before it creates any encrypted attempt or frame
bytes. `ConsumedSourceSink` remains reply-disclosure evidence, not proof that a
prompt may be sent to a computer.

Immediately before the same attempt write, the dispatcher re-resolves the
active binding (including owner equals live host custodian), resolves the
owner's current stored-identity UOA entitlement, and requires that viewer to
satisfy the complete, unsubtracted consumed basis. Unknown or another person's
private-conversation lineage returns `source_not_allowed`; neither a sharing
grant nor a local retry substitutes for host consent.

Use `agent.updated` as a content-free cache invalidation during compatibility
rollout. Once all replicas understand it, `agent.availability` may carry only
`{agentId, availability, reason, revision, validUntil}` to the same currently
entitled audience. Bindings/private hosts must not publish org-wide names or
status. REST rehydrates on reconnect or `realtime.gap`. Publish through the
existing per-scope locked realtime transport, not a second WebSocket hub.

## Presence state machine

Online means the selected binding has current consent/entitlement, an
unpaused non-revoked host with a fresh connection, and a freshly verified local
model capable of this agent's configured work. It is a readiness estimate,
not a promise that memory allocation or a particular future prompt will work.

| Internal state | Public availability | Transition/remedy |
| --- | --- | --- |
| `unconfigured`, `pending_consent` | Offline | Complete setup or local consent |
| `connecting`, `checking_model` | Offline, “Connecting” | Await bounded check; never optimistic green |
| `ready` | Online | A fresh host and selected model can accept work |
| `busy` | Online, “Busy” in conversation | Capacity leased; bounded queue is available |
| `disconnected`, `sleeping`, `expired` | Offline | Start/wake/reconnect the selected host |
| `entitlement_unavailable`, stale viewer data | Unknown | Wait for authority/realtime recovery; never render green or revoke |
| `paused` | Offline | Custodian explicitly resumes |
| `model_missing`, `model_changed`, `incompatible` | Offline | Install/select/reconfirm/update locally |
| `policy_denied`, `needs_reauthorization`, `revoked` | Offline | Authorised explicit repair; a login/heartbeat cannot heal it |

Heartbeat every 20 seconds with small jitter; freshness expires after 60
seconds (the existing executor liveness convention). Model observation TTL is
60 seconds, refreshed every 30. A signed goodbye/pause makes offline immediate.
Abrupt crash/network loss/sleep becomes offline within 60 seconds plus at most
a five-second projection sweep. Reads and admission evaluate the TTL directly,
so they do not depend on the sweep having run. A daemon stops starting work
if it has not obtained an authorisation/lease renewal within 60 seconds.

Wake and reconnect claim a new epoch and re-probe the model before advertising
ready. Two running processes for the same host cannot both be active. Different
computers are different hosts. The agent uses **one explicitly selected host**;
another laptop becoming online does not take over. Selecting another consented
host is an explicit binding revision for subsequent runs, never a live-run move.
Desktop and executor on the same OS account may detect the same Ollama; setup
shows one connection choice per host mode and an active-host message. A
shared local endpoint lock/capacity coordinator in the host module prevents
double-counting capacity when both modes are active. Different OS accounts
cannot reliably coordinate that lock; Ollama resource failures remain bounded
and truthful, not a promise of whole-machine GPU exclusivity.

The API returns server-computed availability, `serverTime` and `validUntil`.
Client time may animate a cosmetic countdown but can never turn unknown or
expired state online. Human presence never enters this calculation. A person can be away while the
executor agent is online, or online on a phone while their desktop agent is
offline. Agents get no manual away state. If the viewing client's realtime
connection is lost, its status becomes “Connection lost”/unknown locally;
it must not keep showing stale green. It reconciles from REST on reconnection.

## Admission, routing and failures

At normal run admission resolve and persist the local pin before budgets or
provider selection can choose another lane. Recheck the binding and local
egress permission before every dispatch and while an attempt is leased.
Perform structural presence gating before expensive engagement inference when
the addressed agent is known; do not add keyword-based “is this for the local
agent” heuristics. Shared-room engagement remains model-judged by the existing
orchestrator and retains its ordinary deployment cost.

There is one existing `(agent, thread)` run slot. Local scheduling must use it
and the existing durable pending-message path. A ready busy host has one
inference slot by default; no user-facing concurrency knob. Queue at most eight
attempts per host, FIFO within fair round-robin agent admission, with a 60-second
queue deadline and 5-minute inference deadline bounded by the run's remaining
wall-clock allowance. Reject overload with a classified retryable result,
never an unbounded in-memory queue. An offline host at admission waits only
inside that same 60-second budget; the conversation immediately states why.
After expiry the run fails with a restart doorway, not a fabricated agent reply.
Recurring schedules record the existing failed/skipped delivery contract and
one health alert; no catch-up avalanche or second scheduler.

Lease attempts with `FOR UPDATE SKIP LOCKED`/conditional updates in Postgres.
Acquire a host slot and run-fence check in the same short transaction. The host
acknowledges within five seconds, renews every 20 seconds and has a 60-second
lease; absolute deadlines remain fixed. No database transaction stays open
over an Ollama call. Workers/API replicas may fail over, but a new claimant
must recover the attempt receipt by id and fence rather than issue the prompt
again. The host keeps a bounded owner-only receipt journal without prompt text.
Replay material is capped at 512 KiB per accepted result and eight results,
encrypted with a non-exportable platform machine key under owner-only ACLs,
excluded from logs, crash diagnostics and support bundles, deleted immediately
after durable server acknowledgement, and removed unconditionally after a
one-hour hard TTL. If protected storage is unavailable, the host refuses work;
there is no plaintext journal. Duplicate delivery returns the protected
status/result instead of recomputing.

Before acceptance, an expired delivery may be retried once to the **same host,
model and consent revision**, if the queue deadline permits. After acceptance,
unknown completion is reconciled from durable receipts; otherwise fail/checkpoint
as interrupted. Do not automatically replay an accepted ambiguous attempt,
switch hosts, or restart already completed tools. A person may restart after
inspection through the existing lifecycle. Worker drain hands back the fenced
run and uses the existing crash checkpoint; recorded tool results are reused.

Cancellation sets the attempt's cancel flag in the same flow as
`cancelRequestedAt`; polling/heartbeat replies deliver it to the host. The
host aborts the Ollama HTTP request and acknowledges within five seconds of
receiving cancellation. A disconnected host cannot be guaranteed to abort
immediately: its local lease/deadline self-cancels, and the server refuses all
late frames/terminal writes. State the control as “Stopping” until acknowledged
or fenced, never claim the GPU stopped merely because a request was sent.
No per-agent stop control duplicates the existing run Cancel action.

Stream through a durable encrypted spool: at most 16 KiB per frame, 128 KiB
unacknowledged credit, 2 MiB serialized input and 512 KiB output per attempt.
Coalesce short deltas for at most 100 ms. Pause reading when credit is exhausted;
if a producer cannot be backpressured, abort before exceeding the bound.
Duplicate sequence+digest is idempotent; mismatched duplicates, gaps or old
fences are refused. A terminal result and usage are persisted atomically before
acknowledgement; the worker records usage once per `invocationId`. Delete payloads
and frames after both sides acknowledge plus five minutes, or after a one-hour
hard TTL; keep non-content receipt metadata under normal audit retention.
The shared `withSweepLock` owner performs bounded cleanup. No raw prompt/result
logs or local temp transcript files.

## Provider and capability adapter

Add an injected `local-device` inference service adapter; its transport is the
durable attempt service, not `baseUrl` or an API key. Resolve this before the
deployment provider override and route graph; reject combining a local binding
with a routing profile. Normalize Ollama chat content, native tool calls,
usage, finish reasons and optional thinking to `ProviderMessage`,
`ProviderToolCall`, `ModelCapabilitySnapshot` and the existing delta vocabulary.
Incomplete streamed tool calls never execute; validate completed arguments
through the same tool schemas and existing authorization/approval path. V1's
owner-host invariant is rechecked before each tool round, so a model never
borrows a different person's agent authority. Model output remains hostile;
externally effective actions keep their existing approval gates.

Use the selected runtime's `/api/show` metadata and a bounded smoke test for
tools/structured output; never infer capabilities from “qwen” or “gemma” in a
name. The smoke exposes only a synthetic `nessie_capability_probe` no-op schema,
inspects and discards the returned call, and never invokes `authorizeToolCall`
or any real tool runner. A tool-bearing agent cannot select a model without native tool support.
Text-only models may serve agents with no tools. Adding tools later revalidates
the selection. Start with text inputs and native tool calling; unsupported
images/audio produce an explicit refusal instead of silently dropping bytes.
Any supported tool definitions remain bounded by the existing dynamic toolset.

Choose `num_ctx` explicitly: initially 8192, capped by observed model limits
and the existing input/output admission; expose it only in advanced settings
when a context failure makes changing it useful. Unknown limits remain unknown;
a conservative configured cap is labelled as such. `num_predict` receives the
run's allowed output, `keep_alive` is bounded (five minutes), and unsupported
reasoning-effort options are omitted without pretending they changed quality.
The hardware smoke establishes the tested Ollama minimum; the current import
client's `0.34.0` floor is not evidence that every older chat API is incompatible.
Use a capability/version compatibility table, initially tested at 0.34.1.

Every discovery, pre-dispatch and result parser rejects non-empty Ollama
`remote_host` or `remote_model`; a mid-stream remote marker terminates the
attempt without accepting output. Utility inference must consume the same local service and selected model, not
`NESSIE_UTILITY_MODEL`. General spawn/delegation cannot create an unconfigured
cloud child from a local run: ephemeral children inherit a **child Run** pin
tied to the consenting parent, same owner/host/digest, same disclosure gate,
and the existing delegate budget. `subtask-tools.ts` must not copy the binding
onto the durable child `Agent` row; later independent child runs cannot reuse
it. This capability cannot attach to a persistent agent or widen tools.
`agent_peer_delegate` targeting another ordinary agent
retains that target's own explicit policy and is identified as a separate
agent's work, not a local fallback. If that action would export restricted
material, the existing destination gate still refuses it.

## Observability and recovery ownership

Record metadata-only stage timings, queue time, model-load/inference duration,
token counts, host transport, protocol version, typed outcomes, revocation and
attempt retries. Avoid high-cardinality metric labels containing user/agent
ids, model tags or device labels. Trace ids can reference authorized records.
Count rejected signatures, stale epochs, overflow, expired leases and lost
receipts. Never expose GPU stats, heartbeats or tokens in ordinary chat.

A CAS transition increments host/binding `healthRevision` and creates one typed
`UserAlert` per exact recipient with an event key containing resource id and
revision. Agent selection/source failures go only to the person-owned agent's
owner/editor; endpoint, key and local-runtime failures go only to that same
host custodian; policy failures go to live UOA organisation owners/admins who
can change the protected setting. Never notify all team members. Reader support
lands before writers and stores a typed host/binding reference, not display
names. The alert route recomputes viewer authorization and returns a safe
current projection. Push text is generic. The alert deep-links through the
navigation registry to `designerSection=model`, the exact owner Connections
row, or the real conversation run-restart action.

Routine app close, idle sleep and brief network loss change presence quietly.
A scheduled or accepted run that cannot proceed, or a persistent actionable
configuration/auth failure, creates the durable health transition. Repeated
offline attempts in the same episode reuse it; ordinary network reconnect may
restore presence automatically but does not auto-resume paused schedules or
clear a revocation. “Reconnect”, “Use updated model”, “Resume” and renewed
native consent are distinct remedies, not a universal retry that bypasses policy.
