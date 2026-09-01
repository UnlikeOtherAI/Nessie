# Conversational agent setup: delivery and verification

See the [overview](overview.md) and [core decisions](core-decisions.md).

## Implementation slices

### Slice 0 — chat-first creation on the existing Designer

- Add Quick create to Agent Designer using the existing designer endpoint,
  structured form tools, model/tool catalogues and form reducer.
- Add idempotent `AgentCreationIntent` finalization through the same create
  service; retain the bounded original instruction, destination team and
  required `avatarMode`, default the compact personal path to private, and make
  the server finalizer own the agent/home/message/run/outbox transaction.
- Bound the shared designer/create/profile schemas and show the exact model,
  limits, grants and explicit generate/default/attachment avatar choice before
  the create click. Record/reuse the avatar-generation receipt on retry.
- Return the completed ids and let the UI navigate only; it never persists the
  original instruction or launches a run itself.
- Add the narrow profile-change request/apply service, atomically rename the
  exact private home label, and publish the timeline/audit/realtime events; do
  not add general `agent_update` to the worker.

Exit: one prompt plus **Create _Name_** produces one correctly named private
agent, one home, one initial message and one run; refresh/double-click cannot
duplicate any of them.

### Slice 1 — shared contracts and no-behaviour-change refactor

- Add the dedicated organization early-access column,
  `/settings/organization#early-access` switch, live-owner-only dedicated
  endpoint, read-only member DTO field, API/worker gate and disabled-state
  presenter before any setup tool is registered.
- Make fingerprinted `ToolGrant` rows canonical for every protected registry
  tool, remove the Personal Assistant implicit-allow worker branch, and add the
  live private-owner/home facts needed by the user-scope matcher.
- Add MCP and comms OAuth-state binding to `(requestId, connectAttemptRevision,
  requestedByUserId)` before any callback can update a setup request.
- Add credential-resolution provenance as a parallel API while keeping existing
  callers working, then migrate MCP dispatch to it. This is complete before any
  personal-connector result can enter a model context.
- Add `AgentAppConnectionRequest` schema/migration and presenter schemas in
  `@nessie/schemas`, keeping executor setup in its later, separate typed model.
- Add a privileged first-party `AppSetupCardSchema`; leave external
  `IntegrationUiCardSchema` display-only and unchanged.
- Extract the reusable connect controller from `useAppConnectFlow`, retaining
  all existing Apps behaviour and tests, while adding the chat adapter's
  URL-less resume/fresh-authorization path.
- Extract only the real shared visual primitives from `AppConnectDialog`,
  `ConnectProgress`, and `CommsConnectCard`; do not build another generic card
  framework.

Exit: `/apps` connect is behaviourally unchanged; provenance unit tests pass;
no chat tool is exposed yet.

### Slice 2 — durable request and presentation tools

- Implement `app_search` on the store presenter and
  `app_connect_request` on the new request service.
- Register both builtin schemas, explicit-grant metadata, tool dispatcher and
  audit/tool telemetry.
- Create request + basis-stamped card message transactionally and publish it via
  existing realtime channel scopes.
- Add the Agent Tools grouping and prompt/tool descriptions.

Exit: a configured agent can post a non-actionable server-backed choice card;
unconfigured, non-interactive and cross-user cases fail closed.

### Slice 3 — authenticated begin and connect UI

- Add viewer-scoped GET and locked begin/cancel/retry routes.
- Adapt the shared connect controller to the card.
- Render app icon, publisher/trust, capability count, target agent/scope,
  progress, popup fallback, errors and manage links using existing Apps
  presenters/components.
- Subscribe to actor-scoped setup invalidations with REST/focus reconciliation,
  add the returned-flow claim/lease coordinator, and restore the exact
  channel/reply/message anchor after web or native auth even when another tab
  receives the callback. Treat its lease as advisory: finalization CASes the
  request's matching status and return revision.
- Wire no-auth, OAuth and secure-secret outcomes to the same state machine.

Exit: a user can connect from chat and reload at any point without losing or
duplicating the flow; no agent grant or auto-continuation yet.

### Slice 4 — explicit grant, private-agent reach and continuation

- Add the exact-key atomic `ToolGrant` service, migrate protected policy entries,
  and preserve the existing route authorization on Apps and Agent Tools.
- Extend user-scope run matching only for the verified private-owner/home case;
  keep workspace agents on shared scopes.
- Add authenticated finalization, hidden system kickoff, ordinary run-slot
  claim/pend, durable queueing and one-shot continuation linkage. Pending
  messages carry a typed app-connection continuation discriminator so the
  ordinary drain repeats the live-principal/membership recheck.
- Rebuild the MCP toolset on the new run and ensure connector read provenance is
  stamped before the model sees results.

Exit: the Linear-style happy path completes without a “done” message and the
agent can use only the exact capabilities the person approved.

### Slice 5 — Gmail mandatory vertical

- Seed the single trusted `gmail` catalogue identity, add the typed
  `connectionBackend` adapter, and project the existing first-party Gmail
  connection/builtin grants into the Apps/account home without creating an MCP
  instance, second token or second account row; reuse the resource selector.
- Move comms OAuth orchestration behind a shared service and bind Google state
  to request/attempt/origin revisions. Add same-card return and actor-scoped
  status invalidation.
- Fix the existing full-mailbox import defect: add `CommsSyncSelection`, default
  discovered Gmail labels off, do not enqueue initial sync before selection,
  persist a confirmed selection revision on the connection and every job, add
  event-to-resource associations, and make worker persistence plus every
  backfill/incremental/webhook connector path CAS-enforce the same label/window
  revision. Migrate existing Google connections to paused/unconfirmed rather
  than treating old `syncEnabled` defaults as consent. Update the
  individual-communications plan to describe this deliberate
  existing-behaviour change.
- Implement owner-private `gmail_search`, `gmail_read` and
  `gmail_draft_create` with disclosure provenance, exact grants, scope upgrade
  and pinned provider calls through the credential coordinator. Enforce
  encryption key versions, actual granted-scope hashes and credential health.
  Extend approval suspension with the typed, server-derived, content-bound,
  owner-targeted send subject; rederive live identity/connection authority on
  approval and resumed dispatch, and keep unattended send off.
- Make Google deployment credentials and callback/scopes a release readiness
  check rather than a soft-skipped demo. Remove false copy and fail closed when
  the configured environment cannot actually provide Gmail.

Exit: the Gmail screenshot flow is real end to end—Authorize → provider → same
card Added → resource/grant ready → agent searches/reads and creates a draft;
send cannot occur from that approval.

### Slice 6 — Mac desktop executor doorway

- Add the typed executor setup request/card and presentation-only tool for
  interactive owner-private agents.
- Expand the direct Mac resource manifest from Node/CLI-only to the complete
  signed guest artifact set for every profile advertised in the card; add the
  bounded native Codex credential picker/configuration path and keep Claude off.
- Reuse server enrollment, fingerprint/capability revision review, operation
  grants and the existing Tauri companion calls in one resumable card flow;
  make an invitation safely recoverable after refresh.
- Detect browser, direct signed Mac, App Store Mac and Windows honestly; only
  the direct signed Mac path enables pairing/start.
- Make “available while Nessie Desktop is open,” read-only host root and COW
  draft semantics explicit; app quit/crash/offline is recoverable, not hidden.
- After authenticated online + reviewed revision + exact grant, make the server
  queue and complete a request-bound bounded verification operation. Only its
  success may mark ready and create the same one-shot hidden continuation used
  by app setup.

Exit: the direct Mac app requires no separately installed executor CLI and a
coding agent can safely list/read the selected workspace and launch the fully
packaged managed Codex profile after the bounded native/server confirmations.
No host shell is implied. Windows and Claude remain visibly unsupported, not
half-on.

### Slice 7 — recovery, health and rollout

- Add per-principal credential health, explicit reauthorize, exactly-once alert,
  expiry/supersession sweep and stale-request reconciliation.
- Add structured metrics for time-to-choice, popup launch, auth completion,
  grant completion, continuation, abandonment and failure code. Never include
  tokens, URLs or model/user prose.
- Roll out behind `Organization.conversationalSetupEnabled`, first to
  owner-created private agents with Gmail and the signed Mac companion, then
  generic Apps, and only then workspace agents after shared-scope/grant tests
  are green. Remove the four PA connector-mutation tools before the setting can
  be enabled for any organization; startup/CI asserts the unsafe and safe tool
  sets cannot be registered together globally.
- Update `docs/functionality.md`, `docs/the-agents.md`, the Apps catalogue and
  individual-communications plans, disclosure-boundary docs,
  `docs/provider-system-and-frontend-architecture.md`, `docs/architecture.md`,
  `docs/executor-protocol/overview.md`, `docs/running-the-apps.md`,
  `docs/deployment.md`,
  `docs/tool-registry-spec.md`, and the relevant `CLAUDE.md`/`AGENTS.md`
  MCP/App/desktop workflow sections in the implementing changes.

Exit: recurring agents cannot die silently on revoked credentials, desktop
offline/revision failures have a named remedy, and the flag can be removed only
after production telemetry shows no stuck state lane across all three journeys.

## Verification plan

### Pure/unit tests

- Early-access presenter/tool-registration matrix: disabled hides request tools
  and native actions but retains the owner doorway; enabled never bypasses any
  per-action authorization. The dedicated endpoint accepts a live owner only;
  admins, members and deactivated owners cannot mutate it, while all members can
  read the Boolean used by the presenter.
- Quick-create reducer applies streamed designer calls to one draft; invalid
  model/tool/name output leaves the last valid selection; explicit-grant tools
  remain follow-up requirements.
- Shared schema limits reject oversized name/role/brief/history/tool maps at
  the designer stream, intent and create boundaries; the profile boundary
  accepts only bounded name/role. Create requires one valid `avatarMode` shape,
  and the summary shows persisted run limits and cannot hide billed avatar
  generation.
- Profile-change allowlist rejects model, system prompt, owner, visibility,
  policy, limits, binding, trigger and delegation fields.
- Request state transition matrix, expiry and supersession.
- Candidate and viewer presenters never emit protected app/credential fields.
- Gmail’s seeded catalogue row passes the ordinary entitlement/search
  presenter, but registry/user writes cannot mint `comms_google`, add endpoint
  config to it, or attach a Comms id through the MCP relation (and vice versa).
  A separately imported Community Gmail MCP row remains visibly distinct and
  can neither satisfy nor inherit the canonical Gmail setup request. Every MCP
  instance/connect/OAuth/secret/probe/import/projection entry point invokes the
  common backend guard before transport work.
- Connect controller: popup blocked/open/closed, severed opener, focus and
  visibility return, reload marker keyed by request, no persisted authorization
  URL, cold retry from server-owned request state, timeout, cancel and retry.
  Returned-flow polling recovers a dropped actor event; concurrent tabs obey
  the claim lease, and a closed claimant becomes recoverable after expiry.
- Scope matrix for PA, private owner/home, private non-owner/wrong channel,
  shared channel/team/org and deactivated members.
- Known-capability consent grants only the snapshot keys; later projection rows
  remain off.
- Credential resolution returns the winning principal and records the expected
  disclosure basis before MCP output is returned.
- Stable hidden continuation prompt contains no app/provider-authored text.
- Gmail permission presentation distinguishes imported read, compose/draft and
  send; granted-scope hashes cannot be mistaken for agent grants.
- Gmail selection/config reducers treat no resources as no import, apply the
  bounded history window and never widen a later incremental cursor beyond the
  selected labels. Stale job revisions cannot persist a page or checkpoint, and
  multi-label event/resource associations preserve deletion scope.
- Gmail search/read add user disclosure basis before returning events; send
  approval digest changes when account, recipients, subject, body or attachments
  change.
- Gmail send approval ignores any model-supplied digest, reloads the draft and
  computes the snapshot server-side; editing the draft before approval/send
  invalidates it and causes no provider call. Dispatch uses the sealed canonical
  bytes with `messages.send`, never the mutable draft id; a post-seal provider
  edit cannot change sent content, and an ambiguous provider result is not
  retried. The exact requested owner is the only viewer/resolver; generic
  organization-owner approval visibility does not widen this subject.
- Desktop platform/distribution matrix enables setup only for the supported
  signed direct Mac build. Resource-manifest verification refuses missing,
  wrong-architecture, replaced or unsigned guest artifacts; no local path or
  credential crosses the native IPC DTO.

### Database/service tests

- The owner-only early-access toggle updates only the dedicated product column;
  an admin, member or deactivated owner cannot flip it, and no UOA-owned
  identity/team field is mirrored or mutated as a side effect.
- Two Quick-create finalizations with one idempotency key produce one agent,
  one private home, one owner-authored initial message and one run. Avatar,
  model validation, audit and realtime side effects match the HTTP create path.
  `generate` produces one billed receipt/attachment across retries, `default`
  makes no provider call, and `attachment` rechecks access. No client endpoint
  can separately duplicate the initial message or kickoff.
- The selected active UOA team is named and revalidated at finalization; missing,
  stale, foreign or ambiguous team context creates nothing and opens the
  workspace picker rather than falling back to another team.
- Profile apply rechecks own agent, live owner, private visibility and exact home
  under lock; workspace agent, wrong thread, deactivated owner and foreign org
  all fail closed.
- A valid rename changes the agent and its derived exact private-home label in
  one transaction; a missing/mismatched home rolls back, and a role-only change
  does not rename any channel. The avatar attachment is unchanged and no model
  generation/billing call runs. Audit and both invalidations emit once.
- Two `begin`, `grant`, or `finalize` calls race: one transition and one
  continuation win.
- Two requests for the same app adopt one connection without crossing threads
  or clearing each other's browser markers.
- Membership/role/agent ownership/binding/app moderation/lock changes between
  offer and click fail closed.
- User A cannot read or act on User B's actionable card state; shared viewers
  receive only the neutral projection.
- OAuth state is one-shot; success, denial, expiry and callback-after-cancel are
  reconciled honestly.
- Two tabs racing to claim a returned flow produce one current lease and one
  finalizer; losing the actor event still recovers by viewer polling, and a tab
  crash before navigation becomes claimable after lease expiry.
- An authorized token with a failed post-auth probe does not resume the agent.
- Secret values, authorization URLs and upstream errors are absent from
  message/request/audit/event rows.
- Actor-scoped setup updates never expose target-user state through
  `message.updated` or shared message metadata; a dropped event recovers through
  REST rehydration.
- A busy agent/thread pends the kickoff and later drains it exactly once.
- Revoking the original human’s membership after offer, after finalize, or
  while the kickoff is pended prevents enqueue/drain from replaying stored
  actor context and moves the card to a named refusal state.
- Revocation creates one alert per health revision and recovery never resumes a
  schedule under a stale identity or moved org/team attribution.
- Gmail OAuth state is request/attempt-bound and one-shot across success,
  denial, stale callback and scope-upgrade races. Missing Google deployment
  config is a named readiness failure, never a green skipped path.
- Gmail reads cannot cross connection owner or unselected mailbox resources;
  draft/send use the correct per-user credential; disconnect/reauthorize do not
  affect another user. Initial import waits for selection and stays within its
  bounded date window; incremental events outside selected labels are ignored.
  Refresh runs through the coordinator under concurrency, and old key versions,
  scope-hash mismatch and rotating-token races fail closed. One reauthorization
  alert is emitted per revision.
- Existing Google connections migrate to paused/unconfirmed selection without
  treating prior default-on resources as consent. Old-revision jobs and pages
  cannot write after a new selection; revision recheck, event/association writes
  and checkpoint advance share one connection-row lock/transaction. Multi-label
  creates, label removal and deletion retain only proven event/resource
  associations.
- A Gmail send approval is bound to the connection owner, opaque draft revision,
  snapshot, run/tool/thread and target approver. A different organization owner
  cannot list, view, approve or resume it; live UOA/owner/home/connection
  revalidation and a pre-seal changed provider draft both prevent the send-once
  call. A post-seal change does not alter the immutable payload; a stale
  `dispatching` fence becomes `outcome_unknown` and never calls the provider
  again.
- Executor setup races create/reuse one private executor and current enrollment;
  refresh can recover the invitation; unsupported distribution/platform,
  unreviewed fingerprint/revision, offline daemon, stale grant and foreign agent
  cannot finalize or resume.
- Executor verification is queued by the server when the reviewed daemon/grant
  becomes eligible; a model cannot skip it. Failure records
  `verification_failed` with no continuation, while one successful completion
  CAS creates exactly one ready state and one continuation.

Database tests use a test-specific seed, scope every cleanup to it, and run
through Turbo with `DATABASE_URL` exported. No assertion relies on global queue
counts or globally oldest rows.

### Worker/evals

- One-prompt agent descriptions produce a useful name, role and behavioural
  brief without asking for inferable fields; ambiguous consequential choices
  remain visible rather than guessed. The created agent sees the original
  instruction once.
- Deterministic mock-LLM cases in English and non-English, slang and misspelled
  requests prove the model chooses whether to search/request; no code inspects
  phrases.
- The agent offers real server candidates, never fabricates an app/link, and
  does not claim success before state/tool proof.
- After ready kickoff it continues the original request and calls the newly
  available tool.
- It refuses to promise recurring monitoring when no trigger exists.
- A personal MCP result in a shared destination is withheld according to its
  user basis; live SSE does not leak pre-gate tokens.
- Gmail evals cover already-connected, read-only, draft-requested, send-requested,
  denied, revoked and no-trigger monitoring; the model never equates draft with
  send or claims a background inbox watch without a trigger.
- Executor evals cover browser versus signed Mac, basic file profile versus
  managed Codex, offline/review-needed state, and an installed-but-unsupported
  Claude artifact. The model never claims shell, path, Codex, Claude or Windows
  access from presence alone.

### Playwright user flows

Run headless against `http://localhost:5455` and retain screenshots for:

1. Quick create: one description fills the draft, **Create _Name_** lands in
   the private home, the original message appears once, and the agent responds;
   generate/default/attachment avatar choices show their exact cost/effect;
2. Quick-create refresh/double click/error plus Advanced handoff and a later
   in-chat rename confirmation;
3. one-choice OAuth happy path and automatic continuation;
4. three-choice card, publisher/trust and scope copy;
5. unknown capabilities → explicit second grant;
6. popup blocked and ordinary-link recovery;
7. cancel/deny/expired OAuth;
8. reload while signing in and return from provider;
9. API-key secure dialog with no secret in the feed;
10. member blocked from shared-agent setup with a useful owner doorway;
11. private owner agent happy path and non-owner refusal;
12. Gmail pre-auth card → fake Google consent → same card **Added** → select
    resources → search/read → draft; send shows a separate content-bound
    approval and cannot reuse draft approval;
13. Gmail missing config, deny, incremental scope upgrade, token revocation,
    reconnect and disconnect/data-delete;
14. direct signed Mac: **Use this Mac** → native picker/confirm test doubles →
    fingerprint/revision/grant → daemon online → file read → continuation;
15. browser, App Store Mac, Windows, missing artifact, stale invitation, offline
    daemon, app quit/crash and unreviewed revision render truthful
    blocked/recovery states;
16. disconnected/needs-reauthorization card and recovery;
17. exact return to both a channel card and a reply-panel card, including cold
    native return and message scroll anchor; OAuth begun from chat but returned
    into `/apps/gmail`, another Nessie route, or another tab still restores only
    the originating flow/card and finalizes once; two returning tabs and a
    closed lease holder recover without duplicate finalization;
18. phone-width card, keyboard-only operation, focus return, screen-reader
    labels and reduced motion;
19. disabled early access, owner enablement from Organization Settings, member
    refusal/doorway, and immediate tool/card reconciliation after enable/disable.

The card renders as a labelled `section`; its up-to-three single choice reuses
`components/primitives/TabBar.tsx` with `role="radiogroup"` rather than another
segmented control, capability toggles reuse `Switch`, and status/error copy
reuses `Notice`. Controls have app-and-agent-specific accessible names and at
least 44px touch targets. One polite live region announces progress, failures
use `role="alert"`, state is never color-only, motion respects reduced-motion,
and return restores focus to the card heading/action before announcing the
verified result.

Use a fake OAuth/MCP server in tests; no suite depends on Linear or another live
provider. Add a fake Google connector/OAuth fixture and a signed-test-manifest
desktop companion harness; automated tests never use a real mailbox, credential,
host path or production daemon.

### Signed native desktop and release tests

- On an Apple Silicon macOS 15+ test host, build/sign the direct distribution,
  launch the real app bundle, verify its notarized identity/resource manifest,
  pair through the native picker/confirmation and perform a confined file read
  plus a COW draft/review. A web-only mock is not release evidence.
- Prove quitting and force-crashing the app stop the supervised daemon, change
  the server/card to offline without duplicate continuation, and recover after
  reopening. Offline network, expired invitation and interrupted pairing each
  retain only recoverable server state.
- Refuse a symlinked workspace root/escape, replaced Node/daemon/VM artifact,
  wrong architecture, unsigned helper, descriptor revision mismatch and stale
  native challenge before starting a child. Logs/IPC contain no local path,
  credential, pairing secret or child output.
- Assert the App Store build contains no companion/runtime pack and Windows
  exposes no executor controls. The support matrix and download doorway in the
  signed binaries match the server-presented card.
- On the macOS test host, verify the native folder picker and confirmation
  dialogs with VoiceOver, Full Keyboard Access and increased-text/contrast
  settings. They use standard OS dialogs and labels, but that inheritance is
  manually evidenced because Playwright cannot reach the Tauri-native surface.

## Acceptance criteria

- From **New agent**, one natural-language description and one labelled create
  click produce exactly one named private agent with a useful role/brief, one
  owner-only home, the original instruction once, and an immediate first run.
  The bounded confirmation shows the exact model, limits, capabilities and any
  explicit generate/default/attachment avatar mode plus the selected UOA
  workspace/team. The server owns the one agent/home/message/run transaction;
  the browser only navigates to the receipt. No broad
  self-update authority is added; a later rename updates the exact private-home
  label atomically and leaves the existing avatar unchanged unless the owner
  separately chooses a billed regeneration.
- A user can create/configure an agent with **Request app connections**, give it
  a normal-language job, and receive real app options inside that agent's chat.
- Nothing is installed or granted before an authenticated, clearly labelled
  user action.
- The provider owns the sign-in UI; return to Nessie is automatic and does not
  require the user to send another message.
- After connection and explicit exact-key grant, one continuation run starts and
  the agent can immediately call the app. Duplicate tabs/clicks cannot start a
  second continuation.
- The same connection is visible/manageable at `/apps/:slug`; disconnect and
  agent access there immediately change what the card and worker allow.
- Ordinary agents never receive connector-admin powers, raw authorization URLs,
  credentials, instance ids, or the ability to choose another user's identity.
- User/private credential data carries disclosure provenance through the MCP
  tool result and all later replies.
- A revoked recurring credential produces an explicit reauthorization state and
  exactly one durable alert rather than silent repeated failures.
- Gmail is production-configured and works end to end from the pre-auth card.
  The same per-user account backs resource selection, search/read and draft;
  send is a separate exact approval. A read-only connection never renders as
  draft/send capable. OAuth alone imports nothing: selected labels and the
  visible bounded history window constrain both backfill and incremental sync.
- In the signed direct-distribution macOS 15+ Apple Silicon app, the executor
  and every artifact for the advertised file/managed-Codex profile ship inside
  the app. A user installs no second CLI, copies no token and enters no local
  path into chat; the resumable card completes native pairing/review/start, the
  server proves access with a request-bound bounded operation before starting
  the agent continuation, and the card accurately
  says that V1 remains available only while Nessie Desktop is open. A failed
  verification failure produces a recovery state and no access claim or duplicate
  continuation.
- Browser, Mac App Store and Windows builds state why local execution is
  unavailable. Windows and Claude are not presented as supported merely because
  their shell/artifact can exist.
- The feature is visually verified on desktop and phone layouts and covered by
  durable mock-LLM, service, OAuth, concurrency, authorization and provenance
  tests.

## Main risks to hold during implementation

1. **Giving “self setup” broad control-plane authority.** Reuse the Designer for
   the creation draft and a narrow profile-diff service afterward; never expose
   the owner-only update route or policy fields as a runtime self-update tool.
2. **Partial creation presented as complete.** Agent, home, initial message and
   run are idempotent and have explicit state; later app/executor/trigger steps
   remain visible requirements rather than silently failing after creation.
3. **Treating connection as grant.** Preserve `requiresExplicitGrant` and exact
   policy keys even if one well-labelled click captures both decisions.
4. **Resuming from the unauthenticated callback.** Wait for a fresh signed-in
   client and re-check live UOA membership before enqueueing.
5. **Credential-data laundering.** Connector dispatch must feed the disclosure
   sink; UI privacy alone does not protect the model's reply.
6. **A second OAuth implementation.** Chat adapters parameterize the existing
   controller and call `connectApp`/`startOAuth`; no card-owned exchange or
   redirect logic.
7. **Scope that cannot reach the agent.** The server computes and states the
   scope before consent, then proves it again before grant/finalize.
8. **Prompt injection through catalogue/provider copy.** The continuation
   kickoff is constant and the model never receives an authorization URL.
9. **Stale cards claiming success.** Every actionable render and finalization
   reconciles request state with live connection, grant and membership facts.
10. **Promising a watch without a trigger.** Connection and recurring execution
   are separate; agent copy and evals must keep them separate.
11. **Turning a display card into an authority surface.** Privileged setup uses
   its own first-party schema; externally populated `IntegrationUiCard` links
   remain informational only.
12. **Leaking personal state through shared realtime.** Actor-scoped
    invalidations lead to viewer-specific refetches; shared message metadata
    never carries connection identity or status.
13. **Shipping a Gmail card instead of Gmail capability.** Release requires
    real search/read/draft tools, correct per-user scope and disclosure, plus a
    separately approved send. Current read-only sync and a green card are not
    enough.
14. **Two Gmail authorities.** The first-party communications connection is the
    account/credential source. Do not silently install a second catalogue Gmail
    MCP app or make the user authorize twice.
15. **Calling the partial desktop companion “built in.”** File/COW support is
    already packaged, but managed Codex is not zero-install until every signed
    guest artifact and bounded credential picker ships in the direct Mac app.
16. **Turning local execution into host shell.** Keep the executor protocol’s
    sandbox, COW, reviewed operations and no-path/no-output IPC boundaries; the
    smooth setup flow does not authorize ambient commands.
17. **Platform wishful thinking.** A Windows Tauri bundle and a Claude artifact
    are not an executor implementation. Keep both visibly parked until their
    complete operation, credential, sandbox and lifecycle paths exist.
18. **Hidden cost or unbounded model output during creation.** Show billed
    avatar generation and persisted run limits before the click; share finite
    schema limits across Designer, intent, create and profile application.
19. **Resource selection that does not constrain Gmail sync.** OAuth is not
    import consent. Gate ingestion on an explicit bounded selection and enforce
    the same predicate in initial and incremental paths.
20. **Implying an always-on executor.** The packaged daemon currently follows
    the desktop app lifecycle. Say so and test quit/crash recovery rather than
    promising unattended host access.
21. **Leaving the PA bypass beside the card.** The four mutation-oriented PA
    connector tools are removed before the safe journey can be enabled for any
    organization or agent; startup, registry and rollout tests prove the unsafe
    and safe tool sets cannot coexist globally, including in the PA.
22. **Forking Gmail outside Apps.** The seeded trusted catalogue identity and
    typed comms backend keep search, entitlement and product home on the one
    Apps surface while credentials remain solely in `CommsConnection`.
23. **Approving a model-authored Gmail digest.** The server reloads and hashes
    the real draft/account facts at approval and send time; model arguments are
    never the approval authority.
