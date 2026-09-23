# DeepWater — default OFF, explicit per-agent grant, always via Ledger

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- DeepWater is usable as a tool by any permitted agent, but **default OFF with an
  explicit per-agent grant required** and **always routed through Ledger**:
  enabling DeepWater for a team (owner-only team-enablement toggle) provisions
  a **team-scoped** tool-projecting `McpServerInstance` from the `deep-water`
  catalog entry, resolves Ledger's adapter from `LEDGER_DEEPWATER_MCP_URL`
  (canonical hosted value
  `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; enable fails loudly with
  `LEDGER_DEEPWATER_MCP_URL_UNSET` when unset or
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE` when the linked first-party catalog is
  missing), installs a bearer HTTP transport using `LEDGER_PROXY_TOKEN` as
  Nessie's one deployment-wide, product-bound Ledger app API key (never a
  per-user credential), and projects the manifest's tools — the brief-first
  contract (manifest 0.3.0): `research_scope_start`, `research_scope_reply`,
  `research_scope_get`, `research_scope_launch`, `research_status`,
  `research_report`, `research_cancel` and `research_list`, all sensitive, and
  never `research_start` — as active `mcp_research_*` tools. The tools are
  `deepWaterBriefTools` in `@nessie/mcp-manage`, built from the shared brief
  vocabulary, and a contract test deep-equals the manifest's input schemas
  against `deep-water.ledger-contract.json` — Ledger's own
  `docs/contracts/deepwater-mcp-tools.json`, copied byte-for-byte and never
  edited here; the test pins its SHA-256 to the Ledger commit it was copied
  from, so its descriptions and annotations are Ledger's too, and a refresh is
  a deliberate re-copy plus a new pin. The manifest's own descriptions are
  Nessie's and deliberately differ: Ledger tells its clients to read the
  planner's reply with `research_scope_get`, while a Nessie agent is woken in
  its thread. `MANAGED_DEEP_WATER_TOOL_NAMES` (the names whose `mcp_<name>`
  DeepWater owns) is derived from the manifest plus `research_start` until the
  launcher retires. Ledger serves these tools from its brief release, which must
  be live before this manifest reaches production. A team still on the
  launcher contract (manifest 0.2: `research_start`, `research_status`,
  `research_report`, `research_list`, `research_cancel`) is
  `contract_outdated` until its owner enables DeepWater again.
  **Contracts move in place.** An owner enabling DeepWater again runs
  `projectDeepWaterTeamContract`: a connector already on the manifest's
  contract is re-pinned (keeping richer probed schemas); one on an older
  Ledger contract is upgraded — rows for tools both contracts share keep their
  registry ids and grants, rows for dropped tools are deleted only once no
  launcher run (`uoa_identity IS NULL`, still queued, running or
  `needs_setup`) could dispatch them (else 409 `LEDGER_DEEPWATER_ACTIVE_RUNS`
  and the team keeps its tools), new tools are inserted, and every agent
  holding the team's bundle marker is granted the new bundle; the legacy
  direct-provider contract is replaced outright and must be granted again.
  Agent access and launch authorization are computed from the names the
  team's connector actually projects: a connector on another contract than
  the manifest's reports `contractOutdated` (`DEEP_WATER_CONTRACT_OUTDATED`),
  never a missing grant, and stays revocable. A research brief can be opened
  only through a connector projecting exactly the brief contract; any other is
  `contract_outdated` for briefs. Each sibling product must
  use its own app API key; app keys are never reused as webhook signing secrets.
  Transport authentication and caller identity are separate: every call carries
  a short-lived `X-Nessie-Context` RS256 JWT with non-null
  user/org/team/agent/run attribution and, for the linked SSO user, an
  `X-UOA-Delegation` RS256 JWT minted through UOA token exchange. The stable UOA
  subject is required for DeepWater; an optional `active` UOA org/team is
  emitted only when both values exist and never replaces Nessie's local
  tenancy. Every new renewable UOA login requires a nonnegative `tv`
  authentication epoch and binds immutable `{sub, org, team, tv}` proof into
  the signed Nessie access session and its refresh family. Nessie stores UOA's
  opaque refresh token only as AES-256-GCM server-side state coupled to that
  family; the browser receives only Nessie's unrelated rotating cookie. The
  product link proves stable subject/status/credential epoch only; its mutable
  active org/team fields are last-seen metadata, never the proof source.
  Delegation assertions and caches use the immutable session epoch and require
  exact equality with the current link and selected local team. Family/user
  advisory locks serialize rotation, replay, issuance, logout, password change,
  deactivation, and credential erasure across replicas; a replay barrier makes
  reversed predecessor/current HTTP responses converge on one cookie. UOA HTTP
  renewal runs outside database transactions between short locked preflight and
  finalize phases; if an ancestor replay wins mid-flight, finalize adopts the
  accepted UOA successor in place behind the unchanged local cookie. Login
  confirms current direct Nessie access before local mutation, product-link
  epochs never regress, and first-team provisioning is exact-team
  locked. DeepWater's product auth mode remains `uoa_sso` so first login
  creates the account link even though MCP transport auth uses Nessie's app API
  key. Generic Ledger AI calls may omit UOA delegation, but never the five-field
  local attribution; user-triggered system jobs carry their durable origin and
  derive stable named system agent/run UUIDs, failing before provider dispatch
  when origin is missing. Personal DeepWater credential overrides are forbidden
  and removed by migration, so they cannot shadow the product-bound app API key.
  Generic instance test, refresh, healthcheck, and delete operations reject the
  integration-managed instance with `MCP_INSTANCE_MANAGED_BY_INTEGRATION`;
  generic secret writes are also rejected, and PA probe/uninstall tools tell
  callers the connector is managed by its product; team enablement is its sole
  lifecycle path. Ledger
  owns job isolation, budget enforcement, audit, and raw usage metering for
  both PA and shared-agent calls; UOA alone rates that usage commercially.
  `NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/openai` is the
  deployment-wide inference chokepoint for every run the ORGANIZATION pays for;
  runtime routing rewrites it to Ledger's
  `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi, or custom
  provider, including designer/orchestrator calls; embeddings resolve their own
  `/v1/:serviceId` segment (see "Embeddings" below). The one sanctioned
  exception is a **personal model subscription** (see "Personal model
  subscriptions" below): a run pinned to an agent owner's own linked plan
  bypasses this chokepoint entirely — no Ledger connection, no signed
  attribution, no Ledger metering — because the organization is not paying for
  it and its credentials are the person's, not the deployment's. That lane is
  structural, decided once at run admission, and never a fallback. If the
  deployment-wide URL is absent, signing is decided after the effective
  organization provider-record URL resolves, so a Ledger route an organization
  provider record introduced still receives complete attribution. **Inference
  signing is best-effort by deployment, mandatory once available.** With the
  `UOA_*` signer configured, every Ledger inference call signs and still fails
  closed when the originating user has no linked SSO identity. With no signer
  configured at all — an operator running on a personal Ledger API key — the
  call goes out on `NESSIE_MODEL_API_KEY` alone, because Ledger authenticates
  that bearer and decides per token whether signed provenance is also required;
  Nessie must not refuse on Ledger's behalf and force a UOA OAuth client on a
  deployment whose token does not need one. The condition is read once from
  process env at startup (`loadLedgerIdentitySettings` returning null) and is
  unreachable per request, per organization, or per user, so a signing
  deployment cannot be downgraded. This applies to model/embedding inference and
  its model catalogue only; DeepWater, `web_search`, and billing keep their own
  product-bound credentials and identity requirements unchanged.
  Every DeepWater call reuses one stable `tool_call_id` across logical
  retries — the provider's id for an agent's call, `brief:<runId>:<actionId>`
  for a person's action — because Ledger keys each scope tool's idempotency on
  it, so a retry finds the brief or turn it opened instead of paying for
  another. An agent's `research_scope_start` claims its product run before the
  call leaves (see "Agents and briefs" below). The projected tools and `deep_water_run_update` are flagged
  `requiresExplicitGrant`, so an agent sees them ONLY when its `toolPolicy`
  explicitly allows them (`=== true`) **and** the team-scoped instance reaches
  the run; grants never bypass tenancy, and absent/inherited denies. Owners use
  the targeted `/api/mcp/tools/.../policy-targets/...` mutation (one locked
  policy-key merge, never a full-policy replacement); canonical DeepWater rows
  take the team-transition lock, re-read their projection generation, then take
  the agent lock. Its minimal target list
  includes the Personal Assistant without exposing PA bindings/activity through
  `/api/agents`. `/api/integrations/products/deep-water/agent-access`
  manages/reads the manifest's MCP projections plus `deep_water_run_update` as
  one exact bundle whose size is derived from the manifest, never hard-coded;
  the updater counts only while its registry row is enabled and active, matching
  worker exposure, so a disabled builtin cannot authorize metered work, and a
  grant's final enablement/instance/policy reads are linearized under the team
  lock then agent-policy lock. Whether a person can start research is the
  `research` readiness on the `deep-water` entry of
  `GET /api/integrations/products` (`ready`, `team_off`, `contract_outdated`,
  `account_not_linked`, `unavailable`): the team switch, an active connector on
  the brief contract, Nessie's Ledger configuration, and the viewer's linked UOA
  identity for this team. The Personal Assistant's grants are **not** an input
  — a person's brief never goes through an agent. Owners can also grant/revoke the bundle
  for shared agents. Generic agent create/PUT cannot write explicit-grant keys
  or DeepWater provenance markers; a locked PUT preserves them from the current
  row; clones and spawned subtask children strip them, PA bootstrap config
  cannot inject them, generic responses redact the server provenance markers,
  and Agent Designer omits their switches. Generic shared-agent create, list,
  parent selection, hierarchy/status/activity/realtime reads, and channel
  binding are exact-organization operations;
  system/global agents remain confined to dedicated bootstraps. Bundle
  provenance keeps the org-wide updater while any team/manual grant needs it;
  its individual OFF switch is disabled until those dependencies are revoked,
  while partial/drifted team projections and a disabled updater remain
  revocable. Registry callability and cleanup identity are separate: a disabled
  updater cannot satisfy readiness, but its protected allow is still removed by
  bundle revocation. Bundle and
  individual lifecycle revocation return 409 while work that needs the grant
  is open, decided by `guardDeepWaterPolicyRevocation`'s mode: `legacy` (the
  contract upgrade and the org-wide updater) waits for launcher runs still
  queued, running or `needs_setup`; `agent` (one agent's revocation) waits for
  those and for that agent's own briefs not yet launched (`queued`,
  `drafting`). A launched brief and a person's brief never block a
  revocation. There is no force override. Each
  org/team enable or disable is cross-process serialized by a PostgreSQL
  transaction-scoped advisory lock; connector rows and the product toggle
  mutate in the same transaction and roll back together on failure. Disable
  returns `LEDGER_DEEPWATER_ACTIVE_RUNS` while a queued, drafting, running, or
  `needs_setup` research run still references the connector. Every refusal an
  open research causes — a disable, a contract upgrade, a grant revocation —
  names that run in the 409's `details` by id, status, origin and requester
  only (never its topic), so a team owner or admin can cancel it from
  DeepWater's app page (`POST …/research-runs/:runId/cancel`) and try again.
  Even a
  null external id remains a conservative blocker because Ledger dispatch may
  be in flight; an owner cancels a launcher run Ledger never received locally,
  one with a research id through Ledger, and one whose start may still be in
  flight not at all until its handoff resolves it. A brief DeepWater never
  named is cancelled locally once nothing can still open it (see "A brief
  DeepWater never named is cancelled here"), so no open brief blocks a
  disable until the reap. Disable
  targets only the instance linked from the first-party public product, so
  private same-name catalogs are untouched. `deep_water_run_update` is not
  PA-only and takes tenancy strictly from the run context (same team + thread;
  Knowledge page validated against the org). It never accepts a cost, price,
  charge, tariff, or currency: Ledger's DeepWater REST/MCP status, report, and
  list contracts expose no commercial amount, and UOA is the sole commercial
  authority.
  Each DeepWater connector call writes an operational connector usage event
  against the run's immutable `requestedByUserId`; it has no cost fields and
  is excluded from every local
  cost aggregate. The exclusion is `metadata.metering = 'operational_only'`,
  stamped by `recordConnectorUsage`'s zod contract in
  `packages/runtime/src/connector-usage.ts`, and it is the only predicate the
  cost report (`api/src/services/token-ledger.ts`,
  `BILLABLE_CONNECTOR_COST`) reads. Migration
  `20260720234500_retire_deepwater_local_cost_mirror` erases historical local
  amounts, converts only their existence into a cost-free server-only dispatch
  recovery marker, drops the obsolete Product-run cost columns, and installs a
  database trigger rejecting future DeepWater connector-event cost writes.
  Product run APIs and UI expose no DeepWater cost; customer totals
  come only from UOA's statement.
  Re-enable preserves richer probed schemas only
  when tool names exactly match the current Ledger contract, upgrades an older
  Ledger contract in place (see "Contracts move in place" above), and replaces
  legacy direct-provider projections, which must be explicitly re-granted.

## Legacy launcher handoff — launcher runs only, retired in phase E

These rules govern only launcher runs: DeepWater product runs from before
research briefs (`uoa_identity IS NULL`), started through the retired research
launcher and handed to the Personal Assistant. New research never takes this
path — the launcher route is gone and every research starts as a brief — but a
handoff already in flight keeps its guard until phase E retires the guard, the
launcher builders and `deep_water_run_update`. The guard wraps only a turn
whose trigger carries `integrationLaunch`; the run binder wraps every other
DeepWater call, so the two never see the same call.

- The worker enables handoff enforcement only from server-authored message
  metadata `integrationLaunch.{productSlug,runId}` for `deep-water`; ordinary
  messages remain unguarded. The durable run lookup requires that exact run id,
  message, organization, team, and thread, and a missing/mismatched row fails
  closed. For that exact Product run, the worker atomically binds the first
  `research_start` provider tool-call id and exact arguments before transport.
  A still-clean Product run moves to `failed` only for a validated Ledger-local
  pre-start rejection (`invalid_request` 400/401, `budget_exceeded` 402, or
  `forbidden` 403), or for Nessie's own budget block while the row remains
  truly queued, uncorrelated, and undispatched. Conflicts, upstream rejections,
  5xx, malformed errors or malformed
  successful tickets, throws, timeouts, uncertain claims, and uncertain ticket
  persistence are fatal ambiguity: the Nessie run stays `running` while the
  queue retries, using the exact persisted id and arguments. A validated
  matching `rs_...` `id`/`job_id` plus exact Ledger status is persisted before
  success is returned; a retry then replays that ticket and status locally
  without another Ledger call. Managed DeepWater owns the canonical
  `mcp_research_*` names — derived from the manifest, plus
  `mcp_research_start` while legacy handoffs exist — even when private
  connectors collide or the grant is absent, so the server-authored prompt can
  never dispatch a foreign connector.
  Same-batch status/report/cancel calls are pinned
  to that persisted id; `research_list` and delegation stay blocked for the
  launch turn so result delivery cannot be hidden inside a timed-out sub-agent.
  Run-update/Knowledge calls remain blocked until exact start-result delivery
  and remain blocked for an abandoned timed-out attempt.
  The start result is acknowledged with its invocation-specific delivery token
  only after connector telemetry and tool-end recording settle and its tool
  message is incorporated; timeouts during definitive-failure persistence or
  pending result delivery therefore stay fatal and retry-safe.
  Ordinary setup, inference, and callback failures are promoted to that fatal
  path while the handoff remains unresolved. A budget block may fail only a
  truly uncorrelated queued Product row before terminalizing the Nessie run;
  correlated running work remains recovery-safe, and a terminal claim race
  quarantines a still-clean row. A late definitive rejection may move only the
  exact correlated `needs_setup` row to `failed`.
  Missing or duplicate exact handoff rows fail closed before inference;
  on retry exhaustion every clean exact candidate moves to `needs_setup`, while
  rows carrying external/dispatch/report/Knowledge evidence are preserved. A
  validated ticket that arrives after final-attempt recovery still attaches
  atomically, clears the stale recovery detail, preserves its exact Ledger
  status, and keeps the Product run `running` until mandatory terminal
  reconciliation, so accepted provider work is neither orphaned nor prematurely
  unblocked by the timeout race. Fatal
  tool calls still emit their paired sanitized end event, and every started
  same-batch tool wrapper settles before the queue attempt is released.
  Completion also fails fatally if the model omits the required start. Every
  other DeepWater call belongs to the run binder.
  PA message, run attachment, PA run/task, and direct `run.execute` enqueue
  commit atomically; product handoffs bypass chat engagement decisions while
  ordinary chat keeps its existing orchestration path. Duplicate enqueue
  conflicts roll back the duplicate unit, and realtime publication is
  post-commit/non-fatal.
- The external report URL is persisted only from Ledger's authenticated
  `research_start` structured response after its origin and exact job path are
  validated; source count is persisted only from the authenticated
  `research_report` references array. Both carry server-only provenance markers
  before they are exposed, and agent-authored run updates cannot set, replace,
  or mark either value as trusted. Source persistence atomically repairs an
  already-created exact per-run connector usage event (recording the
  authenticated source units), making same-batch report/update order
  irrelevant. The locked write also enforces a terminal start ticket's exact Product status
  mapping (`complete` → `completed`; negative terminal outcomes → `failed`).

## Research briefs — the product-run binding

Every research Nessie starts is agreed with DeepWater's planner first, as a
brief that lives on one `product_integration_runs` row from the first message
to the delivered result. These rules hold for every brief row; the brief API,
worker and card are built on them.

- **Two creators, one lock.** A brief row is written only by
  `createPersonDeepWaterBrief` (a person, keyed by the request's `actionId`) or
  `claimAgentOriginRun` (an agent's `research_scope_start`, keyed by the calling
  Run and its provider tool-call id), both in `@nessie/mcp-manage`. Both run
  inside the team transition lock and re-read the team switch and its active
  connector on the brief contract there, binding the row to that connector; the
  agent path also re-reads its `research_scope_start` grant under its policy
  lock. So a brief either exists before a disable or revocation looks for open
  runs, or is never written. Both are idempotent on their key.
- **The legacy marker is exact.** Both creators write the captured
  `uoa_identity` and `scope_json` together, and launcher rows and other
  products write neither; the `product_integration_runs_brief_binding_shape`
  CHECK makes `uoa_identity IS NULL` the exact legacy marker.
- **Sources only grow.** `source_scopes` and `disclosure_sources` record what
  the research was built from, never destination-subtracted. A person's brief
  starts with its room's channel scope and their own lineage when the room is
  not public (a private or protected channel, or their Personal Assistant DM),
  read by `createPersonDeepWaterBrief` from the origin thread itself
  (`deepWaterPersonOriginSources`); an agent's claim starts with its run's
  consumed sources. Every content-bearing agent call unions its run's sink in
  with `unionDeepWaterRunSources` under the row lock, which never removes or
  reorders an entry.
- **Stable UOA ids only.** `uoa_identity` is `{subject, organizationId, teamId,
  tokenVersion}` — never an email or a name. `refreshDeepWaterRunIdentity`
  renews it from a live action by the same subject, organisation and team, never
  to an older epoch, and clears a `requester_identity_changed` block in the same
  statement.
- **One research, one run.** A Ledger research id binds to at most one product
  run (partial unique index on `(product_slug, external_run_id)`). It attaches
  once, from whichever Ledger read names it first — a tool's ack or the watch —
  and a later read naming another id is a contract violation, not a race. The
  attach always makes the run `drafting`, even when that first read already
  reports the research finished, so the watch keeps claiming it until the
  delivery lands.
- **Ledger owns a brief's status.** `deep_water_run_update`, the launcher's
  agent updater, refuses every brief row (`DEEP_WATER_BRIEF_RUN_LEDGER_OWNED`)
  and only ever matches `uoa_identity IS NULL`: a status or research id an
  agent wrote would end the watch before the research was delivered.
- **The projection only advances.** Ledger reads apply under the row lock
  (`applyDeepWaterScopeResult`, `applyDeepWaterStatusRead`,
  `applyDeepWaterLaunchTicket`). The brief content moves only on a strictly
  greater revision, the planner turn only on a greater `(seq, status rank)`,
  and the status only forward (`queued` → `drafting` → `running`): a read
  issued before a launch can land after its ticket, so a read never moves a
  run back. Ledger reverting a launch Water refused (an inline 409 `scope-*`)
  is known only to whoever made the launch call: a person's launch job moves
  the run back with `revertDeepWaterLaunch` while its launch is the action in
  flight, and the run binder moves an agent's refused launch back with
  `revertDeepWaterAgentLaunch`.
  `cancelled` is written directly; a finished research is written only by the
  delivery claim.
- **A person's action happens once.** `beginDeepWaterPersonAction` records
  the action in flight and enqueues it in one transaction, keyed by its
  `actionId`; a request whose key is already queued or done is a replay
  whatever that action's outcome, and is never re-armed. That is decided
  before anything else — the busy check and the route's own checks (the
  revision, still drafting) — because a retry whose response was lost finds
  the brief already moved on by its own action, and refusing it would make the
  client resend under a new id and pay for a second planner turn. One action
  is in flight per brief and is cleared only by its own turn or outcome, with two
  exceptions: a cancel replaces any in-flight action, and a cancelled or
  finished brief ends whatever action was in flight — including a brief Ledger
  refused to open (`failUnstartedDeepWaterBrief`), whose opening action ends
  with its error code in the same write. The job carries `acceptedAt`, stamped
  under the row lock from the same clock read as the action's `since`; its
  retry window runs from it, never from the queue row's `enqueued_at`, which
  every retry moves forward.
- **A brief DeepWater never named is cancelled here.** A cancel through
  Ledger needs a research id, so `cancelUnopenedDeepWaterBrief`
  (`deepwater-local-cancel.ts`) cancels an unnamed `queued` brief locally,
  under its row lock, once nothing can still open it: not while a person's
  opening job is queued or running, an agent's origin run is `pending` or
  `running`, or a watch replay of the agent's start is queued or running —
  any of those could open a paid brief no row points at, so the cancel is
  refused as `DEEP_WATER_BRIEF_BUSY` meanwhile. The cancel records its
  `actionId` on the run (`result_json.cancelActionId`), so a retried request
  is a replay, and an answer that names a research afterwards is not attached
  (logged). An agent's retried `research_scope_start` for a cancelled brief is
  never sent again. The view offers no Cancel on a person's brief whose
  opening is in flight and younger than the action retry window
  (`isDeepWaterBriefOpening`); past it the job has given up or died, so Cancel
  is offered and the route decides from the job itself.
- **Delivery happens once.** `claimDeepWaterDelivery` writes the terminal
  status with `delivered_at` in one conditional statement; the reply or wake is
  written in the same transaction. A block (`blockDeepWaterDelivery`) is set
  once, with its one notice; a retryable block keeps the run `running` so its
  connector stays for the retry.
- **One view of a run.** `toDeepWaterResearchRunView` and `toDeepWaterBriefView`
  (`@nessie/runtime`) build every research view from its row: the status of
  contract §2.4 (`starting` while a launch is in flight, `needs_setup` as a
  `needs_operator` failure), the planner's side from register (b) and the
  person's matching action (`deepWaterPlannerTurnView` — a planner failure is
  never a person's action error), transcript authors from Nessie's own
  `turnAuthors`, and the viewer's actions (`deepWaterViewerActions`). The words
  for a failure, a planner failure and an action error come from one table
  (`deepwater-brief-view-copy.ts`) that the worker's notices share.
- **Who may see a run** is `isDeepWaterRunVisible` in `@nessie/runtime`, the
  one predicate for lists, detail, the card and artifacts: the origin thread's
  live chain for anyone in it, the full source basis for the requester's
  portable reach, and a person's brief stays private until it is launched.
- **One research list.** `GET /api/integrations/products/deep-water/research-runs?cursor&limit`
  answers `{items: ResearchRunView[], meta}`, newest first, every row — brief
  or launcher — through `isDeepWaterRunVisible` and the one view mapper. It
  replaced the team-wide launcher list at the same path in the same change
  (that list had no viewer predicate, so a brief row there would have shown a
  colleague's unlaunched brief, its topic included, to the whole team); there
  is never a second handler on the path or an unfiltered list of briefs.

## Research briefs — a person's actions and an agent's calls

Both ways into a brief end in the same Ledger calls over the run's own team
connector, and the same projection applies every answer.

- **The brief API** (`api/src/routes/integrations/research-run*.ts`, under
  `/api/integrations/products/deep-water/research-runs`): the list, one
  research, its brief, and the person's actions — open (`POST`), reply
  (`/messages`), Start (`/start`), `/cancel` and `/deliver`. The API holds no
  DeepWater identity path (contract D10): each action is checked under the
  run's row lock, recorded as the action in flight and enqueued as one
  `deep_water.brief.action` job (`/deliver`: `deep_water.run.deliver`) in the
  same transaction, which also brings the watch's next read to 5 s, and is
  answered 202. The job carries the acting person's live UOA identity from the
  request and the instant Nessie accepted it (`acceptedAt`). A person opens a
  brief only when the team is ready, decided in the order readiness shows it
  (`resolveDeepWaterResearchAccess`: the team's switch and connector, Nessie's
  Ledger configuration, then the person's own link), so every surface names
  the same first remedy; the switch and connector are read again under the
  transition lock. A reply is judged against the revision Nessie last saw
  (`DEEP_WATER_BRIEF_REVISION_CONFLICT` with `currentRevision`); Start counts
  the pillars it carries, so hand-written pillars launch even after the planner
  failed (`DEEP_WATER_BRIEF_INCOMPLETE` only when neither has one). Words sent
  to DeepWater are refused with `SECRET_INTERCEPTED` before anything is stored,
  as the composer refuses them. A person may open a brief only from a
  conversation they can post in (`origin {kind:'thread'}`) or their Personal
  Assistant's (`{kind:'personal'}`, resolved on the server).
- **The worker carries a person's action out**
  (`worker/src/control/deepwater-brief-action.ts`): one Ledger call per action
  — `research_scope_start`, `_reply`, `_launch` or `research_cancel` — signed as
  that person with the identity the job carries and the `deep-water.brief`
  system component, tool-call id `brief:<runId>:<actionId>`. The answer goes
  through the shared projection with the action's own id; a successful action
  renews the requester's captured identity and lifts a changed-sign-in block
  (`refreshDeepWaterRunIdentity`). Ledger's refusal ends the action with the
  dialog's code (`busy`, `revision_conflict`, `not_ready`, `brief_limit`,
  `message_limit`, `budget_exceeded`, `forbidden`, `not_drafting`, `rejected`);
  a refused opening fails the brief (it never existed); a `scope_*` refusal of a
  launch moves the run back to drafting (`revertDeepWaterLaunch`), because only
  this job knows Ledger reverted it. A Nessie identity failure ends it as
  `identity_required`, never as ambiguity. An unreachable Ledger (transport
  failure, timeout, 5xx, 408, 429, `upstream_unavailable`) is retried with the
  same tool-call id — which Ledger replays rather than repeats — for 30 minutes
  from the job's `acceptedAt` (`DEEP_WATER_ACTION_RETRY_WINDOW_MS`), then the
  action ends as `unavailable`; a launcher run's cancel stops the same way. An answer
  outside Ledger's contract is deterministic and is never retried. An action a
  read, a cancel or the stale-action settle already ended is not sent.
- **An owner's cancel is the owner's own.** A team owner or admin may cancel
  any open research in their team, whoever asked and whether or not they may
  read it (a non-reader is answered `{id, status}` only); the job signs as the
  owner with the owner's live identity and the `deep-water.owner-cancel`
  component, which Ledger checks against the owner's UOA team role — never as
  the requester. The Nessie audit (`integration.research.cancelled`) names the
  owner as the actor and the run by id — when their cancel of a brief or a
  launcher run is accepted for Ledger, and for every cancel Nessie makes
  itself (an unnamed brief, a launcher run Ledger never received), whoever
  asked. Every cancel is answered once per `actionId`: a retried request whose
  answer was lost gets 200 with the run as it now is.
- **Agents and briefs — the run binder** (`worker/src/run/deepwater-run-binder*.ts`)
  wraps every DeepWater call outside a launcher handoff turn.
  `research_scope_start` claims its run with `claimAgentOriginRun` before the
  call leaves — the team transition lock, then the agent's policy lock and a
  re-read of its `research_scope_start` grant — with the person it acts for as
  requester (none means `LEDGER_UOA_IDENTITY_REQUIRED`, and nothing is written)
  and the calling run's consumed sources. Ledger's answer attaches the research
  and posts the agent's research card; a definitive refusal fails the run; a
  throw, a transient failure, an answer outside the contract or an answer
  Nessie could not record leaves it `queued` for the watch to replay, and the
  agent is told the brief may have started and not to call
  `research_scope_start` again. After a start or a
  reply the agent is told the planner is working and that it will be woken
  there. Every other call naming a research resolves that research's run in
  the same organisation and team and must act for its requester
  (`DEEP_WATER_RESEARCH_NOT_FOUND` otherwise, before Ledger); changing a
  research the team never opened is refused, reading one feeds the person's
  own scope. Reads (`research_scope_get`, `_reply`, `research_status`,
  `research_report`) first require that the requester still reaches everything
  the research was built from (`DEEP_WATER_SOURCE_ACCESS`), then feed that
  basis into the reading run; a reply or an editing launch unions the run's
  whole sink into the research first. An agent never publishes
  (`DEEP_WATER_PUBLISH_REQUIRES_PERSON`). Every answer goes through the shared
  projection and renews the captured identity; one outside the contract is
  logged and not applied. `research_list` feeds the person's own scope and
  every listed research's basis before the answer reaches the agent; a list
  Nessie cannot read is withheld (`DEEP_WATER_LIST_UNREADABLE`), never passed
  through unbound. A `scope_*` refusal of an agent's launch moves its run back
  to drafting and tells the agent the research did not start.
- **A shared agent can use DeepWater only in a run with no private-conversation
  lineage.** The private-conversation write gate applies to every DeepWater
  tool, reads included, with no DeepWater exemption: exporting other people's
  private words is theirs to decide. That rules out a DM with a shared agent, a
  private channel and a group DM; the Personal Assistant is unaffected. The gate
  runs before the toolset dispatches, so a refused `research_scope_start`
  writes no run, and the routing prompt tells the agent not to retry but to
  point the person at the Research button in that chat — the person's own
  brief is the authorised path.
- **The routing prompt** (`worker/src/run/execute/research-routing.ts`) names
  only the DeepWater tools the run was given: agree a brief first, the planner
  answers by waking the agent (never poll or wait), read with
  `include_transcript` only when the whole conversation is needed, ask the
  person with a waiting card only for what only they can answer, launch at the
  current revision, never start the same research twice. A team still on the
  launcher contract keeps the launcher routing until its owner updates.

## Research briefs — the watch, delivery and wakes

Nothing pushes from Ledger to Nessie. The worker watches every open brief and
research through Ledger (`worker/src/control/deepwater-*.ts`), and that watch is
the only way results come back.

- **The watch.** `deep-water-watch` runs every 5 s under `withSweepLock` and
  claims due runs with `claimDueDeepWaterWatchRuns` (`FOR UPDATE SKIP LOCKED`,
  at most 50): attached briefs and researches still open and not blocked, plus
  agent briefs whose `research_scope_start` result was lost. Each claim
  advances `reconcile_seq`, backs `reconcile_after` off, and enqueues one
  `deep_water.run.watch` job keyed by that sequence (`maxAttempts: 1`: the next
  claim is the retry). An applied read sets the next read: 5 s while a planner
  turn or a person's action is in flight, 30 s while the research runs, then
  half the time since the last change, between 10 minutes and 6 hours.
- **Reads are cost-free control-plane calls** through the run's own connector
  (`callDeepWaterLedgerTool`, shared with the run toolset through
  `deepwater-ledger-transport.ts`), signed as the requester with the captured
  `uoa_identity` and the `deep-water.delivery` system component, tool-call id
  `watch:<runId>:<seq>`. A brief is read with `research_scope_get` (with its
  transcript only once a planner turn has settled since the transcript was
  captured), a research with `research_status`; the answer goes through the
  same projection the tool acks use. A transient failure changes nothing; an
  identity that no longer resolves blocks the run with
  `requester_identity_changed` until the requester's next live action (or
  Retry) renews it. Only a person's own brief is blocked quietly, because its
  dialog says "Sign in again"; an agent's brief tells the requester once that
  the agent can't carry on (they cannot edit it, and the agent is never woken
  while the watch is stopped), and a launched research tells them DeepWater
  can't check on it — never that it finished.
- **A lost agent scope start** is replayed as the agent's own call — its Run,
  agent, kind, provider tool-call id and stored arguments — which Ledger answers
  with the one brief it keyed to that call, or opens now. The attach posts the
  agent's research card (`ensureDeepWaterResearchCard`, once per run under the
  row lock). A person's lost opening is retried by its own brief-action job,
  never replayed by the watch.
- **Stale actions.** An in-flight action whose job is no longer queued or
  running ends by what Ledger shows (`settleStaleDeepWaterAction`): a launch
  whose research is running is finished, one whose planner turn is still open
  is kept, anything else ends as `unavailable`.
- **Turn wakes.** After every applied read, `claimDeepWaterTurnWake` takes the
  settled planner turn once, in turn order, by advancing
  `last_handled_turn_seq` under the row lock. An agent-authored turn wakes that
  agent (at most eight wakes per brief, then one notice to the person); a
  person's turn only advances the claim. Acks never wake.
- **A wake is one run** (`wakeDeepWaterAgent`): a hidden `system` kickoff with a
  deterministic id, `metadata.deepWaterDelivery`, the run's full source basis
  and private-conversation lineage, placed under the research card; then the
  per-thread claim, with purpose `deep_water.delivery`, the requester as
  effective user and the captured identity. Such a pending wake drains alone,
  its failure is announced in the thread, and a replay is a `duplicate`. A wake
  passes the gates a trigger fire does: a shared agent must still be bound to
  the origin channel (the Personal Assistant is placed by presence, which its
  run re-checks), and in a non-public channel the requester must still be a
  member. A wake that cannot reach anyone (thread or agent gone, agent unbound,
  requester inactive or out of the room) becomes a notice to the person.
- **Delivery** (`deliverDeepWaterResearch`) reads `research_report` once per
  attempt (`delivery:<runId>:report`), stores the exact `report.md` and an RFC
  4180 `sources.csv` through `FileService` (`recordDeepWaterArtifactFile` keeps
  the first), imports the report to a page whose id is fixed by the run (the
  requester's My Docs for a DM or Personal Assistant conversation, otherwise the
  project's Project Documents; notes for a summary or a truncated report lead
  the page; a page deleted in Documents — which archives it — or whose marker
  no longer names this run's stored report blocks rather than being
  overwritten, and the person's Retry import, `retryDeepWaterDelivery`, puts
  that same page back with `restoreDeepWaterReportPage` before delivering; the
  watch never undoes what was done to a page), and then, in the claim's
  transaction, posts the person's result reply under the card with an alert
  keyed `deep-water-result:<runId>`, or wakes the agent that asked. A failed
  research is delivered the same way with a notice or a `failed` wake. An expired or unreadable report is a final block;
  a changed identity, a destination that went away and any other refusal are
  retryable blocks. Every notice names its remedy and carries
  `metadata.deepWaterNotice`; a delivery whose conversation is gone blocks
  with nothing posted, since there is nowhere to post it.
- **Realtime.** Every DeepWater transaction collects what it owes realtime and
  publishes it only after it commits (`runDeepWaterTransaction`,
  `deepwater-announce.ts`): each card, result and notice (`message.new` /
  `message.reply`, content-free when the message carries a disclosure basis),
  the requester's `alert.created` keyed `<eventKey>:<userId>`, and
  `integration.run.updated {productSlug, runId}` — content-free, on the
  requester's user lane and, once the run has a card there or an agent opened
  it, the origin channel's lane — whenever a viewer would see the run change.
  A publish failure is logged and never undoes the change; nothing polls.
- **The reap.** Every 10 minutes `deep-water-reap` gives up briefs Ledger never
  confirmed within a day (`failed/start_unconfirmed`), telling the agent once
  (a `start_unconfirmed` wake) or the person once. `delivered_at` stays unset,
  so a confirmation that does arrive later still attaches.
