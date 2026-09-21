# Local Ollama agents

An existing person-owned agent may pin its generative lane to an Ollama model
running on that same person's computer. The host connects through a paired
executor or the signed Nessie Desktop application. The worker remains the
agent runtime: it assembles context, enforces disclosure, authorizes tools,
records usage and writes conversation state. A local host is only an inference
processor.

The complete design and decision inventory live in
[`docs/plans/2026-09-20-local-ollama-agents/`](../plans/2026-09-20-local-ollama-agents/overview.md).
The rules below are the standing implementation contract.

## Authority and scope

- V1 is owner-host-only. The agent owner, host custodian and UOA subject are
  the same person. A team policy lets each enabled member use their own host;
  it never offers one member's computer to another.
- Local inference uses the ordinary typed setting cascade. Organisation
  owners/admins may enable an organisation, team or person. Enabling only
  permits setup: it does not discover a machine, select a model, grant host
  access or activate an agent.
- UOA remains the authority for identity, organisation and team membership.
  Allowed, denied and unavailable are distinct live decisions. Unavailable
  fails closed for new disclosure without fabricating a revocation.
- Only a person-owned, non-system agent may use a local binding. Ownership,
  policy or key changes fence the binding and every older host epoch.

## Selection and consent

- Discovery is read-only, user-initiated and limited to canonical literal
  loopback Ollama endpoints. It may observe version, tags and model metadata;
  it never starts Ollama, scans a LAN, downloads or alters a model, changes
  firewall/proxy settings, or follows a server-supplied URL.
- A selectable model has a non-empty observed manifest digest, local model
  metadata and empty official Ollama `remote_host` and `remote_model` markers.
  The same locality and digest checks run again immediately before and after
  generation. Unknown locality is ineligible; a tag name is never proof.
- Native or executor consent approves one exact inactive tuple: origin,
  organisation, custodian, machine key/epoch, agent, model name, manifest
  digest and policy version. The existing Agent Designer **Save** is the only
  activation action and revalidates that tuple transactionally.
- A browser can manage an already paired executor and show setup doorways, but
  it cannot impersonate machine consent or scan the browser host.

## Execution and storage

- A local binding is a fail-closed third inference lane. Main generations and
  generative utility calls stay on the exact run pin. Offline, revoked,
  overloaded or failed local inference never falls back to a cloud model.
- Every provider-input component carries closed provenance. An unclassified
  component prevents attempt persistence and delivery. Recipient entitlement
  is re-read at dispatch; an empty disclosure basis is not sufficient proof.
- Attempts, frames and receipts are bounded, encrypted at rest, deadline- and
  epoch-fenced, idempotent across retries and deleted after the documented
  retention window. The host polls an authenticated control lane while Ollama
  is active so cancel, expiry and fencing abort a blocked local request.
- Local text uses the same disclosure gate, secret redaction and durable final
  message path as hosted inference. Stream frames are ordered and acknowledged;
  the final receipt must not duplicate already streamed text.
- Model-returned tool calls are hostile input. They use invocation-scoped IDs
  and enter the ordinary schema, authorization, approval and effect-ledger
  path. The host never receives a tool credential or executes a Nessie tool.
- Usage is recorded as `local_device` with stable invocation identity and no
  currency cost. Token, tool, time and paid-tool gates still apply.

## Presence and surfaces

- Desktop and paired executors under the same OS account use one owner-private
  coordinator at `~/.nessie/local-inference`. Its Ed25519 resource key is signed
  into each authenticated host enrollment. The shared physical resource is
  scoped to one Nessie organisation and custodian in v1; a second organisation
  cannot enroll the same key as another pool.
- Server admissions lock the shared resource row. Ordinary generations, utility
  calls and task-set item reservations all count against capacity, initially
  one. Owner controls may set 1–16 slots; lowering the limit drains existing
  reservations. Host Pause/Resume applies to the whole resource. Local
  `local-inference pause` persists before contacting the server, and resume
  remains pending until an authenticated acknowledgement arrives.
- Physical slots never expire. A process exit or an aborted HTTP request does
  not prove Ollama stopped generating. Such slots report `termination_uncertain`
  and admit nothing further. After independently confirming that generation
  stopped, the owner can run `local-inference confirm-stopped
  --confirm-ollama-stopped`; persisted terminal proofs must still be acknowledged
  before a slot is reused. Resume alone cannot discard an uncertain call.
- Poll tokens are written before dispatch and stored uniquely on the attempt.
  A transport recovering a never-started poll asks for that same attempt and
  admission; it cannot choose the next row because a response was interrupted.
  A paused replay returns its fence only for settlement, never for invocation.
  Completed encrypted receipts replay independently before new work is polled.
- Both updated server and native runtime are required. A host without its shared
  resource enrollment cannot poll for inference work.

- Availability is a separate server-derived `online | offline | unknown`
  lease. It never reuses human presence or the agent activity state. A busy
  reachable model remains online; stale or unverifiable authority is unknown.
- The owning surfaces are Agent Designer → Model and Settings → Connected
  accounts. Contextual doorways are agent list/detail availability, scoped
  Models/Team/Member settings and the paired Executor detail.
- Host status and Pause/Resume/Revoke are one shared component parameterized by
  host scope. Only the owner gets a Repair doorway for an owner-host binding.
- Every visible or executor-facing element must map to a row in
  [`experience.md`](../plans/2026-09-20-local-ollama-agents/experience.md),
  naming its audience, decision, truth source and omission cost. An element
  without such a decision is removed; a required decision without a doorway is
  unfinished.

## Verification

Run the focused commands and inspect the screenshots recorded in
[`docs/testing/local-ollama-agents.md`](../testing/local-ollama-agents.md).
The release gate includes browser states, exact consent/Save behavior, policy
precedence, local/cloud discrimination, cancellation during a blocked stream,
receipt replay/expiry, malicious tool output, no cloud provider lookup and a
real bounded product-path prompt against an already installed model. Never
pull, delete, update or stop a person's Ollama installation for verification.
