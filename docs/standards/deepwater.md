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
  DeepWater `research_start` must reuse the provider's stable `tool_call_id` on
  logical retries. The projected tools and `deep_water_run_update` are flagged
  `requiresExplicitGrant`, so an agent sees them ONLY when its `toolPolicy`
  explicitly allows them (`=== true`) **and** the team-scoped instance reaches
  the run; grants never bypass tenancy, and absent/inherited denies. Owners use
  the targeted `/api/mcp/tools/.../policy-targets/...` mutation (one locked
  policy-key merge, never a full-policy replacement); canonical DeepWater rows
  take the team-transition lock, re-read their projection generation, then take
  the agent lock. Its minimal target list
  includes the Personal Assistant without exposing PA bindings/activity through
  `/api/agents`. The DeepWater launcher and
  `/api/integrations/products/deep-water/agent-access` manage/read the
  manifest's MCP projections plus `deep_water_run_update` as one exact bundle
  whose size is derived from the manifest, never hard-coded. Launch stays
  disabled and the API rejects before run creation until the PA holds the whole
  bundle;
  the updater counts only while its registry row is enabled and active, matching
  worker exposure, so a disabled builtin cannot authorize metered work;
  the final enablement/instance/policy reads and run insert are linearized under
  the team lock then agent-policy lock. Owners can also grant/revoke the bundle
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
  `needs_setup` research run still references the connector; cancel or recover
  the run, or let it reach a terminal state, before retrying disable.
  The worker enables handoff enforcement only from server-authored message
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
  Completion also fails fatally if the model omits the required start. Ordinary
  DeepWater calls are unchanged.
  PA message, run attachment, PA run/task, and direct `run.execute` enqueue
  commit atomically; product handoffs bypass chat engagement decisions while
  ordinary chat keeps its existing orchestration path. Duplicate enqueue
  conflicts roll back the duplicate unit, and realtime publication is
  post-commit/non-fatal.
  Even a
  null external id remains a conservative blocker because Ledger dispatch may
  be in flight; the error links an attached chat where PA can call
  `research_cancel`, while unattached interrupted work requires explicit
  recovery. Disable
  targets only the instance linked from the first-party public product, so
  private same-name catalogs are untouched. `deep_water_run_update` is not
  PA-only and takes tenancy strictly from the run context (same team + thread;
  Knowledge page validated against the org). It never accepts a cost, price,
  charge, tariff, or currency: Ledger's DeepWater REST/MCP status, report, and
  list contracts expose no commercial amount, and UOA is the sole commercial
  authority.
  The external report URL is persisted only from Ledger's authenticated
  `research_start` structured response after its origin and exact job path are
  validated; source count is persisted only from the authenticated
  `research_report` references array. Both carry server-only provenance markers
  before they are exposed, and agent-authored run updates cannot set, replace,
  or mark either value as trusted. Source persistence atomically repairs an
  already-created exact per-run connector usage event, making same-batch
  report/update order irrelevant. That event records operational calls and
  authenticated source units against the launch run's immutable
  `requestedByUserId`; it has no cost fields and is excluded from every local
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
  The locked write also enforces a terminal start ticket's exact Product status
  mapping (`complete` → `completed`; negative terminal outcomes → `failed`).
  Re-enable preserves richer probed schemas only
  when tool names exactly match the current Ledger contract, upgrades an older
  Ledger contract in place (see "Contracts move in place" above), and replaces
  legacy direct-provider projections, which must be explicitly re-granted.

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
  is known only to the launch job, which moves the run back itself with
  `revertDeepWaterLaunch` while its launch is the action in flight.
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
  exceptions: a cancel replaces any in-flight action except the opening
  `scope_start` before Ledger acknowledged it (there is no research id to
  cancel yet, so the cancel is refused as busy for those seconds), and a
  cancelled or finished brief ends whatever action was in flight — including a
  brief Ledger refused to open (`failUnstartedDeepWaterBrief`), whose opening
  action ends with its error code in the same write.
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
- **The legacy run list.** `GET /api/integrations/products/:productSlug/research-runs`
  (`listDeepWaterResearchRuns`, rendered by Knowledge › Research's
  `DeepWaterResearchView` → `DeepWaterRunHistory`) reads the whole team with no
  viewer predicate, so it returns launcher rows only (`uoa_identity IS NULL`).
  A brief row there would show a colleague's unlaunched brief — its topic
  included, from their Personal Assistant or a private channel — to the whole
  team. **Hand-over:** the brief API's list (`GET
  /api/integrations/products/deep-water/research-runs?cursor&limit`, `{items:
  ResearchRunView[], meta}`, every row through `isDeepWaterRunVisible`) takes
  the same path, so the change that adds it deletes the legacy handler,
  `listDeepWaterResearchRuns` and its bare-array response in the same commit,
  and moves `DeepWaterResearchView` and its hook to the paginated
  `ResearchRunView` shape. Any launcher row the new list still shows goes
  through the same view mapper and predicate; there is never a window with two
  handlers on one path, or with brief rows on the unfiltered list.

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
  same projection the tool acks use. A failure that passes (Ledger restarting,
  a timeout, a transient refusal, UOA not answering or answering 408, 429 or a
  5xx) is read again within 30 s while the run moves fast — a turn or action in
  flight, a research running — instead of waiting out the claim's backoff
  (`retryDeepWaterWatchSoon`, which only ever brings the next read earlier); a
  definitive refusal, a malformed answer or a missing connector keeps the
  backoff, and a deployment fault (UOA refusing Nessie's client or assertion
  with 400 or 401, or answering outside its contract) fails the read, so the
  job's failure is logged and the backoff stands. An identity that no longer
  resolves — the link gone or re-teamed, or UOA refusing to delegate the
  captured identity with 403 or for another sign-in epoch
  (`classifyUoaExchangeFailure`) — blocks the run with
  `requester_identity_changed` until the requester's next live action (or
  Retry) renews it; it is never retried in a loop. Only a person's own brief is
  blocked quietly, because its dialog says "Sign in again"; an agent's brief
  tells the requester once that the agent can't carry on (they cannot edit it,
  and the agent is never woken while the watch is stopped), and a launched
  research tells them DeepWater can't check on it — never that it finished.
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
  `metadata.deepWaterNotice {schemaVersion, runId, kind}` — the result reply
  too (`kind: 'result'`), which is how a client finds the research, and so its
  artifact actions, from the reply. A delivery whose conversation is gone
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
  framed as a mention by DeepWater (`generic` when the notice carries a
  disclosure basis); the dispatcher rechecks their access, preferences and
  devices, and rings them in an open room they read without joining.
- **The reap.** Every 10 minutes `deep-water-reap` gives up briefs Ledger never
  confirmed within a day (`failed/start_unconfirmed`), telling the agent once
  (a `start_unconfirmed` wake) or the person once. `delivered_at` stays unset,
  so a confirmation that does arrive later still attaches.
