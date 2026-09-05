# Delivery, what is not in v1, and the risks

Part of [the API-key connector design](overview.md).

## 11. Delivery

Every phase leaves the tree green, the existing four adapters working under
OAuth exactly as before, and nothing reachable that is not finished.

**Phase 1 — contract and registry.** `auth.ts` types; `adapter.ts` reshaped
(`auth`, `hostPolicy`, `delta`, `identityTenantKey`, required polling
interval); `sourceFetch` takes `hostPolicy` and `acceptStatuses`; the four
adapters move `oauth` under `auth` with declared capabilities; Trello loses
`oauth`, gains `apiKey` (token paste, deployment-key `createUrl`), and
`/trello/complete` plus the fragment code in `callback-page.ts` are deleted;
`registerBoardSourceAdaptersFromEnv` registers all providers and reports
unavailable ones; `GET /providers` returns the §3.2 shape; the two worker
tenant-key chains call `identityTenantKey`.
*Accept:* existing adapter, worker and route tests pass; a registry test
refuses an adapter with neither method; `GET /providers` on an env with
nothing set lists four providers with `api_key` and Trello as unavailable.

**Phase 2 — the credential model.** Migration: connection scope columns,
`scopeKey`, `authMethod`, `label`, `credentialParams`, `expired` status,
`credential_expired` health, `asana` provider, `webhookSecretCiphertext`,
`board_source_credential_expiring` alert kind and `boardSourceConnectionId`,
CHECKs, backfill. `board-source-connection-access.ts` predicate wired into
attach, containers and re-point. `loadBoardSourceConnectionContext` per §6.1.
`connections-api-key.ts` (create, rotate) and audit entries; `connections.ts`
lists by entitlement with `?projectId=`. `updateBoardSource` refuses
`read_write` off `personal`. `BoardSourceRecord` gains
`connectionAuthMethod`, `connectionScope`, `connectionLabel`.
*Accept:* route tests for every cell of the §4.3 table; a test that an expired
no-refresh credential yields `CREDENTIAL_EXPIRED` and never calls `refresh`;
a test that OAuth refresh behaviour is byte-for-byte unchanged; migration
round-trips existing rows.

**Phase 3 — API-key methods on the four.** Linear (bare header, per-team
webhook with per-source secret), GitHub (`X-OAuth-Scopes` preflight,
scope-gated repo hook with minted secret, Projects v2 poll-only), Jira Cloud
(`parseJiraSiteUrl`, Basic auth, `siteUrl`-based `apiBase`, poll-only,
`expiresAt` from the form), Trello (already done in phase 1). The worker's
`ensureWebhook` reads capabilities, stores the token hash before registering,
seals a returned secret; the webhook worker passes `signingSecret`.
*Accept:* per-adapter unit tests on header composition per method, on
`verify()` against recorded identity responses (including the GitHub
fine-grained header-absent case and the Jira `atlassian.net` boundary
cases), on `hostPolicy` refusals; a worker test that a `none`-capability
method never calls `ensureWebhook`.

**Phase 4 — Asana.** The package per §9, the intake route's handshake branch,
the 412 test.
*Accept:* normalisation, section→state, custom-field mapping, `addProject`
move, handshake round-trip against a stand-in, and the 412 test all green;
the sync engine's tests unchanged.

**Phase 5 — multi-import.** `CreateBoardSourceBodySchema` becomes plural;
`sources-import.ts`; field reconciliation with option union and the type-clash
fallback; `useCreateProjectSource` returns `{ created, refused }`.
*Accept:* a test attaching three containers where the second's `describe`
throws yields two created, one refused, two initial-sync jobs; a test that two
boards' "Priority" selects union options; a test that a select/text clash
creates the suffixed field and reports it.

**Phase 6 — the admin.** The three-file dialog; `ProjectToolConnections`
parameterised by scope and reused in `SourcesSettingsSection` (project keys)
and the new organisation tab; the source rows' remedies wired (T12) including
*Replace key*; `SourceStatusStrip` expiry pill; the alert row and deep link
for the new kind. Copy per §10.
*Accept:* `admin` tests for the generic form rendering each field kind, for
the entitlement-greyed scope options, for the result view with refusals; the
page-header test unchanged (the dialog has no header actions).

**Phase 7 — expiry sweep and docs.** `board-source.credentials.expiry` in
the worker; `docs/deployment/configuration.md` "Project board sources"
rewritten: OAuth env is optional and enables sign-in plus app-level webhooks,
Trello's env is required for Trello at all, `NESSIE_API_PUBLIC_URL` is still
what enables webhooks; `as-built.md` in the parent folder gains a pointer here
and this document gains its own as-built section when built.
*Accept:* a worker test that a connection expiring in six days writes exactly
one alert per steward and a second pass writes none; on the date, status
`expired`, every source `credential_expired`, one health alert per transition.

## 12. Not in v1

- **Jira Data Center / Server.** Bearer PAT against an arbitrary host, REST
  v2, `startAt` pagination — the research verified the auth shape only. It
  arrives as its own provider id sharing `board-source-jira`'s normaliser,
  behind an operator host allowlist, never as a `kind` flag on the Cloud
  adapter.
- **Jira Cloud custom domains.** Same allowlist; same reason (§7).
- **Asana OAuth.** No deployment asked for it; the PAT path covers personal and
  (via service accounts) organisation scope.
- **GitHub Projects v2 webhooks under a token.** Poll-only; org hooks need
  `admin:org_hook`, which nobody should grant a board.
- **Trello without a Power-Up.** Impossible by vendor design.
- **A lock: "only the organisation key may be used for Jira".** One
  lock-only `ScopedSetting` row and one predicate when someone asks (§4.1).
- **Sharing an OAuth connection at project or organisation scope.** Scope is
  offered on the API-key method only. An OAuth grant is a person's by
  construction; making it shared would be Option B by another door.
- **Linear team-restricted keys.** A key limited to some teams simply lists
  fewer teams; nothing to build, nothing to explain beyond the empty state.
- **Reading a Jira token's expiry from Atlassian.** No API; the person types it.
- **Comments, attachments, subtasks** from Asana — the parent design's §5.3
  reasons hold.
- **Per-key rate budgets.** One organisation key feeding ten boards shares one
  vendor budget (Linear 2 500/h per key; Asana 150/min free). The existing
  `rate_limited` backoff handles it; the remedy when it bites is a project key
  for the busy board, which the dialog already offers.

## 13. Risks and the default each proceeds on

- **Linear `webhookCreate` may not accept a `secret` input.** Default: store
  the secret the mutation returns; if it returns none either, Linear under a
  key is poll-only and declares `none`. Costs freshness, not correctness.
- **GitHub's token-expiration header.** Default: if absent at build time,
  GitHub has no stored expiry and behaves like Linear (§6.4).
- **Jira webhooks under Basic auth may actually work.** Default: `none`. If
  the console permits it on first live connect, the method's capability flips
  to `per_source` and the existing unsigned-token path applies; a declaration
  change, not a design change.
- **Asana's synchronous handshake and the intake route's body parsing.** The
  handshake POST has an empty body; the route must not require JSON. Default:
  the handshake branch runs before body handling.
- **A shared Jira key is one person's identity at Atlassian.** Reads under it
  appear as that person in Atlassian's own audit log, and the key dies with
  their Atlassian account. The organisation row names the steward for exactly
  this reason; the yearly rotation Atlassian now forces is operational load
  the owner should expect, and §6 is what keeps it from being a surprise.
