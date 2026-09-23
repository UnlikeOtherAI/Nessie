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
  DeepWater's app page (`POST …/research-runs/:runId/cancel`) and try again;
  the message itself is plain copy that names neither the run's id nor its
  stored status. Even a
  null external id remains a conservative blocker because Ledger dispatch may
  be in flight; an owner cancels a launcher run Ledger never received locally,
  one with a research id through Ledger, and one whose start may still be in
  flight not at all until its handoff resolves it. The view offers that Cancel
  (`viewer.canCancel`) by the same rule the route applies under the row lock
  (`deepWaterLauncherCancelRoute`, reading whether the handoff recorded a start
  call), so it never offers a Cancel the route must refuse. A brief DeepWater never
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
  or launcher — through `isDeepWaterRunVisible` and the one view mapper.
  `listVisibleDeepWaterRuns` reads at most 500 rows per request (five batches
  of 100, each filtered in three queries), so a viewer who may see few of a
  large team's runs never makes one request read them all: when the bound
  comes before the page fills, the page is short — even empty — with
  `hasMore: true` and a cursor after the last row read, and only a page with
  `hasMore: false` is the last. It
  replaced the team-wide launcher list at the same path in the same change
  (that list had no viewer predicate, so a brief row there would have shown a
  colleague's unlaunched brief, its topic included, to the whole team); there
  is never a second handler on the path or an unfiltered list of briefs.
  Knowledge › Research's `DeepWaterResearchView` reads it
  (`useResearchRunList`, see "Research briefs — the admin"); the admin's
  launcher-era `DeepWaterRunHistory` is gone.

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
  the requester. The Nessie audit names the owner as the actor and the run by
  id, and records what happened, never only what was asked: a cancel Nessie
  makes itself (an unnamed brief, a launcher run Ledger never received) is
  `integration.research.cancelled` at once, whoever asked; one sent through
  Ledger (an owner's cancel of a brief, any launcher run's) is
  `integration.research.cancel_requested` when accepted, and the worker writes
  `integration.research.cancelled` with Ledger's answer
  (`deepwater-cancel-outcome.ts`) — `success` once cancelled, `denied` when
  Ledger refused (or the research had already ended), `error` when Ledger could
  not be asked, including giving up after the 30-minute window. A cancel that
  did not go through leaves the run open and says why in the view's
  `cancelFailure` (the code in the brief dialog's vocabulary and plain words):
  a brief's from its cancel action's error, a launcher run's from its
  `result_json.ledgerCancel` register, which accepting a newer cancel resets to
  `requested` and a late answer to an older one never overwrites; a launcher
  cancel's job sends only while its cancel is that register's `requested`
  entry (`isLauncherCancelInFlight`), so a redelivered or superseded job sends
  and audits nothing. Every cancel
  is answered once per `actionId`: a retried request whose answer was lost gets
  200 with the run as it now is.
- **Agents and briefs — the run binder** (`worker/src/run/deepwater-run-binder*.ts`)
  wraps every DeepWater call outside a launcher handoff turn.
  `research_scope_start` claims its run with `claimAgentOriginRun` before the
  call leaves — the team transition lock, then the agent's policy lock and a
  re-read of its `research_scope_start` grant — with the person it acts for as
  requester (none means `LEDGER_UOA_IDENTITY_REQUIRED`, and nothing is written)
  and the calling run's consumed sources. The call leaves as
  `deepWaterScopeStartLedgerArgs(run.input)` (`@nessie/schemas`) — the brief as
  stored, trimmed and with blank background and empty settings dropped — never
  as the agent wrote it, and a retried call sends the brief its first call
  stored: Ledger fingerprints a scope start and answers a replay that differs
  with `conflict`, so the opening call, a person's retried opening and the
  watch's replay are byte-identical. Ledger's answer attaches the research
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

Ledger pushes nothing to Nessie. DeepWater (Water) pushes each research's
progress, settled planner turns and outcome straight to Nessie (see "Research
events from DeepWater" below), and the worker watches every open brief and
research through Ledger (`worker/src/control/deepwater-*.ts`) as the backstop.
Both end in the same reads, so results come back with the push switched off.

- **The watch.** `deep-water-watch` runs every 5 s under `withSweepLock` and
  claims due runs with `claimDueDeepWaterWatchRuns` (`FOR UPDATE SKIP LOCKED`,
  at most 50): attached briefs and researches still open and not blocked, plus
  agent briefs whose `research_scope_start` result was lost. Each claim
  advances `reconcile_seq`, backs `reconcile_after` off, and enqueues one
  `deep_water.run.watch` job keyed by that sequence (`maxAttempts: 1`: the next
  claim is the retry). An applied read sets the next read: 5 s while a planner
  turn or a person's action is in flight, 30 s while the research runs, then
  half the time since the last change, between 10 minutes and 6 hours. While
  the run has received a DeepWater event in the last 2 minutes
  (`last_event_at`), the watch is the backstop and reads it at most every 60 s
  (`deepWaterWatchDelayMs`); a quiet run keeps its longer backoff, and a failed
  read's quick retry below ignores the events, because the one that prompted
  the read may be the last DeepWater sends.
- **Reads are cost-free control-plane calls** through the run's own connector
  (`callDeepWaterLedgerTool`, shared with the run toolset through
  `deepwater-ledger-transport.ts`), signed as the requester with the captured
  `uoa_identity` and the `deep-water.delivery` system component, tool-call id
  `watch:<runId>:<seq>`. A brief is read with `research_scope_get` (with its
  transcript only once a planner turn has settled since the transcript was
  captured), a research with `research_status`; the answer goes through the
  same projection the tool acks use. A failure that passes (Ledger restarting,
  a timeout, a transient refusal, UOA not answering or answering 408, 429 or a
  5xx) is read again within 30 s while the run moves fast — a turn or action in
  flight, a research running — instead of waiting out the claim's backoff
  (`retryDeepWaterWatchSoon`, which only ever brings the next read earlier); a
  definitive refusal, a malformed answer or a missing connector keeps the
  backoff, and a deployment fault (UOA refusing Nessie's client or assertion
  with 400 or 401, any 403 that does not name the person, or an answer outside
  its contract) fails the read, so the job's failure is logged and the backoff
  stands. An identity that no longer resolves — the link gone or re-teamed,
  the link recording a newer sign-in epoch than the one captured (the person
  signed in to Nessie again), or UOA refusing to delegate the captured
  identity with a 403 naming `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN`, or delegating
  it for another sign-in epoch (`classifyUoaExchangeFailure`) — blocks the run
  with `requester_identity_changed` until the requester's Retry renews it (on
  their own brief, their next action there does too); it is never retried in a
  loop. Only a person's own brief is blocked quietly, because its dialog says
  "Sign in again"; everyone else is told once, as an `identity_changed` notice:
  an agent's brief that the agent can't carry on (they cannot edit it, and the
  agent is never woken while the watch is stopped; the brief they open from
  there says the same and offers the same Retry), and a launched research
  that DeepWater can't check on it — never that it finished, nor that it is
  waiting to be saved.
- **Identity drift.** UOA answers 403 for Nessie's own delegation setup too
  (a missing or disabled mapping, an inactive client domain, a resource or
  scope the mapping does not allow, a team context the product requires or
  does not support), and those codes stay off its public production list, so
  their body is a bare 403 — a fault, never the person's doing. Every refusal
  about the person's own state (a moved sign-in epoch, an unknown user, a lost
  domain role, an organisation or team no longer theirs) answers the public
  `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN` (UnlikeOtherAuthenticator #52; the bodies
  are pinned in `packages/runtime/test/uoa-token-exchange-production-bodies.ts`),
  which blocks the run and tells them as above. No live action renews a
  launched or finished research, so there only their Retry — which needs that
  block — renews the identity.
- **A launch is seen before its result.** A research Ledger shows was launched
  — `complete`, or a brief whose state is `launched` — moves the run to
  `running` (setting `launched_at`) before its result is delivered, even when
  the watch never saw it run (a launch acknowledgement lost, or a research
  that finished between two reads), so a person's card is posted and the room
  is shown the research before the result lands under that card. A move into
  `needs_setup` is a launch as well — Ledger reports it only for a launched
  research — so it sets `launched_at` and posts the card the same way, and a
  research that finishes from there is delivered under it; moving between
  `running` and `needs_setup` afterwards is not a second launch. A bare
  `failed` on a brief is never taken as a launch: it can be a refusal before
  one. Nor is a bare `running`: Ledger shows a launch whose call is still out
  (`starting`) as `running`, and puts it back to `drafting` when Water refuses
  it, so a brief moves to `running` only on proof — a launch ticket, or Water's
  own brief state `launched` (`statusStepForLedger`). Otherwise a person's card
  would be posted in the room, and their brief opened to it, for a launch that
  is then undone. Until the proof comes the brief is read at a running
  research's pace (30 s), so a launch whose acknowledgement was lost is seen
  as soon as Water's brief can be read.
- **A lost agent scope start** is replayed as the agent's own call — its Run,
  agent, kind and provider tool-call id — which Ledger answers with the one
  brief it keyed to that call, or opens now. Ledger fingerprints the arguments
  and answers a replay that differs with `conflict`, so the opening call and
  every replay send exactly `deepWaterScopeStartLedgerArgs(run.input)`
  (`@nessie/schemas`), never the arguments as the caller wrote them; a
  `conflict` still means Ledger holds a live brief for that call, so it is
  logged as the broken invariant it is and the run is held for the reap
  (`holdDeepWaterScopeStartReplay`: its next read falls due as its confirm
  window closes, so it is never replayed again), never failed as refused. The
  attach posts the agent's research card
  (`ensureDeepWaterResearchCard`, once per run under the row lock). The replay
  signs as the requester, so a changed sign-in blocks it and tells them once,
  exactly as a read does; the blocked brief is not claimed again until their
  Retry renews the identity and replays it, and if they have not by the time
  its confirm window closes, the reap ends it. A person's
  lost opening is retried by its own brief-action job, never replayed by the
  watch.
- **Stale actions.** An in-flight action whose job is no longer queued or
  running ends by what Ledger shows (`settleStaleDeepWaterAction`): a launch
  whose run is launched (`running` or `needs_setup`) is finished, one whose
  planner turn is still open is kept, anything else ends as `unavailable`.
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
  requester inactive or out of the room) becomes a notice to the person. So
  does a terminal wake (`completed`, `failed`) whose run fails because it
  cannot sign as the requester any more (`isRequesterIdentityRefusal`: no
  linked identity, or UOA refusing the person): delivery counted the wake when
  it was claimed or pended, so the run's failure handler posts DeepWater's
  notice under the card instead of the agent's reply — with the Knowledge link
  for a finished research — once, as the run's result message
  (`tellRequesterDeepWaterWakeFailed`). Any run that fails this way is failed,
  never retried or answered with an apology, and tells its person to sign in
  again. A planner-turn wake is left to the brief's own watch read, which
  blocks on the same identity and tells them.
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
  research is delivered the same way with a notice or a `failed` wake. An
  expired or unreadable report is a final block;
  a changed identity, a destination that went away and any other refusal are
  retryable blocks. Every notice names its remedy and carries
  `metadata.deepWaterNotice {schemaVersion, runId, kind}` — the result reply
  too (`kind: 'result'`), which is how a client finds the research, and so its
  artifact actions, from the reply. The result reply carries no
  `metadata.documentRef` (the plan's §7.5 named one): that pointer is a
  document-stream session's (`DocumentRefMetadataSchema` requires its
  `sessionId`), which a research never has, so the Knowledge link lives in the
  reply's words and in the run's own view, reached through `deepWaterNotice`. A delivery whose conversation is gone
  blocks with nothing posted, since there is nowhere to post it. A notice about
  a person's brief that was never launched (`isDeepWaterPersonBriefUnlaunched`,
  the fact the viewer predicate uses: DeepWater never confirmed it, refused it,
  or it failed before launch) goes to the requester's own Personal Assistant
  conversation, at the top level, unless the brief came from there: the room
  was never shown it, and even a withheld placeholder there would tell everyone
  else that a private brief exists. A person's brief that ended without a
  launch stays theirs alone in every read, whatever its status.
- **Artifacts.** A delivered research's `report.md` (the exact markdown Ledger
  returned) and `sources.csv` are retained run output. They are stored with no
  uploader, message or publication, so the generic attachment route refuses
  them, and are served only by `GET …/research-runs/:runId/artifacts/report.md`
  and `…/sources.csv` (downloads under the name they were stored with,
  `deepWaterArtifactFileName` in `@nessie/schemas` — the same function the
  admin names the download with — with the
  attachment download path's caching, ETag and transfer metering) and
  `…/artifacts/report` (`{markdown, truncated, reportKind}` for Copy markdown,
  `no-store`, refused with `DEEP_WATER_REPORT_TOO_LARGE_TO_COPY` past the 8 MiB
  proxy budget, where Download still works). Each reads the run through
  `loadVisibleDeepWaterRun` (`api/src/services/deepwater-research-run-access.ts`:
  a fresh live-entitlement viewer, the origin thread's reach, then
  `isDeepWaterRunVisible`), so a research the viewer may not see answers
  `DEEP_WATER_RESEARCH_NOT_FOUND` exactly as a missing one does. Until delivery,
  and for a failed research, there is nothing to serve
  (`DEEP_WATER_ARTIFACT_NOT_FOUND`), matching the view's `artifacts: null`.
- **Realtime.** Every DeepWater transaction collects what it owes realtime and
  publishes it only after it commits (`runDeepWaterTransaction`,
  `deepwater-announce.ts`): each card, result and notice (`message.new` /
  `message.reply`, content-free when the message carries a disclosure basis),
  the requester's `alert.created` keyed `<eventKey>:<userId>`, and
  `integration.run.updated {productSlug, runId}` — content-free, on the
  requester's user lane and, once the run has a card there or an agent opened
  it, the origin channel's lane — whenever a viewer would see the run change.
  A publish failure is logged and never undoes the change; nothing polls.
  Every result and notice also queues one `push.dispatch` job in its own
  transaction, keyed `push:<messageId>`, addressed to the requester alone and
  framed as a mention by DeepWater, so their mention preference applies; the
  dispatcher rechecks their access, preferences and devices, and rings them in
  an open room they read without joining. A notice that carries a disclosure
  basis is `generic`: it stays a mention, but the lock screen shows only
  `genericBody`, DeepWater's words for the kind of news (`noticePushBody`:
  "Your DeepWater research has finished."), never the topic or the agent-reply
  wording. Each kind says only what is true of every notice of that kind: only
  a finished research's blocked delivery (`blocked`) "needs you before it can
  be saved"; a changed sign-in on a brief or a running research is
  `identity_changed` ("Sign in again so your DeepWater research can carry on.").
- **The reap.** Every 10 minutes `deep-water-reap` gives up briefs Ledger never
  confirmed within a day (`failed/start_unconfirmed`), telling the agent once
  (a `start_unconfirmed` wake) or the person once. A brief blocked on its
  requester's changed sign-in is reaped too, because the reap is the only thing
  that ends an unlaunched brief, and an open one keeps the team from turning
  DeepWater off and the agent's DeepWater tools from being revoked. What
  stopped it was the sign-in, not DeepWater, so it is never told as
  unconfirmed: it ends as `failed/start_identity_changed`, its block is cleared
  (an ended brief has nothing to retry), and the requester alone is told once
  (`start_identity_changed`: the brief was closed because their sign-in
  changed) — the agent is not woken, since it could act only with the sign-in
  UOA refused. `delivered_at` stays unset either way, so a confirmation that
  does arrive later still attaches.

## Research events from DeepWater

DeepWater pushes the status of research Nessie asked for straight to Nessie
(Water plan amendments-streaming S1, S2); Ledger connects and meters that work
and relays none of it. The contract is DeepWater's
`deepwater.research-event.v1`, mirrored member for member and as strictly by
`DeepWaterResearchEventSchema` (`@nessie/schemas`); DeepWater's published
examples and HMAC test vector are Nessie's fixture
(`api/test/fixtures/deepwater-research-event.v1.examples.json`).

- **The receiver**, `POST /api/integrations/deep-water/events`
  (`deep-water-events.ts`), is public and never changes a run. In order
  (`authenticateDeepWaterEvent`): 503 `DEEP_WATER_EVENTS_UNCONFIGURED` without
  `DEEPWATER_EVENTS_SECRET` (at least 32 characters; DeepWater holds it as
  `NESSIE_EVENTS_SIGNING_SECRET`); 401 `DEEP_WATER_EVENT_SIGNATURE_INVALID`
  unless `x-deepwater-signature` is `sha256=` and the HMAC-SHA256 of the exact
  raw body, compared in constant time; 400 `DEEP_WATER_EVENT_MALFORMED` for a
  body outside the contract or an `x-deepwater-event-id` that does not name
  it; 401 `DEEP_WATER_EVENT_STALE` for a `sent_at` over ten minutes from now,
  either way. The run is resolved inside the event's
  `nessie.organization_id` (`resolveDeepWaterEventRun`): the run bound to
  `research.ledger_research_id`, else an agent's brief whose research id never
  came back, by the Run, provider tool-call id and agent that opened it. It
  queues `deep_water.research.event` keyed `deep-water-event:<event_id>` and
  answers `202 {accepted: true}`, or `200 {accepted: false, reason}` —
  `run_not_found`, or `legacy_run` for a launcher run, which its handoff owns —
  so DeepWater completes the delivery. These bodies are DeepWater's contract,
  not the `{data}` envelope. DeepWater retries 401, 408, 429, 5xx and network
  failures for up to seven days and drops any other 4xx.
- **The handler** (`deepwater-research-event.ts`; one attempt, the watch is
  the retry). `research.progress` is stored as `scope_json.progress`
  (`{phase, note, percent, sourcesFound, at}`) only when DeepWater observed it
  later than the stored snapshot, on a run bound to that research and still
  open (`applyDeepWaterProgress`, under the row lock); it marks
  `ledger_observed_at` and announces `integration.run.updated`, and never
  wakes, posts or alerts. A settled turn or an outcome is a trigger, never an
  authority: `claimDeepWaterEventRead` claims a read now, exactly as the sweep
  would (so a watch job for an older claim stands down) and only for a run the
  watch reads, and the handler makes the watch's own read
  (`runDeepWaterWatch`). The attach, both registers, delivery and the wakes
  are the watch's, from Ledger's answer: an agent is woken only for a settled
  turn it wrote and for its research's outcome, and a person gets the result
  reply with its mention and push alert — each once, however often DeepWater
  resends the event (its start-up sweep can). The brief dialog's "replying"
  ends with that read.
- **Every event sets `last_event_at`**, which puts the watch on its 60 s
  backstop cadence for two minutes (see "The watch" above).
- **The view.** `ResearchRunView.progress` is the stored snapshot while the
  research is starting or running with its delivery not blocked, else null
  (`toDeepWaterResearchRunView`); the admin streams it (below).

## Research briefs — the admin

A person reaches DeepWater research from wherever they stand, and every doorway
opens the same surfaces (`admin/src/components/features/deep-water/`, facades in
`admin/src/facades/deep-water/`). The launcher form, its mode selector and
custom controls, and the chat card that opened it are gone; an older chat
card's `open_deep_water_research_launcher` action opens a new brief with its
question, coming back where that card sits — its conversation, read from the
message feed it is in (`feed-conversation.ts`, so a drawer or a Threads inbox
card names its own), its thread and its reply thread. With no brief host on
the screen it goes to that conversation, which opens the brief itself.

- **One brief dialog, one host per screen.** `ResearchBriefDialog` is the only
  surface for agreeing, starting and following a research: the question and
  background open a brief; then the conversation with DeepWater's planner (who
  wrote each turn from Nessie's own `turnAuthors`, "replying" with the elapsed
  time, a failed turn with Send again, one-tap suggested answers that name the
  question they answer), editable pillars, the seven settings under their UK
  English labels with a lock on the person's own choices ("Let DeepWater
  choose" hands one back), the planner's assessment with its suggested depth,
  the person-only "Publish on research.deepwater.live" switch (off by default)
  and Start, pinned to the foot of the dialog. `ResearchBriefHost` mounts it on
  a conversation (origin: that thread), on the Threads inbox (no origin of its
  own: each card's composer names its reply thread) and on Knowledge › Research
  (origin: the person's Personal Assistant conversation) and owns
  `?research=<runId>`, which is declared linkable state on the conversation and
  reply-thread routes, the Threads inbox and the Knowledge views
  (`deep-water-research-navigation.test.ts` pins those declarations, the host
  on each route and the Research button on each composer); a question a
  doorway hands over travels in router state, never in the address, and the
  host drops it with a replacing redirect once taken, so Back and Forward land
  on the conversation, never on a half-filled form. A doorway
  over another conversation than the screen's names that conversation
  (`NewBriefPlace`, `research-brief-origin.ts`), and "Start again" restarts a
  research where it was asked, reply thread included. A research started from
  the launcher, before briefs, has no brief (`GET …/:runId/brief` answers 404
  while `GET …/:runId` still answers the viewer), so the dialog shows where it
  stands and what it produced — status, outcome, artifacts and its Documents
  page — rather than calling the viewer's own research unavailable. A
  research's "the result will come back to this conversation" is said only
  over the conversation it was asked in (its card, or its brief over that
  thread); Knowledge › Research, the Threads inbox and a brief over another
  conversation say "the conversation it was asked in" (`researchShownIn`).
- **Edits are local until they ride on an action** (contract D4,
  amendments-fable F8). A setting is sent only when it differs from what
  DeepWater holds, because every key sent is a lock; pillars ride as a whole
  cleaned list. A sent action's edits stay on screen until the brief moves past
  the revision they were sent against. When the brief moves on under unsent
  edits — the planner answered, or a reply or Start was refused as a revision
  conflict and the brief was fetched again — the edits are kept on top and the
  dialog says what DeepWater changed. The browser that sent an action holds it
  in that brief's stored draft until the brief says how it ended: a refusal
  lays its edits back under anything changed since and returns its words only
  to an empty reply box; a reply the planner could not answer returns its words
  to the box, and they are what Send again sends. Another browser, or a
  cleared draft, has nothing to put back. Every action carries an `actionId`
  that is reused only to retry the same body after a lost answer
  (`createIntentActionIds`). Where the body lives in a stored draft — a new
  brief's question and background, a reply and its edits, Start's edits — the
  key it was last sent with is stored in that draft before the request leaves
  and kept until the server has decided it (`useStoredIntentActionId`), so
  pressing the button again after closing the dialog or reloading replays the
  request instead of opening, and paying for, a second brief or planner turn.
  A lost answer never reads as a request that did not arrive: "Nessie didn't
  answer". Research drafts are keyed by the viewer
  (`draft:research-brief-new:<user>:<organisation>:<place>`,
  `draft:research-brief:<user>:<runId>`), so a second person on the same
  browser never sees another's unsent question.
- **Who may do what is the server's.** The dialog reads `viewer` from the view:
  an agent's brief is read-only for people, and its requester may only discard
  it; a finished research offers Retry import only where `canRetryDelivery`
  says so. A blocked delivery's remedy ("Retry import puts it back", "Sign in
  again, then choose Retry") is said only to the requester; everyone else who
  can see the research reads what happened and that the person who asked can
  retry (`blockedReasonCopy`). A drafting brief whose sign-in no longer
  resolves shows its requester "Sign in again to continue this brief" (F4) —
  on an agent's brief too, where the agent can't carry on until they do — with
  Retry where `canRetryDelivery` says so.
- **A cancel is a state of its own.** `POST …/cancel` answers 202 once the
  cancel is recorded for the worker; the research stays open, with
  `pendingAction.kind === 'cancel'`, until DeepWater has stopped it. From the
  moment Discard or Cancel is pressed until then, the dialog says "Discarding
  this brief…" or "Stopping this research…" and offers neither the cancel again
  nor Start, and the brief is not edited (its unsent edits stay in the draft).
  The cancel mutation settles only once the run has been read again, so the
  cancel never reappears in between. A cancel that did not go through —
  DeepWater refused it, or could not be asked — comes back as the view's
  `cancelFailure` while the research is open: its words are said to whoever may
  cancel (`viewer.canCancel`), beside Cancel — at the brief's foot while it is
  being agreed, in the research's outcome once it has started (card, Knowledge
  row, dialog) — and Cancel is offered again; the brief conversation does not
  repeat a cancel's error. A refusal reads by the action refused
  (`briefActionFailure(error, action, viewerIsOwner)`): `DEEP_WATER_BRIEF_BUSY`
  on a cancel means the brief is still being opened, never that the planner is
  answering, and `DEEP_WATER_NOT_READY` names the readiness remedy for the
  viewer's role and refetches the products list, so a dialog holding a stale
  "ready" verdict gives way to `ResearchReadinessScreen`.
- **Every composer's Research button is always there** — the conversation's; a
  reply thread's and a Threads inbox card's, whose brief carries the thread's
  `rootMessageId` so the research card and its result land under that root; and
  the agent and person drawers', whose brief comes back to the conversation that
  drawer posts to. When the viewer cannot
  start research it says why in its label and opens `ResearchReadinessScreen`
  instead of a brief: a team owner is sent to `/apps/deep-water` to turn
  DeepWater on or update it, anyone else — admins included — is told to ask a
  team owner, and an unlinked sign-in is asked to sign in again. The verdict is
  the products list's `research` readiness, read through
  `DeepWaterResearchReadinessSchema` (`readDeepWaterReadiness`); the admin never
  re-derives it. No deep-water entry, or one sent without a verdict (the API
  gives none outside a team), is `unavailable`. A products read that failed
  before any verdict was read (a later failed read keeps the last one), or a
  verdict outside the contract (an admin and API deployed at different
  versions), is logged once and said as "DeepWater's status couldn't be
  loaded" with Try again (`ResearchReadinessUnread`) — on the hero, behind the
  composer's button (whose label then claims no reason) — never as DeepWater
  being off or unreachable; `readinessCopy` throws on a state it has no words
  for rather than render an undefined title.
- **The owner's controls live on the `/apps/deep-water` hero**
  (`DeepWaterTeamControls`): turn DeepWater on, off (confirmed) or update it to
  the brief tools — a team that needs updating is on, so its owner is offered
  both Update and Turn off (`deepWaterTeamControls`). They, and the readiness
  screen's way to them, are offered on the session's owner role alone
  (`viewerIsOwner`), because `PATCH
  …/team-enablement` accepts only owners; the verdict's `viewerCanChangeTeam`
  is owners and admins, the cancel standing (amendments N8.5), and gates
  nothing but Cancel. A refusal because a research is still open
  (`LEDGER_DEEPWATER_ACTIVE_RUNS`, whose `details` name the run by id, status,
  origin and requester — `DeepWaterActiveRunConflictSchema`) shows that research
  by who started it and where it stands, never its question, with "Cancel this
  research" as the owner's own cancel. An accepted cancel leaves the block in
  place saying the cancel is requested and to try again once the research has
  stopped, with no second Cancel while it is on its way — also when trying the
  change again meanwhile is refused by the same research
  (`openResearchStanding`). An owner who may read the research watches its
  view there (refreshed by the realtime update): they see it stop, and a
  cancel that did not go through (`cancelFailure`) comes back with its reason
  and "Cancel again", however often the change has been tried since. One who
  may not read it (its read answers 404) learns only from trying the change
  again: refused by the same research after their cancel was accepted, they are
  told the cancel may not have gone through and offered "Cancel again" — a
  newer cancel replaces the one before, never doubles it. A verdict the admin
  could not read offers no change at all, only Try again.
- **Artifacts are one component.** `ResearchArtifactActions` — Download report
  (or summary) `.md`, Download sources `.csv`, Copy markdown, and "Open on
  research.deepwater.live" only when the view carries `publicUrl` — is used by
  the research card, the actions beside a result reply
  (`metadata.deepWaterNotice`) and Knowledge › Research rows. Downloads and
  copy read the stored artifacts through the run's viewer check, never the
  Knowledge page; the file name comes from `deepWaterArtifactFileName`, the
  same function behind the API's `Content-Disposition`. Where the browser will
  not copy, the markdown is shown selected for a manual copy, and a copy is
  never claimed that did not happen. A summary is called a summary everywhere.
- **Knowledge › Research pages forwards only on the server.** The brief API
  keeps only the rows the viewer may see, so it returns no `prevCursor`;
  `useResearchRunList` pages with `usePagedList`'s `backward: 'trail'`, which
  keeps the cursors already walked through in the address (`trail`,
  `cursor-trail.ts`), so Previous, Back and a reload land on the same page.
  The API reads a bounded number of rows per request, so a page can be short —
  even empty — while `hasMore` is true: "No research yet" is only a first page
  with nothing further (`researchListPage`); an empty page with more keeps its
  pager and says older research may be further back, and a trail list's
  footer counts the rows on its page ("7 on this page", `trailPageLabel`)
  rather than a range its short pages would make wrong. Once the list honours
  `direction=backward` and returns a `prevCursor`, the trail goes and the list
  pages like every other.
- **A running research streams.** `ResearchProgress`, drawn by
  `ResearchRunOutcome` and so on the card, a Knowledge › Research row and the
  brief dialog alike, shows DeepWater's progress while a research starts or
  runs: the phase as a numbered step in plain words ("Step 2 of 5: Reading
  sources" — Planning, Reading sources, Summarising, Checking, Writing the
  report), DeepWater's own words for the step, a bar when the step is
  countable, the sources found and the time so far. Its clock is a display
  tick; everything else moves only when the run is announced.
- **Nothing polls.** `useDeepWaterRunEvents`, mounted once in
  `AdminShellLayout`, turns each content-free `integration.run.updated` into an
  invalidation of that run's reads for every viewer scope and of every research
  list; a `realtime.gap` refetches everything. Browser coverage:
  `pnpm --filter @nessie/admin test:e2e:research-brief` walks every state over
  a stubbed client — including a running card moving with each progress frame
  and the dialog leaving "replying" as its turn lands, with no request between
  two frames; `test:e2e:research-brief-real` walks the same doorways
  against the real API, worker and database, with Ledger's answers applied
  through the watch's own projection and announcer, because the pinned egress
  cannot reach a loopback Ledger or UOA; DeepWater's push is played on the
  wire, a signed progress event posted to the real receiver moving the room's
  card live. It cannot open a new brief: readiness stops at `unavailable`
  without a Ledger key and UOA signer.
