# MCP App Store

Browsing and installing an integration should feel like installing an app in
Slack or Notion, not like configuring a server. `/apps` is that surface.

**Status:** Phases 2 and 3 shipped — the catalogue, and the registry ingestion
that fills it. Phases 4–8 (the generic MCP runtime, universal OAuth, platform
auth UX, agent grants, custom servers) are still to come.

## Table of Contents

- [ux-design-catalogue.md](ux-design-catalogue.md) — the catalogue page, the
  app card and its eight states, categories, search, responsive behaviour.
- [ux-design-detail-and-connect.md](ux-design-detail-and-connect.md) — the app
  detail view, the universal Connect flow, connection management, agent access,
  custom servers, trust badges, and the component reuse map.

## One catalogue, two faces

The App Store is **a second face on `McpCatalogEntry`, never a second
catalogue**. One row is one app. `/apps` is the member-facing store; the
existing `/mcp-app-store` "Connectors" page stays as the governance surface
(catalog review, install scopes, credentials, the approval queue). Both read
the same rows, so they cannot drift into two sources of truth — which is
exactly what a parallel `mcp_apps` table would have guaranteed.

Product vocabulary on `/apps`: MCP server → **App**; a connection → **Connected
account**; `tools/list` → **Capabilities**. A person never needs to know the
words MCP, OAuth, PKCE, or transport to use this page.

## The store dimension

Migration `20260829090000_mcp_app_store_catalogue` adds presentation and
curation columns to `mcp_catalog_entries` — curated copy, icon reference,
category/tags/aliases, trust, moderation state, source, distribution, featured
ordering, registry provenance, cached capability counts — plus
`mcp_registry_sync_runs` and `mcp_server_health`. Additive only: no existing
column changes type, nothing is dropped, and installed connectors keep working
untouched.

Two decisions in that migration are worth keeping in mind, because both were
arrived at the hard way:

- **`slug` is the immutable public identity behind `/apps/:slug`.** `name`
  could not serve: it is mutable, and unique only among *public* entries.
  Existing rows are backfilled by slugifying `name`, with an id-derived suffix
  where private entries genuinely collide. The trim of leading/trailing
  separators happens **inside** the expression the duplicate count reads —
  trimming afterwards makes `"Notion (dev)"` and `"Notion dev"` collide only
  after de-duplication, and `CREATE UNIQUE INDEX` then aborts the migration. A
  final pass nulls any residual duplicate rather than letting a migration fail
  on someone's production data; a null slug is still addressable because the
  store resolves an app by slug **or** id.
- **`search_vector` is maintained by a trigger, not a generated column.** The
  generated column was the first choice and Postgres refuses it (`42P17`):
  `array_to_string` is only STABLE. The trigger keeps the property that
  mattered — no write path can forget to update it — without the immutability
  constraint.

## Search is the database's job

Ranking lives in Postgres, weighted so an app's own name and its curated
**aliases** are weight A, publisher B, tags C, prose D. This is what makes
`"pentest"` find DeepTest and `"research"` find Deep Water when neither word is
in the visible copy. A `pg_trgm` fallback recovers typos (`"githb"` → GitHub).

**The client filters nothing and re-sorts nothing.** Re-scoring the server's
results in the browser silently *drops* rows: a fuzzy match reaches GitHub only
through trigram similarity, and no substring test on the loaded record can
reproduce it, so the card simply vanishes. `describeSearchResults` labels the
server's answer with why each row matched; it never decides what matched.

## Visibility

The store shows `moderationState IN ('curated','approved')` and
`trustLevel <> 'blocked'`, composed with `catalogTenancyWhere` — the one
tenancy floor, never re-derived. `approved` is an explicit human decision and
is admitted unconditionally; `curated` additionally requires the entry be
public+published or owned by the caller, because the migration backfills
`curated` onto every pre-existing non-public row and a bare `IN` would list
one member's private draft connector to their whole organisation.

A human-authored entry is created `curated` with a resolved slug, so the page's
own "Add custom MCP server" produces something the page can actually show.

`listAgentsWithAppAccess` imports `buildAccessibleChannelWhere` from
`@nessie/workspace-admin` rather than restating it: `/apps/:slug` is
member-readable and must not name an agent `GET /api/agents` would withhold, so
the rule has to move in one place.

## Where the code lives

- `packages/mcp-manage/src/apps/` — catalogue read model, search, card-state
  derivation, presenter, agent access. In the shared package because
  `api/src/services/*` is unreachable from the worker.
- `api/src/routes/apps.ts` — `GET /api/apps`, `/api/apps/:slug`,
  `/api/apps/categories`. Member-level (`requireActorContext`), not owner-gated.
- `api/src/db/seed-apps.ts` — store listings for the connectors that ship
  today (`pnpm --filter @nessie/api seed:apps`). The seed matches only
  instance-global first-party rows, so it can never stamp `trustLevel: 'nessie'`
  onto an organisation's own same-named connector.
- `admin/src/pages/AppsPage.tsx`, `AppDetailPage.tsx`,
  `admin/src/components/features/apps/`, `admin/src/facades/apps/`.

Every response goes through a presenter that cannot emit a `credentialRef`,
auth config, transport config, endpoint URL, or a raw upstream icon URL.

## Registry ingestion (Phase 3)

The catalogue is filled from the official MCP Registry — a measured ~5,500
installable apps, against the 5 first-party connectors it launched with.
`packages/mcp-manage/src/registry/` holds the client, mapper, categoriser,
merge policy and importer; `POST /api/admin/mcp-registry/sync` (owner-only) and
`pnpm --filter @nessie/api sync:registry` are the two doorways.

What the design turns on:

- **Only `isLatest` + `active` + an HTTP/SSE remote is installable.** Everything
  else is counted as skipped, not imported — a package-only server is not
  something Nessie's remote-only connector model can reach.
- **Ingest as `discovered`; auto-promote to `curated` on objective gates only**
  (https endpoint past the SSRF guard, a description of real length, a
  resolvable name). Never auto-`approved`: that state means a human decided.
- **An ingested row is always `community`.** The first mapper granted
  `verified` when the advertised endpoint matched Nessie's curated library, and
  the record author chooses that endpoint — so publishing
  `io.github.attacker/notion-official` pointing at Notion's real URL minted a
  store card carrying the attacker's own copy under a badge saying Nessie had
  confirmed it with the publisher. `verified` is a human judgement again;
  `20260829160000_demote_ingested_trust` clears rows written before the fix.
- **One server is one app.** A record with no `registryName` match adopts an
  existing row with the same canonical endpoint — stamping provenance onto it —
  rather than inserting a rival `context7-2` beside the seeded Context7.
  `registry_name` carries a partial unique index so two concurrent sweeps
  cannot both insert.
- **The persisted endpoint is canonical** (lower-cased host, default port and
  trailing slash dropped), and `findApplicableLock` now canonicalises both
  sides. Otherwise a registry row advertising `https://API.Example.com:443/mcp`
  walks straight past an admin lock recorded on `https://api.example.com/mcp`.
- **Curation is never overwritten.** A column is rewritten only when it still
  holds what the last sync wrote, or is unset — with the two NOT NULL defaults
  (`primaryCategory: 'other'`, `trustLevel: 'unknown'`) tested *before* the
  generic empty-string check, or an untouched column reads as curator-owned and
  no adopted row is ever categorised.
- **Categorisation is deterministic rules, not a model.** These are
  machine-authored records written to a published schema by publishers who
  chose their words; sending thousands through a model would cost real money to
  produce an answer nobody could reproduce or correct. The rule table was
  extended against the actual ingested corpus rather than guessed, which took
  uncategorised apps from 74% to ~48%. A rule matching nothing leaves the app
  in `other` — a wrong shelf is worse than no shelf.
- **Untrusted text and URLs.** Every URL-shaped field is http(s)-constrained at
  the schema, rejected at ingest, and sanitised again on the way out; the same
  gate was applied to `library.ts`, where the identical vector was still open.

## The connect flow (Phases 4–8)

**Connect orchestrates what already existed; it is not a second stack.** Nessie
had RFC 9728 / RFC 8414 / OIDC discovery, PKCE, RFC 8707 resource indicators,
RFC 7591 dynamic registration, an AES-256-GCM token vault with refresh inside
the resolver, and `createInstance` with every scope, lock and SSRF guard.
`POST /api/apps/:slug/connect` sequences them: create the instance → probe → on
a 401 with OAuth, `startOAuth`. Three genuine gaps were closed:

- **Static-mode OAuth had no PKCE and no resource indicator.** It now mints a
  verifier, sends `code_challenge`/S256, and — the half that was missed first
  time — `completeOAuth` sends the verifier back. Without that, RFC 7636 §4.6
  says a server that recorded the challenge MUST reject the exchange, so every
  static-mode connector would have failed at the last step. The old completion
  tests used a stub that ignored its arguments, which is why nothing caught it;
  the new test asserts the verifier's SHA-256 equals the challenge.
- **No CIMD.** `GET /.well-known/oauth-client` publishes an OAuth Client ID
  Metadata Document, and client resolution now follows the spec's preference:
  pre-registered → CIMD (only when the AS advertises it) → DCR → operator.
- **A successful sign-in read as a failure.** Nothing probed after the callback
  stored the credential, so the instance stayed `pending_setup` and the client's
  poll timed out. `completeOAuth` now probes; a probe failure is deliberately
  not fatal, because the authorization really did succeed.

**The callback is still a constant HTML page.** No redirect back to the SPA: a
caller-supplied return URL is an open-redirect surface this feature does not
need. The page posts a fixed message to its opener with the target origin
resolved server-side from configuration, and the popup is opened with
`noopener` — its first navigation is the *third-party* authorize URL, so an
opener handle is a reverse-tabnabbing vector. Completion is therefore detected
by the status poll on focus, with the message as the fast path.

**Installing an app is not the same decision as letting an agent use it.**
`McpServerInstance.requiresExplicitToolGrant` is set when the App Store creates
a connection, and carried into `projectMcpToolDescriptors` — on both the create
and update branches, or a capability discovered by a later refresh would project
open and quietly widen the app. The worker's existing `isExposed` then keeps
those tools invisible until an agent's `toolPolicy` carries an explicit allow.
No new grant table: `ToolGrant` rows exist but the worker never reads them.
Default `false`, so every connector that predates this keeps exactly the
exposure it has.

Verified against the live Context7 MCP server: connect created the instance,
probed, discovered 2 capabilities, and both projected rows carry
`requiresExplicitGrant`. Resource and prompt counts read 0 there because the
server does not advertise those capabilities — the gate answers from the
handshake rather than sending a request that would error.

## Not built yet

Icon caching — `iconsCached` is always 0, because a cached icon has to go
through the `FileService` chokepoint and a raw upstream icon URL must never
reach a browser. Resource and prompt counts are `null` (undetermined, never
guessed as 0) for any server whose listings could not be read.
