# Adversarial review: local Ollama agents

**Reviewed design:** commit `6c6c9632f5c4fb9f953d3cbfe34e46becfc5ba5b`

**Review date:** 2026-09-20

**Verdict:** **REJECT**

This is a rejection of the design as implementation-ready, not of local
inference as a product direction. The plan gets several important foundations
right: it does not create a second identity store, it rejects silent cloud
fallback, it uses a server-issued challenge for consent, and it tries to pin an
accepted run to an exact machine and model revision. Those properties are not
enough to make the proposed cross-person execution boundary safe. Five
stop-ship defects can cause data disclosure, unauthorized side effects, or an
activation that neither involved person actually intended.

The review covers all five plan chapters, the routed standards they invoke,
and the current Prisma, UOA entitlement, scoped-setting, executor, worker,
desktop, navigation, alert, and Designer implementations. Findings marked
**confirmed contradiction** are demonstrable against the current repository or
the plan's own sections. Questions and improvements are separated later.

## Threat model

### Protected assets

- Prompt components, disclosed document and message content, tool schemas,
  tool results, checkpoints, and model output.
- The identity of the person whose entitlement permits a host to receive data,
  and the identity of the person whose agent is allowed to act.
- Agent/model selection, the exact model revision, per-run routing pins,
  attempt identifiers, and accepted-result receipts.
- Machine keys, consent challenges, access tokens, and local endpoint details.
- UOA-owned organization/team membership and its live revocation state.
- Presence, capability-health, and recovery state on which a person decides
  whether a local run is safe and available.

### Actors and trust boundaries

- An agent editor, a machine custodian, another organization member, an
  organization administrator, and an affected reader are distinct principals.
  One person may hold several roles, but the protocol must not assume that.
- UOA is the sole authority for people, organization/team membership, and
  entitlement. Nessie may cache but may not manufacture or persist a parallel
  membership truth.
- Nessie's API and worker are trusted policy enforcement points. A browser
  webview is untrusted input even when it has a trusted origin; an XSS or a
  secondary document window must not be able to mint native consent.
- The executor/native host proves possession of a machine key. That proves
  which paired installation spoke, not that Ollama, a model, a capability list,
  or returned tool calls are honest.
- A loopback Ollama endpoint has no native authentication. Any process under
  the local user's authority may bind the port and impersonate it. A custodian
  who deliberately substitutes a hostile model or daemon is also in scope for
  a team-offered host.
- TLS protects the executor-server hop only when server identity, origin, and
  session binding are checked. DNS, local forwarding, proxies, and re-pairing
  can change the effective peer.
- Local operating-system administrators can read process memory and local
  model input. Preventing that is a non-goal, but the product must truthfully
  name the machine/person receiving the data.

### Security invariants

1. No prompt byte leaves the worker without a complete, fail-closed disclosure
   basis and a live entitlement decision for the exact recipient.
2. A host recipient is not thereby authorized to exercise the agent owner's
   tool authority. Model output is hostile input until separately authorized.
3. Only one protocol action commits the agent's local lane, and it commits the
   exact editor choice and custodian consent under a compare-and-swap policy
   snapshot.
4. Local means no inference request or prompt is processed by a cloud-backed
   model, including an Ollama cloud model selected through a loopback daemon.
5. Presence and capability state are leases, never durable claims of current
   availability. Unknown is not healthy, revoked, or absent.

## Confirmed findings

### BLOCKER 1 — disclosure evidence fails open at the new recipient boundary

**Type:** confirmed code/design contradiction.

**Evidence:** [transport-and-execution.md](transport-and-execution.md) proposes
using `ConsumedSourceSink` as the pre-dispatch host gate. In
[`disclosure-basis.ts`](../../../worker/src/run/execute/disclosure-basis.ts),
`add()` silently ignores an empty scope (`:65`), while `computeReplyBasis`
interprets no accumulated scopes as unrestricted (`:160` onward). The
[disclosure standard](../../standards/disclosure-boundaries.md) explicitly
states that a forgotten read fails open.

**Exploit/failure:** a new prompt contributor—checkpoint summary, memory,
system material, tool result, attachment reader, or future reader—omits its sink
write. The host gate sees an empty/unrestricted basis and sends private bytes to
a machine that the actual source audience never authorized.

**Impact:** cross-person disclosure of conversation, document, or tool data.
Adding another consumer of the same fail-open evidence turns an acknowledged
internal limitation into an outbound data-exfiltration primitive.

**Required correction:** introduce a provider-call input projection that proves
complete provenance coverage of every prompt component. Unclassified input
must prevent local dispatch. Make construction of a dispatchable prompt
impossible without coverage tokens from each source adapter, and add a test
where one reader deliberately omits its sink contribution. Merely calling
`sink.list()` at another point is not a correction.

### BLOCKER 2 — the plan gives two different actions authority to activate the lane

**Type:** confirmed plan contradiction.

**Evidence:** [authority-and-storage.md](authority-and-storage.md) says server
confirmation atomically activates the binding and switches the agent lane
(`:107-110`). [experience.md](experience.md) says the bounded test enables the
existing **Save**, and that saving persists the verified selection (`:39` and
inventory row 8). These cannot both be the commit point.

**Exploit/failure:** an editor prepares model A, the custodian confirms it, and
the server switches the agent even though the editor cancels or has since
selected model B. Conversely, Save can race a revoked/expired confirmation and
persist a lane after the custodian believed it was cancelled.

**Impact:** an agent sends data to an unintended machine/model or unexpectedly
stops using its previous provider. Neither human has an unambiguous final
decision.

**Required correction:** choose one compare-and-swap commit owner. A safe
shape is: native confirmation approves an inactive exact binding; Save commits
the editor's exact binding only after revalidating consent, live entitlement,
effective settings, and model digest in one transaction. Equally, confirmation
could commit a previously frozen editor change, but then the UI must call that
out explicitly. Specify dirty-form changes, cancel, expiry, duplicate confirms,
and revocation between preparation and commit.

### BLOCKER 3 — “local” cannot yet distinguish a local model from Ollama Cloud

**Type:** confirmed unresolved security predicate.

**Evidence:** [delivery.md](delivery.md) leaves the local/cloud discrimination
fixture open (`:208`), while [overview.md](overview.md) promises no cloud
fallback (`:62`). Ollama documents that cloud models are invoked through the
same local app, CLI, and API, with model names such as `gemma4:cloud`:
[Ollama Cloud](https://docs.ollama.com/cloud),
[`/api/tags`](https://docs.ollama.com/api/tags), and
[`/api/chat`](https://docs.ollama.com/api/chat).

**Exploit/failure:** discovery accepts a loopback endpoint and the user selects
an entry served by Ollama Cloud. Prompts leave the machine even though Nessie
labels the lane local. A name-suffix denylist is not a security boundary and is
easy to invalidate as Ollama evolves.

**Impact:** silent cloud data processing, false product claims, and breach of
the user's explicit locality choice.

**Required correction:** before implementation, establish and fixture a
structural, version-supported predicate that proves the selected entry will be
processed locally, including real outbound-network observation. If Ollama does
not expose a reliable proof/cloud-disable control, refuse entries whose
locality cannot be proved; do not infer from a name, size, digest, or loopback
address.

### BLOCKER 4 — team-offered execution has no person-reachable authorization control

**Type:** confirmed Rule Zero/product contradiction.

**Evidence:** [authority-and-storage.md](authority-and-storage.md) gives a host
an `offeredTeamId` and permits a team member to select it (`:94` onward). None of
the 38 UI/native/CLI inventory rows lets the machine custodian choose a team,
review the audience, offer the host, withdraw the offer, or see who can request
it. The Models team policy controls model availability; it is not machine-owner
consent.

**Exploit/failure:** implementation either silently offers a newly enabled
machine to a team, guesses from ambient session/team context, or creates an API
capability no custodian can reach or revoke.

**Impact:** unauthorized cross-person host use or an unusable core v1 mode.

**Required correction:** either remove team-offered/cross-person hosts from
v1, or add one explicit host-owner control and CLI equivalent that names the
team audience, previews the data-recipient implication, and can withdraw the
offer. The state source must be a server binding to a live UOA team ID, never an
ambient session claim. This is a missing element because it enables the
concrete decisions “who may ask this machine to process data?” and “stop
offering it now.”

### BLOCKER 5 — a team host can steer another person's authorized tools

**Type:** confirmed threat-model omission.

**Evidence:** [overview.md](overview.md) and
[transport-and-execution.md](transport-and-execution.md) say local model tool
calls use the same `authorizeToolCall` path as cloud inference. That preserves
the requesting person's permission check, but it does not establish the
integrity of the model that selected the tool or arguments. The custodian
controls the unauthenticated Ollama endpoint and model bytes.

**Exploit/failure:** a malicious team custodian advertises a compatible model
that always returns a permitted “send”, “publish”, “update”, or other tool call
with attacker-chosen arguments. The victim's agent/run supplies the authority,
while the custodian supplies the decisions. The same attack works through an
innocent but compromised local daemon.

**Impact:** actions are attributed to an agent owner who never selected the
malicious model or intended those arguments. Disclosure checks alone do not
protect integrity.

**Required correction:** treat offered-host model output as adversarial input.
For v1, either limit execution to the agent owner's own host, make offered hosts
text-only with no tools, or define a host-principal-aware tool intersection and
require the requesting principal to approve every externally effective action.
The chosen rule must cover built-ins, MCP, paired-agent tools, delegated runs,
and tool-result re-entry.

### HIGH 1 — UOA outage is indistinguishable from entitlement revocation

**Type:** confirmed code/design contradiction.

**Evidence:** the plan reuses `resolveLiveEntitlements` to cancel on revocation.
[`uoa-live-entitlements.ts`](../../../packages/runtime/src/uoa-live-entitlements.ts)
catches both `UoaOrgRequestRejectedError` and
`UoaOrgRequestUnavailableError` and returns `{ kind: 'denied' }` at `:224-225`.

**Failure:** a UOA timeout or outage cancels queued/active attempts, emits a
revocation-style alert, and may require repair even though nobody's membership
changed. If a later retry treats the same state as transient, behavior differs
across replicas.

**Impact:** availability incident, misleading security UI, and an undefined
recovery path.

**Required correction:** provide a tri-state live decision—allowed, denied,
unavailable—with an explicit bounded freshness policy. Only authoritative
denial revokes. Unavailable must fail closed for new disclosure, preserve the
reason, and resume only through the documented state transition.

### HIGH 2 — the native consent boundary cannot reuse the current caller gate

**Type:** confirmed code/design contradiction.

**Evidence:** current
[`assert_approved_companion_caller`](../../../desktop/src-tauri/src/executor_companion.rs)
validates an origin but not the `main` window label, while the
[`default` capability](../../../desktop/src-tauri/capabilities/default.json)
also includes `document-*` windows. The plan requires commands to be callable
only by the
main product webview and claims reuse of an existing explicit trusted-origin
selection. Current release code admits `https://app.nessie.works` (and local
development), but has no persisted custom self-hosted webview-origin selection
that satisfies that claim.

**Exploit/failure:** XSS or a secondary document window supplies the displayed
machine/model/account fields and invokes consent. A self-hosted deployment is
either rejected or broadens the allowlist unsafely.

**Impact:** consent can be minted for a challenge or account the native human
did not actually review.

**Required correction:** new native commands must require `window.label ==
"main"`, receive only an opaque challenge ID, fetch canonical display fields
from the authenticated configured Nessie origin, verify TLS/server identity,
and bind the response to the current local machine key and signed-in custodian.
Define how a custom origin is selected, verified, rotated, and revoked; test
document windows, origin changes, sign-out, relogin, and stale challenges.

### HIGH 3 — re-pairing and machine-key rotation do not revoke old consents

**Type:** confirmed lifecycle omission.

**Evidence:** the consent digest binds a machine identity/key, but the key-loss
and secure-storage-repair flow does not state what happens to active bindings,
queued attempts, or receipts created under the previous key.

**Failure:** reinstall/re-pair produces a new key while server bindings remain
active, allowing the replacement installation to inherit consent it never
received, or allowing an old installation to return results after replacement.

**Impact:** stale authorization and replay across a machine-identity boundary.

**Required correction:** key rotation must advance an authorization epoch,
fence every old attempt/receipt, and transition each binding to
`needs_rebinding`. Reconsent must cover the exact model and effective policy;
there is no transparent inheritance.

### HIGH 4 — the settings revision check has no implementable revision or lock

**Type:** confirmed schema/service contradiction.

**Evidence:** `ScopedSetting` has timestamps but no revision.
[`writeScopedSetting`](../../../packages/runtime/src/scoped-settings.ts)
serializes writes with a target-specific advisory lock, but the proposed
confirm route does not share a specified lock or compare-and-swap token.
[authority-and-storage.md](authority-and-storage.md) nevertheless requires
atomic verification that setting revisions match (`:109-110`).

**Failure:** an administrator disables local inference or changes a locked
model policy while confirmation reads old effective settings and activates the
binding afterward.

**Impact:** policy bypass until a later reconciliation notices it.

**Required correction:** define a durable effective-policy fingerprint or
monotonic version and make setting mutation, consent confirmation, activation,
and revocation share a serialization/CAS protocol. Include all inherited
settings that affect eligibility and model selection.

### HIGH 5 — the alert proposal cannot represent or authorize the resource

**Type:** confirmed schema/design contradiction.

**Evidence:** `UserAlertKind` in
[`schema.prisma`](../../../api/prisma/schema.prisma) and the reader-first
[`alert-records.ts`](../../../packages/schemas/src/alert-records.ts) contain no
local-inference kind. `UserAlert` has no local host/binding pointer, and the
plan gives only an `eventKey`. It does not state which exact users may read a
host, binding, or affected agent.

**Failure:** a generic alert deep-links to a resource the viewer cannot read,
leaks a machine/model name, or is sent to every team editor. A writer deployed
before readers breaks mixed-version rollout.

**Impact:** information disclosure, unactionable alerts, and deployment
failure.

**Required correction:** add reader-before-writer enum rollout, a typed local
resource reference, a server-side viewer projection, exact recipient rules,
one transition key, and a route that reauthorizes before returning current
state. Notifications must contain only viewer-safe summary data.

### HIGH 6 — two promised recovery doorways do not exist

**Type:** confirmed Rule Zero/code contradiction.

**Evidence:** the plan sends people to `/agents/designer/:id?section=model`, but
[`AgentDesignerPage.tsx`](../../../admin/src/pages/AgentDesignerPage.tsx) reads
`designerSection`, and
[`AgentDesignerForm.tsx`](../../../admin/src/components/features/agents/designer/AgentDesignerForm.tsx)
has no model section. It also says a failed run reuses an existing retry/restart
UI; the API
[`restart` route](../../../api/src/routes/runs.ts) exists, but the
[run-budget standard](../../standards/tech-and-run-budgets.md) records that no
admin restart surface exists.

**Failure:** alerts and conversation errors send a person to the wrong place,
or offer a recovery action no component actually implements.

**Impact:** capability failure is visible but not repairable; the feature
fails Rule Zero.

**Required correction:** name the real navigation registry route/query and
component that consumes it, and add an actual restart action in the owning run
surface before claiming reuse. Verify Back and overlays through the navigation
framework.

### HIGH 7 — parallel loopback probing has no deterministic identity rule

**Type:** confirmed design omission.

**Evidence:** [transport-and-execution.md](transport-and-execution.md) allows a
saved/default loopback endpoint probe in parallel but specifies neither
priority nor behavior when IPv4, IPv6, and a saved port answer differently.

**Failure:** a hostile process wins a race on one address while a legitimate
Ollama answers another. Detection, test, and execution can address different
daemons, especially after sleep, restart, or port reuse.

**Impact:** prompt theft, false capability/model identity, and nondeterministic
consent.

**Required correction:** use deterministic saved-endpoint priority. If more
than one distinct endpoint responds, require an explicit local choice and bind
consent to the exact canonical socket. Revalidate the same endpoint immediately
before dispatch; never select the first racing response.

### HIGH 8 — “host manager” and “support-authorised admin” are invented authorities

**Type:** confirmed authority-model contradiction.

**Evidence:** [experience.md](experience.md) assigns executor details to a host
manager or support-authorised administrator (`:147`), but neither is a current
UOA capability, Nessie ownership rule, nor schema relation. The plan elsewhere
says no guessed role strings and no second identity authority.

**Failure:** implementation maps these phrases to organization owner/admin,
granting operational and machine detail access that the host custodian did not
delegate, or invents a local role.

**Impact:** machine metadata disclosure and violation of UOA sole authority.

**Required correction:** remove these audiences or define the exact
server-derived predicate from existing resource ownership plus live UOA
entitlement. “Support” is never an implicit bypass. Support details must be
sanitized and visible only to a principal already authorized for the resource.

### HIGH 9 — the local accepted-result journal stores content without a storage policy

**Type:** confirmed security-design omission.

**Evidence:** the executor journal retains accepted receipts and a derived
result body so a response can be retried after a lost acknowledgement. The plan
does not define encryption/protected storage, maximum result size, crash-dump
behavior, deletion after server acknowledgement, or a hard TTL.

**Failure:** tool/model output containing secrets remains on a shared machine
indefinitely or enters backups, logs, or diagnostic bundles.

**Impact:** durable local disclosure beyond the run's intended lifecycle.

**Required correction:** store the minimum replay material under OS-protected
storage (or encrypted with a non-exportable machine key), cap it independently
of frame size, never log it, delete it immediately after durable server ACK,
and enforce a short hard TTL. Test crash-before-ACK and secure-store failure.

### HIGH 10 — rollback covers binaries, not persisted local selections

**Type:** confirmed deployment omission.

**Evidence:** [delivery.md](delivery.md) says rollback drains/disables new work
and restores binaries (`:101`), but an old API/worker does not understand an
agent/run pinned to a local binding, new enum values, or a new alert kind.

**Failure:** an old version edits a local-pinned agent as if its legacy provider
fields were authoritative, queues a cloud lane, or crashes reading new state.

**Impact:** silent cloud/cross-device fallback, corrupt selection, or outage
during rollback.

**Required correction:** specify expand/contract migrations, reader-before-
writer deployment, old-version write fences, and a feature disable that keeps
local-pinned agents non-runnable rather than rerouting them. Test a rolling
downgrade with persisted active bindings and queued attempts.

### MEDIUM 1 — `numCtx` has no clear authority owner

The binding digest includes a context limit, but the Designer editor appears to
choose it while the custodian supplies compute. Decide whether it is an agent
preference or a host resource cap, show both effective values where the person
can act, and require renewed consent when the digested effective value changes.

### MEDIUM 2 — server disconnect and local forget are not one operation

The Connections row combines “disconnect/forget,” but an offline remote server
cannot erase the machine's key and a local forget cannot prove server
revocation. Present two truthful actions: revoke the server relationship, and
delete this installation's local key/state. Each reports partial completion and
the remaining remediation.

### MEDIUM 3 — inventory can consume roughly 12.8 MiB before envelope overhead

The stated cap of 100 models with 128 KiB per metadata entry permits about
12.8 MiB, inconsistent with a narrow control lane and vulnerable to memory/
rendering pressure. Paginate inventory independently of heartbeat, cap the
aggregate decoded size, validate strings/control characters, and never place
inventory in signed presence heartbeats.

### MEDIUM 4 — capability smoke tests could execute a hostile tool request

The bounded smoke test must use a synthetic no-op schema, inspect the returned
tool-call shape, and discard it. It must never pass the returned call into
`authorizeToolCall` or a real tool runner. Capability output remains host-
asserted even after a successful smoke.

### MEDIUM 5 — delegated child runs need an explicit pinning integration

Current [`subtask-tools.ts`](../../../worker/src/run/subtask-tools.ts) creates a
durable child `Agent` and copies legacy provider/model fields; it has no local
binding pointer. The plan correctly says the inherited grant is run-scoped,
but does not name the code seam that prevents the durable child row from later
acquiring that authority. Pin the child `Run`, not the child Agent, and test
that later independent runs cannot reuse the parent's host grant.

### MEDIUM 6 — digest and capability labels are attestations only by the host

The machine signature proves which executor made a claim, not the integrity of
model files, Ollama, or hardware capabilities. The existing
[`ollama-client.ts`](../../../executor/src/ollama-client.ts) already records
that any process binding the port can impersonate Ollama. UI and documentation
must say
“reported by this computer” and “last tested,” not “verified,” “attested
model,” or equivalent. Security decisions may bind an exact reported digest to
consent, but cannot treat the digest as trusted code provenance.

### MEDIUM 7 — WSL/manual-endpoint guidance conflicts with loopback-only policy

The plan suggests that unreachable WSL needs a manual endpoint, while the same
plan rejects non-loopback endpoints. A WSL address is normally not host
loopback. Either document an explicit user-created loopback forward with its
security consequences or state that this topology is unsupported. Do not
silently broaden LAN binding.

### MEDIUM 8 — alert recipients are not defined

“Affected editors/custodians” is not an executable rule. Define one recipient
set per transition: the agent owner/editor for agent selection failure, the
machine custodian for local endpoint/key failure, and explicitly authorized
team policy administrators for policy failure. Do not notify every team member
or derive recipients from an ambient session.

### LOW 1 — client clocks must not decide whether presence is fresh

The UI needs age to support the decision to wait or repair, but laptop clock
skew can make an expired lease look current. Return a server-computed state
with server time/expiry metadata, and use the client clock only for a cosmetic
countdown that cannot turn unknown/offline into available.

### LOW 2 — all host-reported display strings are hostile

Model names, endpoint labels, version strings, and error details can contain
control characters or huge Unicode sequences. Normalize, length-cap, escape,
and redact them before storage, logs, alerts, support copy, or UI. This does not
make the claim trusted; it only prevents display/log spoofing.

### Controls that should survive reconciliation

No contradiction was found in the plan's literal-loopback/no-redirect rule,
explicit rejection of LAN/public/DNS-resolved endpoints, run-pinned host/model
identity, one accepted result per attempt, bounded one-in-flight capacity, or
the explicit ban on silent cloud/device fallback. The organization → explicit
work team → person setting precedence is also clearly specified. These are
important constraints to retain; the findings above concern missing commit,
authority, evidence, and lifecycle semantics around them.

## Abuse-case table

| # | Actor and precondition | Abuse/failure | Required defense |
|---|---|---|---|
| 1 | Local process or malicious custodian can bind loopback | Fake Ollama steals prompts and returns forged tool calls | Exact endpoint binding, hostile-model tool policy, no cross-person tool authority |
| 2 | Legitimate loopback Ollama exposes a cloud entry | Prompt silently runs in Ollama Cloud | Structural local-only proof or reject unprovable entries; outbound-network fixture |
| 3 | New reader omits `ConsumedSourceSink` | Empty basis is treated as unrestricted and exported | Complete prompt provenance type; fail closed on any unclassified component |
| 4 | Compromised webview/document window | Supplies friendly display fields and mints consent | Main-window check; opaque challenge; native canonical fetch and account binding |
| 5 | Admin changes inherited setting during confirmation | Old snapshot activates a now-forbidden binding | Shared policy version/lock and transactional CAS |
| 6 | UOA returns timeout/503 | Availability loss is treated as membership revocation | Allowed/denied/unavailable states with bounded freshness |
| 7 | Installation is repaired/re-paired | New key inherits old binding; old key can complete work | Authorization epoch, attempt fencing, mandatory reconsent |
| 8 | IPv4 and IPv6 ports answer as different daemons | First response wins and later execution changes peer | Deterministic priority; explicit conflict choice; canonical socket pin |
| 9 | Executor accepts work; response/ACK is lost | Retry duplicates inference or downstream tool effects | Attempt idempotency, result hash/receipt, one server commit, no tool replay |
| 10 | App sleeps or network partitions | Stale green presence persuades editor to start work | Expiring lease, unknown state, attempt deadline, actionable transition alert |
| 11 | Host returns huge/chunked/compressed JSON slowly | Memory/CPU exhaustion blocks control lane | Aggregate decoded caps, deadlines, compression policy, streaming parser limits |
| 12 | Deployment rolls back with active local rows | Old code reroutes, overwrites, or cannot deserialize | Reader-first schema, old-writer fence, non-fallback disabled state |

## Complete 38-element decision audit

`KEEP` means the element enables a necessary decision and has the right owning
surface. `CHANGE` means it is necessary but its audience, truth source, or
remediation is wrong. `BLOCKED` means it must not ship until the named protocol
or product defect is resolved. “Omit” is used where omission is safer than
presenting a control the product cannot honor.

| # | Element | Result | Decision/action, audience, truth, remediation, duplication |
|---|---|---|---|
| 1 | Designer “Local Ollama” option/unavailable state | CHANGE | Enables the agent editor to choose a lane. Eligibility must come from effective server settings plus live entitlement; unavailable must name the exact owner/action, not imply the editor can override it. Keep in the existing model control, not a new selector. |
| 2 | Computer selector | KEEP | Enables an editor to choose among multiple consented hosts. Show only hosts the current principal is entitled to use; state comes from server bindings plus an unexpired presence lease. Name the custodian/data recipient without exposing unrelated machine metadata. Omit when exactly one eligible host exists. |
| 3 | Installed-model selector | KEEP | Enables selection of one model on the chosen host. Source is a fresh, bounded executor inventory tied to that host lease and reported digest. Do not merge it with catalog/cloud models. |
| 4 | Incompatible reason | CHANGE | Enables selection of a compatible alternative. Compatibility is host-reported plus a smoke-test result, not proof of safety. Give a specific remedy (refresh, update, choose another); omit speculative reasons. |
| 5 | “Find Ollama” | KEEP | Explicitly starts discovery for the current machine. It belongs beside the unavailable local option and is user-initiated; it must not install, start, expose, or reconfigure a daemon. |
| 6 | Bounded progress and Cancel | CHANGE | Lets the local custodian stop discovery/test work. Cancel must abort network/model work and remove pending server preparation, not just hide the dialog. State is native task state with a hard deadline. |
| 7 | Native consent “Use/Cancel” | BLOCKED | Enables custodian consent, but only if native fetches canonical challenge data by opaque ID and verifies origin/account. Webview-provided display fields are not truthful. Cancel must record/return a terminal rejection without changing agent selection. |
| 8 | Existing Save/test result | BLOCKED | Enables the editor's final commit, but conflicts with confirmation as commit owner. Keep one existing Save only after the protocol makes it the sole CAS activation action; test state must identify exact host/model/digest and expiry. |
| 9 | Data-boundary sentence | CHANGE | Enables an informed editor/custodian choice. It must say that Nessie's server still assembles/sees prompts and that classifier/judge/memory paths may remain cloud where true; “runs on your computer” alone is materially incomplete. One contextual sentence, not repeated marketing copy. |
| 10 | Pending consent/Cancel | KEEP | Lets the editor see that no lane is active and abandon the prepared request. Truth comes from a server pending-binding state with expiry; cancellation must invalidate the challenge. |
| 11 | Advanced loopback port | CHANGE | Enables the machine custodian to reach a non-default local daemon. A remote editor must not choose another person's endpoint. Put it in the local host repair flow; validate canonical loopback only and show which endpoint was actually bound. |
| 12 | Advanced context limit | CHANGE | Enables a resource/quality tradeoff, but authority is unresolved. Show it only to the principal who controls the resource, derive an effective value against host cap, and reconfirm when the consent digest changes. Omit until ownership is decided. |
| 13 | “Open Ollama” | KEEP | Lets the local custodian start/inspect an installed app after an explicit click. Truth source is verified registered-app identity, not a path guess. Never auto-launch. |
| 14 | Official install link | KEEP | Lets the custodian obtain missing software. Use an allowlisted HTTPS vendor URL and external browser; do not download/install automatically. |
| 15 | Retry/Refresh | CHANGE | Retry discovery/test and refresh inventory are different actions with different state. Label separately and preserve the last specific failure. Neither bypasses consent, policy, or local-only checks. |
| 16 | “Use updated model” | CHANGE | Lets the editor accept a changed digest, but a different custodian must reconfirm the new bytes/capability contract. Never auto-adopt. If editor and custodian are the same person, still show the exact change once. |
| 17 | Active-connection message | CHANGE | Helps decide whether to reconfigure a port. It may truthfully state that this Nessie installation is bound to one endpoint, not that Ollama or the whole machine has only one connection. Source is current native binding. |
| 18 | Connections current row | KEEP | Gives the custodian a home for machine relationship, endpoint, last lease, and repair. Viewer is the local custodian/resource-authorized principal; redact secrets and unrelated users. |
| 19 | Pause/resume | KEEP | Lets the custodian temporarily stop accepting work without destroying consent. Source is a server desired state plus executor acknowledgement; show “pending/unknown” during partition and fence new claims immediately. |
| 20 | Disconnect/forget | CHANGE | Split server revoke from local key/state deletion. Each action names what it can complete offline and what remains; never claim remote deletion based only on local success. |
| 21 | Secure-storage repair | KEEP | Lets the local custodian recover from key loss. It must explain that all bindings need reconsent, rotate the authorization epoch, and never preserve green availability during repair. |
| 22 | Models target | BLOCKED | Lets a team policy administrator enable local inference, but is not a host-sharing control. Keep as the policy home only after team-offer consent gets its own custodian action. Source is effective scoped setting, not current session. |
| 23 | Enable control and lock | KEEP | Enables authorized policy administrators to permit/forbid the mode and higher scopes to lock it. Reuse `ScopedSettingGate`; add CAS/version behavior and exact inherited source. |
| 24 | Inherited-lock explanation | CHANGE | Explains why a policy administrator cannot edit. Ordinary affected users are never editors even when no lock exists, so `ScopedSettingGate`'s lock-only `canEdit` is insufficient; derive edit authority separately and name the scope owner who can act. |
| 25 | Members doorway | KEEP | Enables an administrator considering access to reach model policy in context. It is a link/badge, not a second policy editor; show only to viewers authorized for that target. |
| 26 | Team doorway | KEEP | Enables a team administrator to reach the same Models surface. Reuse the same navigation target/component; no duplicate toggle. |
| 27 | Avatar availability badge | CHANGE | Enables a participant to decide whether to wait or repair before messaging an affected agent. State must be run-route availability derived from lease + binding + policy, age out to unknown, and not mark cloud agents/local nonselected agents green by accident. Reuse `IdentityTile`. |
| 28 | Designer header state/repair | CHANGE | Enables the owner/editor to repair the selected lane. Use the actual navigation-registry route and `designerSection` contract; current proposed `section=model` target is false. |
| 29 | Conversation wait/cancel/retry | BLOCKED | Enables a participant to manage a blocked/failed run. Cancel can use run lifecycle state, but retry/restart has no current admin UI. Add a real authorized action in the run/conversation surface and ensure idempotent restart; do not claim reuse. |
| 30 | Alert | BLOCKED | Enables the right person to repair a capability transition. Requires a real enum, resource reference, recipient predicate, viewer-safe projection, and working deep link. Omit rather than emit generic/leaky notices. |
| 31 | Executor detail section | CHANGE | Enables the custodian to diagnose host health. “Host administrator” must resolve to the custodian/resource predicate or be removed. Show server-derived health and locally reported facts separately; no content, tokens, prompts, or other users. |
| 32 | Menu toggle/consent | CHANGE | Enabling hosting and consenting to one binding are two decisions. They may share the native shell but cannot share one toggle or implied semantics. Each must show audience and consequence. |
| 33 | Menu status/remedy | KEEP | Enables the local custodian to act on disconnected, paused, missing-daemon, key-loss, or policy-revoked states. Source must distinguish local probe from server lease and give one state-specific remedy. |
| 34 | Menu pause/resume | KEEP | Enables immediate local control. It must fence claims locally even offline, then reconcile server desired state without silently resuming. Do not duplicate it as a different state machine from Connections. |
| 35 | Menu deep link | KEEP | Lets the custodian reach the canonical Connections detail. Use navigation/origin validation and no embedded secret. It is a doorway, not another editor. |
| 36 | CLI discover/enable/consent/pause/resume/forget | BLOCKED | These are six distinct actions, not one element. `discover` before explicit discovery consent conflicts with the plan; `consent` needs a way to list/show a pending challenge; and no `status` command lets a headless user decide what to repair. Specify each confirmation, canonical server origin/account, machine-readable status, idempotency, and partial failure. Add `status`/pending-list or omit headless support from v1. |
| 37 | Support details | CHANGE | Enables an authorized custodian to share a sanitized diagnostic ID/state. There is no support-authorised role. Permit copy only to the resource owner/live-entitled administrator, strip prompts/results/tokens/paths, and never grant support an implicit read. |
| 38 | Browser-only doorway | KEEP | Enables a person without native commands to understand the prerequisite and reach supported download/setup guidance. It must not pretend the browser can test/consent, and should disappear once an eligible native host is present. |

### Missing elements justified by a concrete decision

Only two missing controls are required rather than merely desirable:

1. **Offer/withdraw this host to a named team.** The machine custodian needs to
   decide who may ask the computer to receive data. This is required only if
   cross-person/team-host mode remains in v1; otherwise omit that mode.
2. **CLI/native status and pending-consent list.** A headless Linux custodian
   needs to decide which request to approve and which failure to repair. If the
   product drops headless support from v1, omit these controls instead.

## Friendly autodetection assessment

The intended flow is appropriately conservative in several respects: it starts
from an explicit **Find Ollama**, proposes rather than installs, requires an
explicit native consent, and does not auto-update a changed model. Preselecting
the sole eligible model is acceptable because it does not commit it.

It is not yet safe or reliably low-effort as written:

- Parallel endpoint probing can nondeterministically select the wrong daemon.
- The flow cannot truthfully exclude Ollama Cloud.
- Native consent currently has no canonical-fetch/session-binding contract.
- “Open Ollama” lacks a complete signed/registered-app verification rule on all
  three operating systems.
- The CLI verbs imply discovery can occur before the required consent and give
  a headless user no status/pending-request view.
- A model update, port change, re-pair, or policy change has no single
  deterministic transition back through reconsent.

Autodetection must remain observation-only. It may probe loopback after the
person starts discovery, read bounded version/tags metadata, and suggest the
result. It may not install, launch, expose a LAN port, add a firewall rule,
create a proxy/WSL forward, change Ollama cloud/login state, select a host for a
team, or activate an agent lane. Each security-sensitive change needs the
specific decision element identified in the matrix.

## Open questions that must be answered in the design

These are not counted as confirmed defects where the plan deliberately leaves
choice open, but implementation must not guess:

1. Is cross-person/team-host use actually required in v1? Removing it also
   removes the most dangerous model-integrity and sharing UI problems.
2. Which exact UOA capability authorizes organization/team local-inference
   policy? Current `resolveLiveEntitlements` exposes organization role and team
   IDs, not a named local-inference capability; guessed role strings are banned.
3. Who is the machine resource owner after device replacement or account
   removal, and can ownership transfer without importing old consent?
4. What exact, versioned Ollama response or configuration proves local-only
   processing?
5. Which single action commits the local lane: editor Save or custodian confirm?
6. Does the editor or custodian own context-limit decisions, and how are host
   caps represented?
7. How is a self-hosted Nessie origin selected, verified, and revoked by the
   signed desktop app without accepting arbitrary web content?
8. Which direct macOS distribution contains the executor, and how do packaged
   Node/runtime differences affect the stated Windows/Linux/macOS parity?
9. What exact stale-entitlement policy applies while UOA is unavailable?

## Suggested non-blocking improvements

- Prefer an own-host-only first release. It preserves the local inference value
  while reducing UOA recipient checks, malicious-custodian tool authority, and
  team-offer product surface.
- Add a compact “last checked” timestamp only where it changes a decision;
  avoid a generic telemetry dashboard. Detailed operational metrics belong in
  operator observability, not member-facing UI.
- Use opaque support/event identifiers that join server logs without exposing
  machine paths, hostnames, model prompts, or model output.

## Required implementation stop-ship checklist

Implementation must not begin beyond disposable protocol spikes until all of
the following are present in the reconciled design:

- [ ] Complete, fail-closed provenance for every provider prompt component.
- [ ] One transaction/CAS owner for preparation, native consent, and agent Save.
- [ ] A tested structural local-only predicate that excludes Ollama Cloud.
- [ ] A decision to remove team-offered hosts from v1 or a reachable
      offer/withdraw control with live UOA audience semantics.
- [ ] A malicious-host tool-authority rule covering every built-in/MCP/tool and
      delegated run.
- [ ] Allowed/denied/unavailable UOA states and recovery behavior.
- [ ] Native main-window, canonical-challenge, configured-origin, account, and
      session binding.
- [ ] Authorization epoch rotation and fencing for re-pair/key loss.
- [ ] Effective scoped-setting version/CAS shared by policy writes and confirm.
- [ ] Reader-first alert schema, resource authorization, recipients, and real
      recovery routes/actions.
- [ ] Deterministic endpoint conflict resolution and exact socket binding.
- [ ] Mixed-version rollout/rollback behavior that can never fall back to cloud
      or another device.
- [ ] Protected, bounded, expiring local result receipts.
- [ ] A complete headless CLI status/consent flow, or removal of headless/Linux
      CLI support from v1 scope.

## Missing tests and durable evaluations

The delivery matrix is broad but does not exercise the boundaries most likely
to fail. Add these before enabling the feature:

- A prompt-source adapter intentionally omits its disclosure sink contribution;
  dispatch must fail before bytes enter an executor frame.
- A validly signed offered host returns malicious tool calls for every tool
  category; no unapproved side effect occurs.
- A real Ollama cloud entry is visible through a loopback daemon while outbound
  traffic is observed; Nessie rejects it.
- UOA 401/403 denial, 429, timeout, malformed response, and 5xx produce distinct
  state transitions and no unauthorized dispatch.
- Editor Save, custodian confirm, editor cancel, challenge expiry, and policy
  disable race under multiple API replicas; only one exact result commits.
- Machine re-pair/key rotation while attempts are queued/accepted; all old
  epochs are fenced and all bindings require consent.
- IPv4, IPv6, saved port, and default port answer with different model sets;
  discovery never chooses by response timing.
- A secondary document webview, untrusted origin, sign-out/relogin, and custom
  self-hosted origin all attempt native consent.
- CLI-only Linux setup lists pending challenges, shows canonical server/account,
  rejects stale input, reports status, and recovers from partial disconnect.
- Reader-before-writer and writer-before-old-reader deployment tests for every
  new enum/table/alert payload, followed by rollback with active local agents.
- Crash before/after result receipt, lost ACK, duplicate delivery, cancellation
  during generation, and TTL cleanup verify exactly one server result and no
  retained plaintext.
- Slowloris, oversized chunked/compressed JSON, invalid UTF-8, control
  characters in model names, and aggregate inventory limits cannot starve the
  control lane.
- The smoke-test model requests a real tool; no tool is executed.
- Sleep/wake, endpoint process replacement, model deletion/update during a run,
  and a multi-device editor/custodian partition all age presence to unknown and
  surface one actionable transition.
- Browser tests exercise the actual navigation registry, Back behavior, alert
  deep link, Designer section, Connections repair, and real conversation
  restart action. Visual checks must cover each audience, not only an owner.

## Final verdict

**REJECT.** The plan is not safe to hand to implementation while disclosure
evidence can fail open, the custodian/editor commit point is contradictory,
locality cannot exclude Ollama Cloud, team sharing has no owning control, and a
host can steer another person's tools. Reconcile those five blockers first,
then the high-severity entitlement, native-boundary, lifecycle, alert,
navigation, storage, and rollback contradictions. A narrower own-host-only,
tool-restricted v1 would be materially easier to make approvable without
weakening Nessie's UOA or disclosure invariants.
