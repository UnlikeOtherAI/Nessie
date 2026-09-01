# Conversational agent setup: core decisions

See the [overview](overview.md) and [delivery and verification](delivery-and-verification.md).

## Core decisions

### Release gate: one product setting, not an imaginary flag service

There is no organization feature-flag framework today. Add the narrow,
product-specific `Organization.conversationalSetupEnabled Boolean @default(false)`
column and an owner-only **Conversational agent setup (Early access)** switch at
`/settings/organization#early-access`. A dedicated
`PUT /api/organizations/current/features/conversational-setup` endpoint accepts
only that Boolean and re-reads a live owner membership; it does not reuse the
existing owner-or-admin organization patch route. Existing organization/me
summary DTOs expose the Boolean read-only to every member so a disabled doorway
can explain the real state without widening mutation authority. This is Nessie
product configuration, not UOA-owned identity or hierarchy, and the endpoint
cannot read or write any UOA-owned field. The API checks the live value before
exposing request tools, creating/finalizing setup requests, or enabling the
native setup action; the worker also checks it while building the toolset. A
disabled card renders the stable owner doorway rather than disappearing. Do not
add a generic flag table or hide the only control in an operator CLI for this
launch.

### 1. Ordinary agents receive request tools, not connector-admin tools

Add two builtin tools:

- `app_search` — a read-only catalogue search using the same store visibility,
  moderation, ranking, and leak-proof presenter as `/api/apps`. It returns
  stable app identifiers, display name, publisher/trust, short description,
  cached capability counts, and the app-detail link. It never returns endpoint,
  transport, auth config, credential state, or an authorization URL.
- `app_connect_request` — a presentation tool that accepts up to three app
  identifiers returned by `app_search` plus a short reason. It creates a
  durable request and an in-thread card. It cannot install, authorize, grant,
  or resume anything.

`app_connect_request` is `requiresExplicitGrant: true`. The Agent create/detail
Tools UI groups both tools under one **Request app connections** choice, while
the durable grant remains keyed to the two real registry tools. This makes the
author's intent explicit and prevents every workspace agent from being able to
spam setup cards by default.

This path replaces the PA’s mutation-oriented connector journey too. Before
the organization setting can be enabled anywhere, remove `connector_install`,
`connector_authorize`, `connector_set_secret`, and `connector_uninstall` from
the PA toolset: today they can mutate before a human confirmation, return an
authorization URL through model output, accept a secret in chat, create an
instance without `requiresExplicitToolGrant`, or remove one without the Apps
management surface. Keeping them callable would preserve a complete bypass
beside the safer flow. Existing connections keep running; install, reconnect,
secret and removal actions move through authenticated Apps/card actions. Until
that removal lands, startup refuses to expose or enable the new setting for any
agent. A registry assertion makes the legacy mutation set and the safe request
set globally mutually exclusive; they never coexist live for ordinary agents
or the PA.

The handler requires all of the following structural facts:

- `payload.interactive === true`;
- the run acts for a live human user;
- that user has a live organization membership;
- the target agent is the run's own agent;
- the destination is the current thread; and
- every proposed app is still visible through the store presenter.

An unattended or agent-authored run receives a plain tool refusal and creates
no card. Natural-language intent stays with the model; deterministic code only
checks these structural conditions.

### 2. The request has durable state; message metadata is only its pointer

Add an additive `AgentAppConnectionRequest` model rather than treating a blob
of message metadata as mutable authority. The request is an interaction
lifecycle, not another app/connection catalogue.

Proposed fields:

```text
id                         uuid primary key
organizationId             uuid
threadId                   uuid
messageId                  uuid unique
originRunId                uuid
originTriggerMessageId     uuid nullable
agentId                    uuid
requestedByUserId          uuid
candidateCatalogEntryIds   uuid[] (maximum three, server-validated)
selectedCatalogEntryId     uuid nullable
connectionBackend          mcp | comms_google nullable, server-derived
mcpInstanceId              uuid nullable
commsConnectionId          uuid nullable
scopeType / scopeId        nullable, server-resolved at selection
status                     offered | connecting | needs_secret |
                           selecting_resources | awaiting_scope_upgrade |
                           awaiting_grant | ready | failed |
                           cancelled | expired | superseded
consentSnapshot            json (ids, trust label, known capability keys,
                           agent id and scope; never URLs or credentials)
failureCode                nullable sanitized code
continuationRunId          uuid nullable unique
offerCooldownUntil         timestamp
connectAttemptRevision     integer default 0
returnedAt                 timestamp nullable
returnRevision             integer default 0
returnClaimedBySessionId   opaque session id nullable
returnClaimLeaseExpiresAt  timestamp nullable
expiresAt / createdAt / updatedAt / completedAt
```

`AgentAppConnectionRequest` is only the Apps/comms connection lifecycle. The
later Mac executor journey uses its own typed `AgentExecutorSetupRequest` and
its executor-specific state machine; it must not add executor states to this
app-connection enum. `continuationRunId` is a lookup/index aid, not the
one-shot guarantee: PostgreSQL permits multiple `NULL`s. The terminal
status-transition CAS and its continuation transaction are the one-shot guard.

A database check requires exactly the relation matching `connectionBackend`
once a connection is attached; the Gmail path cannot masquerade a
`CommsConnection` id as an MCP instance id. Viewer DTOs expose neither relation
id—the request id is the browser’s opaque handle.

An advisory lock on `(requestedByUserId, agentId, threadId)` enforces one
non-terminal request for that tuple and checks the latest row’s
`offerCooldownUntil` before inserting. A newer legitimate proposal supersedes
the old row after the bounded cooldown; a repeated model call inside it returns
the existing card without another message. The cooldown therefore has durable,
race-safe state rather than existing only in a worker process.

The assistant message stores only:

```json
{
  "card": {
    "kind": "app_connect_request",
    "requestId": "…",
    "schemaVersion": 1
  }
}
```

Define this pointer as a new first-party `AppSetupCardSchema`. It is deliberately
separate from the existing `IntegrationUiCardSchema`: that generic schema is
also populated by external agents, accepts externally supplied links, and must
remain display-only. It must not acquire install, authorization, secret, grant,
retry, or continuation mutations. `ChannelMessageRow` dispatches the new typed
card to `AppSetupCard`, so the one message renderer continues to cover channel
feeds, replies, inbox and drawer views without creating a second conversation
surface.

The card fetches a viewer-scoped presenter for the live request. Other channel
readers never receive the requested user's external identity, connection
details, authorization state, or actionable controls. The target user receives
the controls; an entitled non-target viewer receives a neutral read-only state.
An actor-scoped `app.setup.updated` event invalidates/refetches that presenter;
focus/visibility and ordinary REST rehydration are the fallback if realtime is
missed. Do not use `message.updated` for per-user state and do not stamp live
connection state into shared message metadata.

Creation of request + card message is one transaction. The message inherits
the run's consumed-source basis through the existing tool-message basis helper,
and realtime publication uses the existing channel scope builder. A failed
transaction creates neither an orphan request nor a card without state.

### 3. A click is the authority

The model proposes; the authenticated user acts. Add a member-level chat-action
API whose service reuses the existing app and agent policy functions:

- `GET /api/agent-app-connection-requests/:id` — viewer-scoped card state,
  re-derived from the request, live app/connection, live agent and live
  membership.
- `POST /api/agent-app-connection-requests/:id/begin` — select one of the
  server-recorded candidates, resolve the allowed scope, claim the request,
  and run the existing `connectApp` orchestration.
- `POST /api/agent-app-connection-requests/:id/secret` — store a key through
  the existing encrypted instance-secret seam, then re-probe. The card opens
  `AppSecretDialog`; the value never enters a message or model context.
- `POST /api/agent-app-connection-requests/:id/grant` — explicitly grant the
  now-known projected keys to the target agent through the same locked service
  used by the existing tool-policy route.
- `POST /api/agent-app-connection-requests/:id/finalize` — prove the
  connection is active and the exact grant has landed, then create the one
  hidden continuation kickoff.
- `POST /api/agent-app-connection-requests/:id/cancel` and `/retry` — bounded
  recovery actions; retry never reuses an expired OAuth URL.

All mutations use compare-and-set transitions or a request-scoped advisory
lock. Two clicks, two tabs, status polling, and a callback race can create at
most one connection selection, one grant fan-out, and one continuation run.
The response never persists or echoes the authorization URL outside the
immediate authenticated `begin` response that launches it.

The request row also owns the server-resolved scope, retry inputs, selected
candidate and return anchor. A cold retry must not depend on React hook memory
or reconstruct authority from the message. Store the exact origin route shape
(channel/thread/reply identifiers and message id), not an arbitrary URL, so the
client can restore the same conversation and scroll/focus the same card without
creating an open redirect.

### 4. Reuse one connect controller

Do not copy `useAppConnectFlow` into the chat feature. Extract its existing
launcher/reducer/marker/polling behaviour into a controller parameterized by:

- a stable `flowKey` (app detail uses the app slug; chat uses the request id);
- `begin(): connected | authorize | needs_secret`;
- `probe(connectionRef)`; and
- `onReady(connectionRef)`.

`connectionRef` is controller-local opaque state: the Apps adapter may use its
existing instance id, while the chat adapter uses only the setup request id and
lets the server resolve the typed backing relation.

`AppConnectDialog` keeps its `/api/apps/:slug/connect` adapter. The chat card
uses the request endpoints above. Both keep the same `ConnectProgress`, popup
launcher, focus/visibility reconciliation, timeout copy and retry rules. The
current callback-message parser may remain only as a legacy optimization for a
same-tab Apps flow that still retains an opener; it is not part of the new
flow's correctness contract.

`onReady` is origin-bound: the controller may finalize only when the opaque
flow id resolves to the matching server request and structured origin. The
OAuth callback consumes state, records `returnedAt` plus a monotonic
`returnRevision`, and publishes the ordinary actor-scoped
`app.setup.returned` invalidation; neither event nor browser marker is the
authority. An Apps detail page or unrelated card may observe that the account
connected but cannot resume a chat request.

A top-level signed-in return coordinator handles another Nessie tab or route.
On launch, focus, visibility and actor event it calls a viewer-scoped endpoint
that lists the actor's unclaimed returned flows. It CAS-claims one flow with
`returnClaimedBySessionId` and a short `returnClaimLeaseExpiresAt`, loads the
server-owned structured origin, and navigates to that conversation and card.
The lease only prevents competing UI recovery work: finalization itself must
CAS the matching `(status, returnRevision)` in the continuation transaction, so
an expired/reclaimed lease cannot create a second run. Closing the claiming tab
releases the flow by lease expiry; another tab can recover it. `sessionStorage`
is only a same-tab latency optimization and is never the cross-tab source of
truth.

Opening either UI is read-only. Fix the current `AppConnectDialog` auto-start so
no probe, discovery, dynamic registration or other target network request occurs
until the person passes the documented Community/Unknown trust interstitial and
presses the labelled connect action. A route mount, card render or model proposal
is never consent to contact a third-party endpoint.

The marker key must include the flow key, not just the app slug. Two cards for
the same app in different threads must not resume or clear each other's OAuth
state.

The client marker stores only the opaque flow key, adapter recovery reference,
non-sensitive phase/retry facts and timestamps. The chat adapter’s recovery
reference is the request id, never either backing connection id. It does not persist the
authorization URL in `sessionStorage` as the current Apps marker does. A URL is
used directly from the authenticated response while the page is live; reopening
or cold recovery asks the server to mint a fresh short-lived authorization
decision.

The extracted controller therefore has an explicit URL-less resume path:
`resume` accepts the opaque request reference and phase only, while
`reopenAuthorization` asks its adapter for a fresh begin decision. The chat
adapter must never inherit the Apps adapter's stored-URL reopen behaviour.

The web launcher remains a centred, chromed popup with its opener severed before
third-party navigation, so the new flow never depends on `postMessage`.
Desktop/mobile launchers plug into the same interface using the platform system
authentication session. A blocked popup always leaves an ordinary **Open
sign-in** link in the card.

Native return uses a server-configured deep/universal-link target carrying only
an opaque flow id. It never accepts a caller-supplied return URL. Web and native
return signals both restore the structured origin route and message anchor,
then refetch the authoritative request; neither signal is proof of success.

### 5. Installing and granting remain two durable decisions

`McpServerInstance.requiresExplicitToolGrant` stays true. The chat can make the
experience short without collapsing the security model:

- If the app has a current, server-known projected capability set, the
  confirmation says: “Connect _Linear_ and let _Triage Agent_ use these 12
  capabilities in _this chat_.” The consent snapshot records the exact registry
  policy keys. After connection, finalization grants only those keys.
- If capabilities are unknown until after authorization, the first decision
  connects the account only. The ready connection then renders the discovered
  capabilities and requires **Allow _Agent_**. There is no wildcard or
  “whatever this app adds later” grant.
- A later refresh that projects new registry rows leaves those rows off. The
  Apps detail page is the home for reviewing and granting them.
- Consent binds each granted key to a canonical descriptor fingerprint/version
  over name, description, input/output schema and security-relevant annotations.
  A material descriptor change invalidates that capability’s allow even if the
  registry row id is reused; the card/Apps page asks again. Remote MCP
  `readOnlyHint`/`destructiveHint` values may inform copy but are untrusted hints,
  never authorization facts.
- A partial grant failure is reported honestly with the count that landed,
  refetched from the server, following the existing Apps agent-access
  behaviour. Finalization waits until the required set is actually enabled.

Resolve the existing split grant truth rather than adding a third system.
`Agent.toolPolicy` remains the ordinary builtin enable/disable map. The existing
`ToolGrant` table becomes canonical for every `requiresExplicitGrant` registry
tool: an allowed agent grant stores the current descriptor fingerprint in its
`config`, and the worker requires a live matching row before exposing or
dispatching that tool. Migrate protected `Agent.toolPolicy=true` entries into
fingerprinted `ToolGrant` rows, then stop reading/writing those protected keys as
authority. Apps, Agent Tools and chat call one locked transactional bulk-grant
service; they do not reuse the current client-side one-request-per-capability
fan-out. Update `docs/tool-registry-spec.md` and the migration path in the same
slice so no surface can disagree with runtime.

The compatibility migration runs at API startup, before routes or an embedded
worker become available, and is safe to repeat: it re-reads each current
protected MCP descriptor under that agent's policy lock, then materializes its
current fingerprint only when the direct allowed agent grant is missing that
fingerprint (or absent). Once present, a fingerprint is immutable to startup
backfill — including when it is stale — so a changed descriptor requires new
explicit consent. The existing protected-policy mutation may refresh the
fingerprint when a person explicitly enables the tool. Role grants and
ordinary/builtin policy keys are not part of this compatibility path.

This removes the current Personal Assistant implicit-allow exception in
`isMcpRegistryRowExposed`; `agentKind === 'personal_assistant'` may not satisfy
an explicit-grant check on its own. Instead, every existing Personal Assistant
is provisioned with a direct allowed grant when a protected connector capability
first appears, and a PA created later receives the same missing grants in its
creation transaction. This is the default access the Apps experience shows.
The Apps control can revoke that default: it stores a direct `denied` tombstone,
which every reconciliation path preserves. Re-enabling writes a fresh current
fingerprint explicitly. The worker's registry lookup must receive the matching
live `ToolGrant` data, including its descriptor fingerprint, before it exposes
either a PA or ordinary-agent connector tool.

### 6. Scope is explicit and is a hard ceiling

The card chooses the narrowest useful scope and names it before the click. It
does not silently infer authority from the ambient session team/project.

| Target agent/run | Connection shape | Who may approve | Result |
| --- | --- | --- | --- |
| Personal Assistant presence | Existing user-scoped instance | That user | Available only in that user's delegated PA runs. |
| Private agent owned by the user, running in its owner-only home DM/own trigger thread | User-scoped instance | The live owner | Extend the worker's user-scope match to this exact private-owner case. |
| Workspace/shared agent in the current channel | Existing or new channel-scoped instance, with a per-user credential override when the provider identity is personal | Organization owner (and any existing role allowed by the mirrored app/agent routes) | Available only to that agent when running in the named channel and explicitly granted. |
| Wider team/org use | Team/organization instance selected explicitly | Existing admin/owner scope rules | Available only inside that install scope and explicit agent grants. |

The private-agent extension is safe only when all of these are re-read at run
time: `visibility=private`, `ownerUserId=effectiveUserId`, owner membership is
live, and the run is in the exact owner-only home DM or the agent's own trigger
thread. An explicit policy allow can never bypass this scope predicate.

`McpRunScopeContext` must carry the live facts required to enforce this—agent
visibility, owner user id, exact home channel id and the trigger-thread
identity—rather than trying to infer them from the old PA-presence boolean. The
user-scope matcher accepts only that structural private-owner case.

For a shared agent, a member who lacks shared-install or agent-policy authority
does not get a weaker chat shortcut. The card says who can complete the setup
and links to the owning Apps/agent surface; it never falls back to installing a
personal connection the shared agent cannot use.

### 7. Continue automatically, without pretending the OAuth callback is a user

The OAuth callback remains unauthenticated. Before it can stamp a setup request,
both MCP and comms OAuth state records must bind the server-owned
`(requestId, connectAttemptRevision, requestedByUserId)` at begin time. The
callback consumes that one-shot bound state, exchanges the code, stores the
token, probes, atomically stamps the matching request's
`returnedAt`/`returnRevision`, publishes the actor-scoped return invalidation,
and renders a constant close/return page. Those bounded return writes are
routing facts, not signed-in authority; the callback does not claim a return
lease, grant a tool or enqueue an agent run.

On return, the signed-in Nessie client calls `finalize` with a fresh actor
session. The service then re-checks:

- request target user and live UOA-backed membership;
- the original request still has interactive human-principal provenance; any
  pended actor context is discarded/re-derived from the live signed-in
  principal rather than replayed as stored authority;
- app visibility/lock state and selected catalogue id;
- connection reach and active lifecycle;
- target agent visibility, ownership/binding and current scope;
- the exact projected policy keys and their grant state; and
- that no continuation has already claimed this request.

In one transaction it creates a hidden `system` message, claims or pends the
normal `(agent, thread, principal)` run slot, creates the run/task when the slot
is free, stores `continuationRunId`, and enqueues through the existing durable
queue path. If the slot is busy, the hidden message enters
`RunThreadPendingMessage` with a typed `app_connection_continuation` discriminator
and request id. The ordinary drain uses that discriminator to invoke the same
fresh-principal/live-membership revalidation before it starts the run; revocation
between finalize and drain cancels the pending continuation with a named card
state instead of re-injecting stale actor context.

The hidden prompt is constant server copy, for example:

> The app connection request raised in this thread is now ready. Re-read the
> preceding conversation, continue the person's original request, and use only
> tools present in your current toolset. Do not claim an external result until
> a tool call succeeds.

It contains no model-authored app label, endpoint, token, provider response, or
other prompt-injection material. The new run rebuilds its MCP toolset from the
database, so it sees only the connection and exact grants that actually landed.

If the browser was closed after provider authorization, nothing is lost: the
request remains `connecting`, `/apps` shows the connected account, and mounting
the card later reconciles the live connection and offers/completes `finalize`.
Automatic continuation occurs when the user returns with a fresh session, not
from a stale stored identity.

### 8. Personal connector reads must feed the disclosure sink

This is a release blocker for allowing user-connected apps outside the current
PA-only path.

Today `buildMcpToolset` resolves a credential and gives the MCP result to the
model, but the dispatch path does not add the credential/instance scope to the
run's `ConsumedSourceSink`. An empty reply basis means unrestricted; therefore
personal external data could be repeated into a room whose viewers were never
entitled to the source.

Change credential resolution to return provenance alongside the opaque ref:

```text
credentialRef
principalType: user | agent | channel | team | project | organization | default
principalId
instanceScopeType / instanceScopeId
```

Before an MCP result reaches the model, `buildMcpToolset` records the narrowest
source scopes in the run sink:

- a user credential or user-scoped default adds `user:<id>`;
- an agent credential adds `agent:<id>`;
- channel/team/project/organization credentials add the matching scope; and
- the instance install scope remains a ceiling and is added when it is narrower
  than the credential principal.

Pass the run sink into the MCP toolset just as builtin reads receive it. Add the
scope before returning the tool result, so streaming restriction becomes
monotone before the next model token. The existing reply basis, message/run
stamping, search fail-closed rule, SSE restriction gate, and viewer predicates
then protect connector-derived answers without a second disclosure system.

Shared-agent rollout also waits for arbitrary MCP side-effect containment.
Remote annotations are only hints; an unknown/write-capable operation using a
personal credential fails closed to an authenticated approval/policy decision
bound to the effective user and destination. Read provenance alone does not make
a cross-boundary external write safe.

### 9. Connection health owns reauthorization

Initial sign-in is not enough for a recurring agent. A revoked or unrefreshable
credential must transition to a state with a remedy, persist a sanitized reason,
and alert exactly once per transition.

For user-specific overrides, health is per credential principal rather than a
global instance error; one person's revoked Linear token must not mark every
user of a shared instance broken. Add or extend credential-health state with:

- `active | needs_reauthorization | error`;
- `healthRevision`;
- sanitized `failureCode` and `lastCheckedAt`; and
- exactly-once `UserAlert` event key
  `mcp-credential:<instanceId>:<principalType>:<principalId>:<revision>`.

The stale card and `/apps/:slug` both use the existing reconnect orchestration.
Recovery is explicit and never happens merely because the person logged into
Nessie. A recurring trigger whose required credential is not usable does not
keep failing silently or post repeated apologies; it records the blocked run,
leaves one durable alert, and resumes only after the user reconnects and the
existing trigger/run authorization gates pass again.

### 10. Close OAuth/token lifecycle gaps before exposing the chat doorway

The new UX increases how often OAuth is invoked and cannot inherit known race or
lifecycle ambiguity. Treat these as launch prerequisites in the shared OAuth
implementation, not card-specific work:

- Bind each one-shot state to request id, attempt id/revision, actor, instance,
  immutable issuer/authorization/token endpoints, client id, resource, requested
  scopes, redirect URI and PKCE verifier. Only the latest unsuperseded attempt
  may attach a credential; store a hash of the bearer-like state token where the
  migration permits.
- Require PKCE S256 for chat-started dynamic OAuth. A provider that cannot do it
  is truthfully unsupported in this flow; do not silently downgrade.
- Request a curated least-privilege scope set, not every advertised scope. Show
  provider scopes separately from Nessie tool grants and retain the token
  response’s actual granted scopes for readiness checks.
- Consume/supersede valid state on provider denial and cancel, sanitize the
  failure code, and never log callback query values or raw provider
  `error_description`. Static completion uses the attempt’s immutable endpoint
  snapshot rather than current mutable catalogue config.
- Recheck live membership and action revision before exchange/attachment. The
  callback may persist an active credential but never a continuation; the fresh
  signed-in finalizer still rechecks every grant/run gate.
- Serialize refresh per credential reference, re-read after taking the lock,
  and CAS rotating refresh tokens. `invalid_grant`/refusal transitions that
  principal to `needs_reauthorization`; never hand the stale access token back.
- Revoke remotely when provider metadata supports it through pinned egress,
  while local disconnect remains authoritative. Garbage-collect replaced and
  unreferenced encrypted secret refs on reconnect, override replacement,
  disconnect and instance deletion.
- On the unique instance/scope creation race, authorize and adopt the winner
  after conflict rather than surfacing a false install failure.

### 11. One-prompt creation is Agent Designer in a chat-first shape

Do not give a normal running agent the owner-only `PUT /api/agents/:agentId`
surface. That route can change the system prompt, model, policy, limits and
stewardship; wrapping it in an `agent_update` builtin would turn “rename
yourself” into control-plane escalation.

Instead add a compact **Quick create** mode to the existing Agent Designer:

1. **New agent** opens with the Design Assistant composer first and the full
   form collapsed but always available.
2. The person describes the job once. The existing structured designer tools
   (`set_name`, `set_role`, `set_model`, `set_system_prompt`, `toggle_tool`)
   update the same typed draft and use the same live Ledger model catalogue and
   tool catalogue as the full form. The model does not write the database.
3. The surface shows the inferred name, one-sentence role, private/workspace
   placement, model, run limits, requested capabilities and avatar choice
   beside a single
   **Create _Name_** button. Explicit-grant capabilities are shown as follow-up
   setup requirements, not silently smuggled through `CreateAgentBody.toolPolicy`.
   The current create route generates a billed model avatar when none is
   supplied, so Quick create must say **Generate an AI avatar (uses model
   credits)**, **Use default avatar**, or use a selected attachment; that cost
   may not be a hidden side effect of the button. The typed create contract
   makes this explicit as required `avatarMode = generate | default |
   attachment`; `attachment` requires one authorized `avatarAttachmentId`, and
   the other modes forbid it. Omitting the field never means “generate.” The
   shown run limits are the exact values
   that will be persisted, including the product defaults when no override was
   inferred, and the summary names the destination UOA workspace/team for the
   private home.
   If the summary says “may ask you to connect apps/use this Mac,” that same
   labelled click may grant only the corresponding presentation-only request
   tools through the canonical exact-grant service; it never grants Gmail,
   executor or app operations themselves.
4. That click submits/finalizes the server-owned creation intent with its
   idempotency key. The personal quick-create default is `visibility=private`.
   The server, not the browser, claims the intent and owns every completion
   write. **Advanced** keeps the existing workspace-agent Designer behaviour
   through the same shared orchestration.
5. Finalization performs any required avatar generation once, then one database
   transaction creates the agent, exact owner-only home DM, owner-authored first
   message, ordinary run/task, queue outbox and completion receipt. The response
   supplies those server-created ids; the UI only replaces the draft route with
   `homeChannelId`. It never creates the message or starts the run. The new
   agent therefore answers once and can immediately offer its Gmail/app or
   Mac-executor setup card.

Persist a small server-owned `AgentCreationIntent` (actor, organization,
selected mapped team reference, bounded original instruction, structured
draft, draft revision, idempotency key, selected model/tool keys, `avatarMode`,
optional authorized avatar attachment, status, step receipts and expiry) so
reload and double-click cannot create twins. It is a transient creation command,
not a second identity/profile store. The finalizer locks/claims it and records
the resulting agent/home/message/run ids. Retries return that receipt instead of
replaying writes. The original user prose becomes the ordinary first message
only when creation succeeds.

The shared Quick-create/HTTP/designer schemas must require `avatarMode` and
bound every model- or
human-authored field before it reaches storage or a provider: trim and cap the
name (use the existing 120-character product convention), role, behavioural
brief/system prompt and designer conversation history, and cap array/map sizes
for tools and messages. The UI applies the same limits and explains truncation;
the server rejects an over-limit structured tool call rather than silently
storing an unbounded prompt. Put the constants in `@nessie/schemas` so the
designer stream, intent row, create route and narrow profile card cannot drift.

Private-home placement is an explicit write target, not an “oldest team” or
ambient fallback. Quick create may preselect the active UOA workspace because
the person explicitly entered that workspace, but the confirmation names it
and the intent stores its stable mapped team reference. If there is no active
team, or the session cannot prove the selection, show the existing UOA
workspace picker before create; finalization revalidates live membership and
the 1:1 UOA team mapping. A local no-IdP install uses its one configured local
team. Never guess a team merely to avoid
`PRIVATE_AGENT_HOME_TEAM_REQUIRED`.

Refactor the complete actor-facing creation orchestration—not merely the Prisma
row writer—into `@nessie/workspace-admin` so Quick create, `POST /api/agents`
and the PA path share model validation, protected-policy checks, owner/private
home rules, avatar behaviour, audit and realtime. For `avatarMode=generate`, a
generation receipt keyed by the creation intent records the billed provider
attempt and resulting attachment; retry reuses it and cannot bill/generate a
second image. `default` skips the provider entirely, and `attachment` rechecks
access to the exact stored attachment. Agent + private home + first message +
run/outbox then commit in one transaction. Presentation-tool grants and any
requested Gmail/executor setup are later idempotent intent steps with visible
`pending`/`failed` receipts; a valid agent is not rolled back because a later
provider or queue step failed, and the UI says “Agent created; setup needs
attention” instead of claiming an all-or-nothing success.

For an already created private agent, add a narrow
`agent_profile_change_request` presentation tool rather than `agent_update`.
It may propose only `name` and `role` for the run’s own agent, only in its exact
owner-only home and only for the live owner. Nessie has no separate bounded
behavioural-brief field: changing instructions means changing `systemPrompt`
through the existing Agent Designer and is deliberately outside this card. The
authenticated card action calls a shared profile service that locks and
rechecks those facts, emits `agent.updated` and an audit event, and then shows
the existing “Renamed to …” timeline event. It cannot mutate model, system
prompt, owner, visibility, policy, limits, bindings, triggers, todos, avatar or
delegation. During Quick create the one **Create _Name_** click already confirms
the draft profile; later profile changes require the card click.

Renaming must not leave the private home with the old copied label. The shared
profile service derives the one allowed DM key with `privateAgentHomeDmKey`,
locks the agent and that exact channel, and atomically updates `Agent.name` and
the home `Channel.label` only when the live owner/private/home invariants still
match. It accepts no caller-supplied channel id, changes no ordinary channel,
and publishes the existing agent and channel invalidations plus one audit
event. Role-only changes leave the channel label alone.
Rename does not regenerate the model-created avatar or incur another model
charge; the confirmation says the existing image stays. The owner can choose
the existing avatar editor’s separately labelled, billed regenerate action.

### 12. Gmail is the mandatory first-party vertical

Gmail must prove the whole experience before generic app rollout is called
complete. Reuse the existing `CommsConnection` and Google connector as the one
account/credential authority; do not install a second Gmail MCP instance or ask
the person to authorize Google twice.

Give Gmail one product home while reusing existing components:

- Seed one public, Nessie-trusted `McpCatalogEntry` identity with slug `gmail`
  and add a typed `connectionBackend = mcp | comms_google` discriminator
  (default `mcp`) to the catalogue row. The Gmail row therefore passes through
  the same entitlement-scoped `storeCatalogWhere`, search, card and
  `/apps/gmail` detail presenters as every App; it is not a pseudo-row assembled
  in the browser or a second catalogue. Backend-specific validation keeps the
  current MCP transport/auth requirements for `mcp`; `comms_google` accepts no
  endpoint/transport/secret config and can be created only by the signed
  migration/seed, never registry import or a user-authored catalogue route.
- Make the existing `protocol`, `authMethod`, `authConfig` and
  `defaultTransportConfig` columns nullable as a coordinated schema/API change.
  A database `CHECK` makes the polymorphism legal and exclusive:
  `connectionBackend=mcp` requires all four current MCP fields, while
  `connectionBackend=comms_google` requires all four to be null. The migration
  marks every existing row `mcp` without altering those values and creates the
  canonical Gmail row through the signed seed only. A single shared
  `assertMcpCatalogBacking` guard is called before instance creation, OAuth,
  secret attachment, probe/test, registry import/merge/sync and tool
  projection; a non-MCP row fails before any transport or target-network work.
  The Apps presenter obtains first-party Gmail auth/readiness copy from the
  comms adapter, never from dummy MCP values.
- The typed `comms_google` connect/detail adapter dispatches the existing Apps
  connect action to the shared communications OAuth/resource services and
  projects Gmail builtin capability/grant state. It creates no
  `McpServerInstance`, stores no second token, and never treats the catalogue
  identity as an account. Existing MCP rows keep the ordinary backend.
- `/apps/gmail` is the account/capability home and renders that provider adapter
  backed by the existing communications connection.
- Remove the current `ai.waystation/gmail` home-suggestion shortcut when the
  canonical row lands. If that or another Gmail MCP server is independently
  imported from a registry, it remains a separately labelled Community app
  with its own publisher, account and consent; it is never auto-selected,
  merged with, or allowed to reuse the first-party credential. The mandatory
  Gmail journey resolves the canonical seeded id structurally, not by matching
  the word “Gmail”.
- Mailbox/label import selection remains the decision owned by the existing
  resource selector, embedded/reused from the Gmail account tab. The old
  `/settings/connections` Gmail entry links/redirects to that same component
  rather than becoming a second implementation.
- The in-chat Gmail card is a typed first-party setup request. Before auth it
  shows Gmail identity, verified publisher/trust, the target agent, requested
  Google permission groups, and **Authorize**. After verified return it shows
  **Added**, the exact enabled capability count, **Manage**, and continuation
  state. It never claims “draft” or “send” from the current read-only scope.

Today this boundary is broken: the callback can enqueue connection-wide sync,
`worker/src/control/comms-sync.ts` never loads `CommsResource.syncEnabled`, and
`packages/comms-google/src/sync.ts` lists the mailbox with only an `after:`
query. Resource toggles currently do not constrain imported Gmail events. This
slice deliberately changes the existing communications-connector contract,
not only the new card.

Authorization alone does not start mailbox ingestion. After OAuth and a
successful account probe, the card stays at **Choose what to import** until the
person selects labels/resources and a bounded initial time window. Define a
conservative product default (for example, the most recent 30 days), show it,
allow the person to narrow it, and persist it in the connection sync config.
Both backfill and incremental history processing enforce the selected resource
set; selecting a resource is not merely display metadata. An empty selection
imports nothing. A later selection change advances/reseeds the checkpoint
without silently backfilling the whole mailbox.

Persist the selection contract rather than reconstructing it from whichever
resources a worker happens to load. Add `selectionRevision Int @default(0)`,
`selectionConfirmedAt` and `initialImportAfter` to `CommsConnection`; the
enabled label set remains the connection's `CommsResource.syncEnabled` rows.
Add `selectionRevision` to every `CommsSyncJob`. A selection transaction locks
the connection, updates the label set/window, increments the revision,
supersedes pending jobs from older revisions and enqueues the new bounded job.

Add a typed `CommsSyncSelection` to the worker/connector seam: the worker loads
the connection owner’s currently enabled Gmail label ids, bounded history
window and immutable revision, and refuses to create an initial job until
`selectionConfirmedAt` is set. Every page carries that job revision and CAS
checks the current connection revision before persistence; stale pages discard
their result. After remote fetch, one database transaction takes a
`FOR UPDATE` lock on the connection, re-reads the revision and confirmation,
then writes normalized events, `CommsEventResource` associations and the job
checkpoint together. A selection transaction uses the same connection lock, so
the revision cannot change between validation and any event/association insert
or checkpoint advance. Initial, backfill, incremental and webhook/history paths
query/filter against the same selection. Discovery defaults Gmail labels to off
until the person chooses them.

Gmail messages can have several labels, so add a normalized
`CommsEventResource(eventId, resourceId)` association with a composite unique
key and indexes in both directions. The provider-normalized event contract
carries `resourceExternalIds[]`; persistence resolves only resources in the
immutable selection and writes the associations in the event transaction.
Deletes use the prior event-resource associations, so a deletion or label
removal cannot widen into an unselected mailbox area.

The migration for existing Google connections is intentionally conservative:
pause their sync jobs, set `selectionConfirmedAt=null`, increment the revision
and default Gmail resources off. Existing normalized events remain stored but
agent Gmail tools expose none until the person explicitly confirms a new
selection. Backfill event-resource associations only where retained normalized
label metadata proves them; otherwise do a bounded re-sync after consent. The
current `syncEnabled=true` default is never reinterpreted as renewed mailbox
consent.

Refactor the route-owned comms OAuth workflow into a shared service, then bind
its state to the setup request/attempt revision and structured origin anchor.
Provider denial consumes the attempt; callback errors are sanitized; the
callback never trusts an arbitrary return URL or starts a run. Web/native return
signals refetch the request and the signed-in client finalizes it exactly like
the generic Apps path.

Ship these agent-facing Gmail tools against the first-party connector:

- `gmail_search` and `gmail_read` query only the requesting user’s selected,
  imported `CommsEvent`/resource data and add `user:<owner>` to the disclosure
  sink before returning any result.
- `gmail_draft_create` creates a Gmail draft through a new operation in
  `@nessie/comms-google`, using the shared credential-refresh coordinator and
  pinned egress. It is an explicit agent grant and a visible external write.
- `gmail_send` is a separate high-impact capability. Extend the existing
  tool-call approval suspension seam with a typed, server-owned, one-to-one
  `GmailSendApprovalSubject` for the `ApprovalRequest`. It records the
  connection id and owner, opaque provider draft reference and revision,
  canonical snapshot digest, agent/run/tool-call/thread ids, exact requested
  approver user id, expiry and dispatch idempotency key. The model supplies only
  the opaque draft reference; the server loads the owner/account, canonical
  recipients, subject, attachments and body, computes the digest, and renders
  those facts from a separate sanitized presenter. Approval locks the subject,
  rederives the live UOA actor, exact private owner/home and connection
  authority, reloads the provider draft, and recomputes revision/digest. If it
  still matches, Nessie seals the exact approved canonical RFC 2822/MIME bytes
  in a short-lived encrypted payload and records only its opaque reference on
  the subject. Resumed dispatch sends those immutable approved bytes through
  `messages.send`; it never calls `drafts.send` on a mutable provider draft id.
  A local `pending → dispatching → sent | outcome_unknown` fence permits one
  provider call. An ambiguous timeout/crash becomes `outcome_unknown` and is
  never auto-retried; provider draft cleanup is conditional and cannot delete a
  draft whose revision changed. Stored run `actorContext` is never authority.
  Any edit before sealing, or ownership/connection change, invalidates the
  approval; an edit after sealing cannot alter the bytes sent. The subject is
  visible/actionable only to
  `requestedApproverUserId`; it does not inherit the generic organization-owner
  approval visibility bypass. Approving draft creation never approves send.
  Unattended send and every non-private-owner destination remain out of the
  first rollout.

Split Google consent by purpose. Keep the existing read/import scope for
search/read; request the provider’s minimum compose permission only when the
person enables draft/send capabilities, and display both provider OAuth scopes
and Nessie agent capabilities as separate layers. Do not retain the current
unrelated Google Meet scope in a Gmail-only request merely because both use one
provider credential: scope upgrades are deliberate, additive requests whose
resulting granted-scope hash is verified before the capability is marked ready.

Every Gmail sync and operation resolves credentials through
`comms-credential-coordinator`; no worker or connector path directly decrypts
and refreshes an old token bundle. Readiness validates the stored encryption
`keyVersion`, the hash of the scopes actually granted, required scopes for the
requested operation and the latest credential health revision. Unknown key
versions, scope-hash mismatches and refresh rotation races fail closed into the
named reauthorization path.

Gmail availability is server-authored capability readiness, not the admin’s
hard-coded provider list. The API exposes whether client credentials, callback
origin, encryption keys and required Google configuration are valid for this
deployment; the picker hides or explains an unavailable Gmail option, while an
already-authored request renders a stable remedy instead of a dead Authorize
button.

Gmail V1 is private-owner only. Shared agents and unattended inbox access stay
off until live launch identity, per-user disclosure, side-effect containment
and revocation tests are green. Disconnect/revoke removes the user’s own
credential and imported data according to the existing explicit actions; it
does not delete a shared app installation or another user’s account.

### 13. Nessie Desktop is the Mac executor doorway

The basic executor daemon is already in the direct Developer ID Mac desktop
bundle. The work here is to make it discoverable from the moment a coding agent
needs it and to package the missing managed-profile artifacts, not to create a
second local-execution protocol.

Add a presentation-only `executor_setup_request` tool, available only to an
interactive owner-private agent run. It creates a separate typed
`AgentExecutorSetupRequest`/card with the executor states documented below, but cannot
pair, select a local path, approve a fingerprint, grant operations or start a
daemon. The card uses the existing executor availability presenter and the
Tauri companion bridge:

1. In a normal browser it says **Open Nessie for Mac to use this computer** and
   preserves the request. It never offers a shell download or copies a token.
2. In a supported signed Developer ID Mac app it verifies the packaged runtime
   and app signature, then offers **Use this Mac**.
3. The authenticated server creates/reuses one private executor invitation.
   Native code—not the webview or model—opens the folder picker and repeats the
   pairing confirmation. No local path, pairing secret or child output returns
   to the browser/model.
4. The same card renders the server fingerprint/revision review and exact
   agent-operation grant. Start with `file.list`/`file.read`; COW
   `file.write`/`workspace.review` is a separate clearly labelled choice.
   Browser/Codex launch operations keep their existing stronger artifact and
   review requirements and are not inferred from “use my machine”. There is no
   `command.run` or ambient host-shell claim: the current protocol deliberately
   implements files, isolated browser and managed coding bundles only.
   Copy must say that the selected host root is read-only and that enabled
   writes land in a daemon-owned COW draft for separate review/promotion; it
   must not call the whole workspace “read-only” while offering `file.write`.
5. Native **Start executor** launches the supervised packaged daemon. After
   authenticated online status, approved capability revision and the exact
   agent grant, the server CAS-transitions the setup request to `verifying` and
   queues a request-bound, bounded `file.list` verification operation against
   the selected executor/workspace/grant, tagged with `setupRequestId`. This is
   a server-enforced setup operation, not a model instruction, so the model
   cannot omit or replace it. The command result exposes no host path, listing
   or child output to the card. Only a successful command completion CAS may
   mark the request `ready` and create the one-shot hidden continuation. A
   failure records a sanitized `verification_failed` cause and creates no
   continuation; retry is an explicit card action after the named remedy.

The current daemon is a child of Nessie Desktop and is stopped when the app
quits. V1 therefore says **Available while Nessie Desktop is open**, treats app
quit/crash as an ordinary offline transition, and offers a reopen remedy. Do
not imply always-on background execution. A later always-on mode requires a
separately designed, signed and updateable background helper with its own
login-item consent, lifecycle, fencing and uninstall path; it is not smuggled
into this launch.

The native OS confirmations are part of the security boundary and remain even
inside the smooth card flow. The webview may supply only existing bounded ids,
challenge and enumerated operation keys accepted by
`executor_companion.rs`; it never supplies an executable, state directory,
workspace path or arbitrary argument.

“The app is the executor” is complete only when the direct Mac distribution
contains every artifact needed for the advertised profile. Today the bundler
ships Node plus `nessie-executor.cjs`; managed browser/Codex still expects
separately supplied, owner-private VM helper/kernel/initrd-builder/runtime-bundle
artifacts and a Codex auth profile. Add a release-manifested resource pack for
the signed VM helper and immutable guest artifacts, verify every digest and
architecture before enabling its card choices, and extend the native companion
with bounded pickers for any owner-private credential source it still needs.
Never auto-scan `~/.codex`, `~/.claude`, `$PATH`, Keychain or the host home, and
never return a selected path or credential to the webview.

The first complete coding profile is managed Codex because that is the only
coding launcher the server/daemon currently implements. The runtime bundle may
contain a Claude artifact, but presence is not authority or functionality;
Claude stays **Not supported yet** until it has its own typed operation bundle,
credential boundary, egress allowlist, lifecycle manager and tests. A bounded
runtime inspection may report only signed booleans such as “managed Codex
available”—never host CLI names, versions or paths—and the agent must not say a
runtime is usable until its corresponding operation is granted and succeeds.

Screenshot-level “run a command on my computer” also depends on the already
owned full-actuation work in
`docs/plans/2026-08-31-executor-full-actuation.md` (sequenced by
`2026-08-31-grok-gap-closers-build-plan.md`). This plan owns zero-install Mac
packaging, discovery and setup; it does not restate or bypass the guest
`command.run`/`browser.act` schemas, approval-resume gate, COW confinement or
egress hardening. As those operations become real, the same card can request
their exact grants. Until then they stay absent and the agent says it cannot run
an arbitrary command yet.

Enrollment is also made resumable: the server retains/reissues a current
request-bound invitation after refresh instead of relying on React creation
state, and the direct-distribution release checklist covers Developer ID
signing, notarization, installer/download and safe updates for the companion
resource pack.

Distribution truth must be visible. The Mac App Store/TestFlight-style desktop
build excludes the runtime and renders **Local execution requires the direct
Nessie for Mac build** with the official doorway. Do not weaken its sandbox.
The Windows Tauri shell can be built, but `runtime.rs` explicitly refuses
release executor controls off macOS. Mark Windows execution **Parked — not
supported**, hide/disable the setup action there, and open a later project only
after a signed Windows companion has equivalent runtime integrity, private
state/ACLs, workspace isolation, daemon fencing and native confirmation tests.

## State machine

### Agent creation

| State | What the person sees | Allowed next action |
| --- | --- | --- |
| `describing` | One composer asking what this agent should do | Send one natural-language description |
| `drafting` | Name/role/behaviour/model/tool summary filling in live | Stop, revise in chat, or open Advanced |
| `ready_to_create` | **Create _Name_** with private/workspace placement and follow-up setup needs | Create once or edit |
| `creating` | One progress state; duplicate clicks disabled | Wait or safely reload |
| `created` | The real private home conversation with the original instruction present once | Agent responds and offers needed setup cards |
| `failed` / `expired` | Draft retained where safe plus a named remedy | Retry same idempotency key or start over |

### App and Gmail setup

| State | What the target user sees | Allowed next action |
| --- | --- | --- |
| `offered` | Up to three real app choices with publisher/trust, known capability count, target agent and scope | Select one, dismiss, or open Apps detail |
| `connecting` | Progress plus provider sign-in/reopen link | Finish sign-in, cancel, retry after expiry |
| `needs_secret` | “This app needs an API key” with secure dialog action | Enter once in dialog, cancel |
| `selecting_resources` | Gmail account verified; exact labels and initial history window are still unconfirmed | Select/confirm resources or disconnect; no import starts yet |
| `awaiting_scope_upgrade` | Existing read access remains usable; requested draft/send provider scope is not yet verified | Authorize the shown incremental scope, keep read-only, or cancel upgrade |
| `awaiting_grant` | Connected account plus exact discovered capabilities and target agent | Explicitly allow, manage in Apps, cancel the request (connection remains) |
| `ready` | Connected check, agent and scope, manage link | No mutation; continuation status is shown |
| `failed` | Sanitized actionable error; technical detail behind disclosure where safe | Retry from a fresh server decision or manage in Apps |
| `cancelled` | Nothing was granted; says whether a connection was already created | Start a new request |
| `expired` | Request expired; any completed connection remains manageable in Apps | Start again |
| `superseded` | A newer request for the same agent/thread/app owns the flow | Open the newer request |

Every render is reconciled against live state. A stale `ready` snapshot cannot
make the card claim that a now-disconnected app is usable.

The two Gmail-specific states are part of the persisted request enum, not
client-only phases. `awaiting_scope_upgrade` does not block read-only use that
is already verified.

### Mac executor setup

| State | What the owner sees | Allowed next action |
| --- | --- | --- |
| `offered` | Why the agent needs local access and the exact target agent | Open/use the Mac app or dismiss |
| `unsupported_distribution` | Browser, App Store build, or Windows-specific truthful explanation | Open supported Mac build; no remote mutation |
| `pairing` | Native folder picker and pairing confirmation | Choose/cancel locally |
| `awaiting_fingerprint_review` | Server fingerprint and machine label, no local path | Confirm or revoke |
| `awaiting_policy_review` | Exact read/COW/coding operations and target agent | Grant selected operations or keep read-only |
| `starting` | Packaged daemon launch and authenticated status | Wait, retry, or stop |
| `verifying` | Server is proving one bounded operation against the reviewed executor/grant | Wait or cancel; no agent continuation exists yet |
| `ready` | Machine online, approved revision, exact agent grant and successful server verification | Automatic continuation once |
| `verification_failed` | The request-bound bounded verification failed; no access claim or continuation | Reopen/review/restart from the classified remedy, then retry verification explicitly |
| `offline` / `revoked` / `failed` | Durable cause and local/server remedy | Restart, re-pair, re-review, or revoke |

## Authorization and security invariants

- UOA remains the sole identity and membership authority. Persist stable local
  references only; resolve live membership/roles for every click, grant and
  continuation. Do not copy email, display name, avatar, org or team hierarchy
  into the request.
- A request id is not a capability token. Every route loads it within the
  caller's organization, checks thread entitlement, and separately requires
  `requestedByUserId` for action controls.
- Candidate ids, selected app, agent id, install scope, connection id and grant
  keys are re-resolved server-side. Client/message/model values never widen
  authority.
- Authorization URLs are returned only as an immediate action response, never
  stored in message metadata, request JSON, audit metadata, logs, analytics or
  push payloads. OAuth state remains random, one-shot and short-lived.
- All MCP, authorization, token and redirect endpoints continue through the
  shared SSRF/IP-pinning and redirect policy. The chat layer never calls a URL
  itself.
- Secrets never enter chat. The legacy `connector_set_secret` tool is removed;
  every agent, including the PA, can only render the secure dialog action whose
  authenticated route writes through the encrypted secret seam.
- The app presenter continues to hide endpoint, auth config, transport config,
  raw upstream icon URL and credential refs.
- Community listings name their publisher and trust state at consent. The card
  cannot present an app author's claimed brand as publisher verification.
- Rate limits match the existing Apps/OAuth buckets. Repeated cards also have a
  per-user/agent/thread cooldown enforced structurally, not by inspecting text.
- Audit entries cover offered, selected, connect-started, secret-submitted
  (never the value), grant-changed, finalized, cancelled, expired, retry and
  reauthorization transitions. Metadata is ids/status/counts only.
- The agent card is not a disclosure bypass. Viewer-specific request DTOs,
  message basis inheritance, and connector-result provenance all apply.
- Quick create reuses `CreateAgentBodySchema`, Ledger model validation,
  `validateAgentCreateInput`, protected-tool checks and atomic private-home
  creation. A model-produced draft cannot set `agentKind`, `systemManaged`,
  delegation, stewardship, protected tool provenance or a foreign owner.
- A profile-change request is constrained by field allowlist and structure; it
  never calls the broad update route on the model’s behalf. The live owner and
  exact private home are re-read on every apply.
- Gmail account identity is per user and never becomes a Nessie/UOA identity
  authority. External address/profile values are provider account display data
  only, omitted from shared cards and disclosure-stamped when read by an agent.
- Gmail send extends approval suspension with a server-loaded snapshot of
  canonical recipients, subject, account, attachment refs and body digest.
  Approval/send recompute those facts; editing any invalidates the approval.
  Draft permission is not send permission.
- Executor readiness is the conjunction of signed supported desktop,
  authenticated daemon session, current reviewed descriptor, scope assignment
  and exact agent operation grants. A green local process alone is not ready.
- Local paths, hostnames, CLI inventories and command output do not enter setup
  cards, audit metadata or model context. Agent-visible machine labels come
  from the existing safe executor presenter.

## Agent communication contract

The tool descriptions and stable prompt block tell a configured agent:

- During creation, choose a useful name/role/brief from the person’s request and
  configure the draft; do not ask for fields that can be inferred. Name every
  consequential capability that will still need the person’s approval.
- A runtime agent may propose its own name or role change, but may not claim the
  change landed until the server card confirms it.
- Search the Apps catalogue when a required capability is unavailable; never
  invent an app or authorization link.
- Offer at most three useful choices and explain the decision each enables.
- Do not say an app is installed, connected, granted, watching, or working
  until the corresponding server state/tool call proves it.
- Once a card is posted, give a short explanation and wait. Do not ask the user
  to paste a token, an instance id, or “tell me when you're done”.
- On the server-authored ready kickoff, continue the original task immediately.
- If no trigger exists, say that the check is one-off and point to/create a
  trigger only through the existing authorized trigger flow. Never promise a
  background watch merely from prose.
- For Gmail, distinguish connected, imported/readable, draft-capable and
  send-approved. Never say “I can manage your inbox” from a read-only token.
- For local execution, distinguish “the desktop companion exists,” “this Mac is
  paired/online,” “I have these exact operations,” and “the operation actually
  succeeded.” Never infer host access from being inside the desktop webview.
- Follow the person's language and phrasing through model judgement; there is
  no language or intent keyword list.
