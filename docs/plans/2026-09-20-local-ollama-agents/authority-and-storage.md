# Authority and storage

Part of [Local Ollama agents](overview.md).

## Terms and invariants

**Agent** is the existing `Agent` identity. **Host** is one consented inference
bridge installation, bound to one organisation and a human custodian's stable
Nessie/UOA subject reference. **Transport** is `executor` or `desktop`.
**Binding** is the selected agent → host → model relationship. **Attempt** is
one generative provider invocation within an ordinary `Run`.

The human owns or administers the computer; the agent never signs in as that
human. No host is a `User`, `UserPresence`, UOA member or special system agent.
Organisation/team ids are references to existing entities, not a replicated
directory. Profile names, emails, avatars, membership and roles are not stored
on any new row. The host label is a user-chosen product label, not an imported
OS hostname. Local state lives in protected platform application data outside
all worktrees, following [local state](../../standards/local-state.md).

## Enablement cascade

Use `ScopedSetting` and `resolveScopedSetting` for the new typed key
`inference.localAgents.enabled` (boolean; default **false**). Organisation →
the explicit work team → the person; the most specific value wins until the
first lock. Null with a lock pins the preceding value. Return `setAtScope` and
`lockedAtScope`, rendered by `ScopedSettingGate`.

This key is **admin-authored**, including its person row. Extend the existing
scoped-setting service with key-specific schema and writer authority before
exposing it. The current `PUT /api/settings/scoped/:key` lets a person write
arbitrary personal keys and cannot administer a different person's value. Add
an optional `userId` target only for registered admin-authored keys and live
organisation managers; reject self-writes by non-admins for this key. The
generic route, PA tools and all internal entry points must share that service
gate. Unknown-key writes must not bypass a protected namespace. This is a
focused capability change, not an alternate settings table or resolver.

In a UOA-bound tenant, writers and target membership resolve through
`resolveLiveEntitlements` / the UOA API-backed organisation boundary. Do not
copy `scoped-settings.ts`'s current durable-role lookup or derive authority from
session team. The retained membership rows called out in
[team-model](../../standards/team-model.md) are a migration gap, not permission
to extend their authority. Unbound tenants keep their local membership rules.
Organisation owners/admins can enable users or teams. A UOA team-management
role alone does not gain this Nessie inference policy power in the first
release; adding a team-only administrator would require an explicit verified
UOA capability mapping, not a guessed role string.

| Stored decisions | Effective result |
| --- | --- |
| No rows | Disabled |
| Team A = true, person absent | Enabled for work in Team A only |
| Team A = true; person = false | Disabled for that person in Team A |
| Person = true; Team B absent | Enabled for that person in Team B |
| Team B = false, locked; person = true | Disabled in Team B; lock named |
| Organisation = false, locked; anything below | Disabled everywhere |
| Organisation = true; team has null + locked | Enabled; person override inert |

For a person-owned agent resolve the agent owner's capability, not the sender's
or whichever administrator is editing it. The work team is the destination
channel/project's verified team for a run; on selection it is the agent's
explicit placement team. A cross-team run rechecks that destination team, so
an enabled home team cannot smuggle a disabled team's work onto a laptop.
A team-owned agent resolves organisation → its actual destination team,
without a person level; an editor cannot lend it their personal enablement.
An org-wide channel or owner-only home without a genuine work team skips the
team level. Ambiguous legacy project/team placement fails with a repair reason;
never pick the session team. Lists use all eligible bindings and explicit
filters, not the currently selected team as a hidden filter.

The older offload proposal's `inference.local = forbidden`, if implemented,
is an additional hard local-egress denial resolved through the same cascade.
Its `allowed` or `required_for_local_sources` does not enable whole agents.
This separation distinguishes permission to use a local lane from policy for
the separate host-source delegation feature.

Changing a permission to false is an authorization revocation: deny new
dispatches and cancel outstanding local attempts. It is deliberately stricter
than Organization → Models' *selectability* switch, under which existing
Ledger pins continue. Do not reuse `InferenceModel.enabled` for local consent.

## Binding authority and host consent

Normal agent edit rules apply first: `assertAgentFieldAuthority`, private
owner-only visibility, system-managed immutability, no deleted agents.
System-managed/global/PA agents are excluded because their singleton ownership
and multiple private homes cannot be pinned to one member's computer. Ordinary
shared and private agents are supported, including existing agents.

An editor chooses only a host that has granted use for that exact agent and
organisation, or starts a pending consent request to such a visible host.
Private agents use their owner's own host only. Team-owned and person-owned
shared agents may use a team-offered host in the same team after the custodian
accepts that agent. Organisation management never reveals a private agent or
its binding to another person. Team enablement grants no host automatically.

Consent names the Nessie origin, organisation, agent, selected model, the scope
of conversational content sent for processing, and whether it works while the
executor runs independently of Desktop. The custodian confirms locally. A
server-side agent edit cannot fabricate this consent. Reuse executor reviewed
policy/confirmation mechanics for the relay host, with an inference-only
section and exact agent/model consent; local inference is **not** a
model-facing executor operation and a whole-suite tool grant does not add it.
Conversely, inference permission does not grant files, shell, browser or MCP.

Two-phase setup: the server prepares a short-lived binding challenge containing
the exact selection and digest; the local surface displays it and signs consent
with its machine key; the server atomically activates it only if agent ownership,
edit authority, setting revisions, host policy and model inventory still match.
Cancel/expiry leaves no active selection. Challenge TTL is five minutes.
The preparation retains the editor's stable subject/credential epoch as
product authorization provenance. Host confirmation rechecks that editor's
live authority through the supported stored-identity boundary; it does not
reuse an expired browser session or treat the custodian as the editor.
For the direct host the desktop user must be the current authenticated custodian.
On an executor the existing owner-local controls handle consent; an editor
elsewhere sees a pending state and can cancel it, not approve as the custodian.

Ownership transfer, release to team ownership, cloning and import **strip active
local consent**. Keep an explicit `needs_rebinding` local selection on an
existing transferred agent so it cannot silently use the deployment model;
the normal ownership change may complete but subsequent runs fail closed.
A clone is created unconfigured and cannot run until a model is selected.
Deletion revokes bindings and attempts in the existing agent-delete transaction.
Host pause, unpair, policy revocation and custodian membership/epoch loss also
fence dispatch. A new login cannot restore a revoked grant. Editing a prompt
without changing a valid selection does not require re-pairing.

## The receiving computer's authority

Local inference exposes prompt bytes to software and administrators on that
computer. Transport encryption does not hide them from the custodian. Therefore
before **each** inference call, including compaction and resumed checkpoints:

1. Revalidate agent/run placement and current local entitlement. Resolve the
   custodian's live UOA identity with the explicit stored-identity background
   path and epoch checks; never a copied role or timeless pairing assertion.
2. The custodian must be entitled to every source in the assembled prompt's
   `ConsumedSourceSink` basis, including transitive memory, documents,
   attachments, tool results and checkpoint material. The ordinary
   `computeReplyBasis` subtraction is not sufficient: the host needs the full
   consumed basis, before the destination's implied scopes are removed.
3. Private-conversation lineage cannot be exported to another person's computer
   on an agent owner's consent. The first release refuses such a dispatch if
   any known private source author differs from the custodian or lineage is
   unknown. Do not reinterpret an existing message-sharing grant as model-host
   consent. This limitation is explicit at setup and produces `source_not_allowed`
   with a safe remedy; exact-content multi-author export is future work.
4. Send only the model input and authorised tool schemas. Secrets already
   protected by run assembly stay protected; redact detected secrets at the
   same connector boundary, but never treat redaction as authorization.

The full basis is retained for gate evaluation before prompt bytes enter the
delivery store. Device frames never carry readable source identifiers. A tool
read may increase the basis mid-run; the following inference must refuse the
new payload if the custodian cannot read it. Do not retry that refusal with a
different host or cloud route. Reuse existing reply disclosure for all output,
thinking and live document streams; host-generated metadata is untrusted too.

## Proposed database changes

Names below are concrete implementation targets, not existing models. Use
composite organisation/id foreign keys and CHECK constraints wherever ids can
cross tenant boundaries. Durable records contain product policy/provenance,
not UOA-owned identity facts. All timestamps used for leases are server time.

| Model/change | Essential fields and constraints |
| --- | --- |
| `LocalInferenceHost` | `id`, `organizationId`, `custodianUserId` stable reference, `transport`, nullable unique `executorId`, desktop public key/fingerprint only for desktop, display label, optional offered `teamId`, `authorizationRevision`, `connectionEpoch`, `policyRevision`, `lastSeenAt`, bounded per-purpose message sequence state, nullable bounded inventory JSON + observation time, `pausedAt`, `revokedAt`, health reason/revision. CHECK exactly one transport authority; executor hosts derive key/lifecycle from their existing executor, never copy them. |
| `AgentLocalInferenceBinding` | `id`, `organizationId`, `agentId`, `hostId`, model name, manifest digest, observed capability snapshot/hash, `numCtx`, `revision`, `consentDigest`, consent author/reference and time, status `pending/active/needs_rebinding/revoked`, typed reason. Partial unique active binding per agent; historical rows retained. Composite FKs prove organisation equality; service enforces owner/team and live entitlement. |
| `Agent.localInferenceBindingId` | Nullable explicit selection; mutually exclusive with `modelSubscriptionId` and `routingProfileId`. `provider = local/ollama` is a fail-closed namespace guard, not the routing authority; `model` is display/selection metadata. Dangling/revoked pointer remains unavailable, never default inference. |
| `LocalInferenceChallenge` | Hashed one-time pairing/consent challenge, purpose, host and binding ids, exact subject digest, expiry/consumed time. Unique digest. Claim and epoch/consent update in one transaction. Executor connection handshake stays in its existing table. |
| `Run` local pin | Binding id/revision, host id, model digest, capability snapshot, `numCtx`, consent/policy revision and lane `local_device`; immutable after admission. No URLs or credentials. Keep historical pin fields after revocation for audit. |
| `LocalInferenceAttempt` | Unique `invocationId`, `runId`, org/host/binding references, run executor fence, host epoch, request digest, state, dispatch fence, lease/absolute deadlines, accepted/started/terminal timestamps, encrypted request/result, result digest, terminal usage and failure reason. One active attempt per run stage; CAS drives all transitions. |
| `LocalInferenceFrame` | `(attemptId, dispatchFence, sequence)` unique; encrypted bounded delta and digest; transient retention for reconnect, not another conversation transcript. Cumulative ack and byte allowance live on attempt. |
| `TokenLedgerEvent` | Add `billingSource = local_device`, `localInferenceHostId`, `localInferenceBindingId`; `estimatedCostAmount = null`. Stamp from the invocation/run pin, not a default provider string. Existing `local_executor` proposal converges here before shipping. |

Host inventory is a last observation, not an authority: NULL means never
reported, an empty list means a successful scan found no local models, and a
failed scan retains the last observation with a stale/unavailable reason.
Store only selected/explicitly published model metadata, bounded to 100 entries
and 128 KiB; a larger local inventory is paginated locally and never silently
truncated as a complete catalogue. Reported capabilities are not a safety proof.

Do not create a durable `AgentPresence` truth table. Derive availability from
binding, current permission, host state and TTL at read/admission. A small
revision/last-published projection may deduplicate transition events, never
override those facts. Health transition fields belong to the host/binding,
using `UserAlert(userId,eventKey)` uniqueness, not another alert-marker table.

## Budgets and model selection

Extend `assertAgentModelSelection` and `listAgentModelOptionsForUser` once for
the explicit local arm. Validate available host, consent, current exact model
digest, capabilities and entitlement on writes; return a remedy for an
unchanged stale selection while still allowing unrelated edits. List the
entitled local choices without calling Ledger; a Ledger outage must not hide
a working local host. Keep the existing Ledger exception-list semantics and
personal-subscription independence unchanged.

Refactor run-lane resolution into a discriminated union before reusing the
subscription branch: `ledger | personal_subscription | local_device`. An
unknown local namespace fails closed. Organisation *currency* budget gates
do not block local-device inference, and `degrade` cannot change its lane.
Per-run tokens, iterations, tool calls and wall-clock limits still apply.
Any separately purchased tool/cloud operation retains its own existing budget
gate. Count actual or conservatively estimated local tokens; unknown token
usage is unknown, never a false zero. Zero organisation inference price says
nothing about the person's electricity or paid tools.

Do not add local devices to the organisation's Ledger Models table as enabled
`InferenceProvider` rows, and never store a localhost URL there. The agent picker
and settings capability section make the new lane reachable. Model capability
selection, the server dispatch gate and every utility call must consume the
same run pin.
