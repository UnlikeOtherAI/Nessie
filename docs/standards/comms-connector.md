# Individual Communications Connector

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- The Individual Communications Connector wires per-user OAuth connections
  (Slack + Gmail live, Microsoft planned) into a normalized `CommsEvent` store
  through the provider-agnostic `@nessie/comms-connect` core and one adapter
  package per provider. Adapters register into the shared registry only via
  `@nessie/comms-providers` (`registerCommsConnectorsFromEnv`), called at API
  and worker startup from `NESSIE_COMMS_*` env; unset providers stay
  unregistered and their jobs park on `ConnectorNotRegisteredError`. Token
  bundles are encrypted in a separate table (never returned to the browser),
  sync is resumable + checkpointed with webhook ingestion through the worker
  queue, and the connector layer carries **no** reasoning logic (Chief-of-Staff
  boundary). The sync worker and subscription-renewal sweep skip any connection
  whose owner is no longer an active org member (`deactivatedAt`), so user
  deactivation revokes comms import immediately — matching the API auth and
  scheduled-trigger owner-revocation gates. Spec:
  `docs/plans/2026-07-21-individual-communications-connector.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Individual Communications Connector".


Core rules (adapter registry wired only via `@nessie/comms-providers`
`registerCommsConnectorsFromEnv` from `NESSIE_COMMS_*` env at API + worker
startup, encrypted token bundles in a separate table, resumable checkpointed
sync through the worker queue, owner-deactivation revocation gate, no
reasoning logic in the connector layer): stated above.
Additional facts:

- Adapter packages: `@nessie/comms-slack`, `@nessie/comms-google` (Slack +
  Gmail live; Microsoft/Teams planned), normalizing into the `CommsEvent`
  store via the provider-agnostic `@nessie/comms-connect` core. Env names
  match the API OAuth-start source of truth
  (`api/src/routes/comms/oauth-config.ts`).
- Prisma-aware credential loading lives in `@nessie/team-admin`, shared
  by API and worker: it decrypts only the selected connection, serializes
  expired token refresh under a credential-row lock, preserves a stored
  refresh token when Google omits a replacement, persists expiry/scope
  changes, and moves a provider-rejected credential atomically to
  `needs_reauthorization`. Do not recreate row-to-connector decryption in
  either process.
- An expired provider cursor (`SyncCursorExpiredError`) triggers a bounded
  history re-sync; a rejected credential (`needsReauthorization`) fails the
  job without retry. The owner-active gate lives in
  `worker/src/control/comms-sync.ts` (`isConnectionOwnerActive`).
- Chat-first: the `comms_connect_card` PA tool drives connect;
  `/settings/connections` is the secondary UI. Authoritative spec:
  [docs/plans/2026-07-21-individual-communications-connector.md](../plans/2026-07-21-individual-communications-connector.md).

### Google scopes are a capability catalog, and the checks fail closed

Gmail, Calendar, Meet and contacts reach chat through one capability
catalog (`packages/schemas/src/google-capabilities.ts`) whose checks fail
closed at one credential chokepoint. The rules — granted-not-requested
scopes, identity from the OIDC `id_token`, 403 classified by machine
reason, all-of capability checks, local blocks, bound OAuth state, the
content-bound send approval and its standing grants — live in
[docs/google-workspace.md](../google-workspace.md), with the invariant
itself in [docs/standards/google-workspace.md](google-workspace.md).
Plan and phasing:
[docs/plans/2026-08-31-google-workspace-email-calendar.md](../plans/2026-08-31-google-workspace-email-calendar.md).
