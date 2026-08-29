# MCP App Store

Browsing and installing an integration should feel like installing an app in
Slack or Notion, not like configuring a server. `/apps` is that surface.

**Status:** Phase 2 (catalogue foundation) shipped. Phases 3–8 — registry
ingestion, the generic MCP runtime, universal OAuth, platform auth UX, agent
grants, and custom servers — are still to come. The design for all of it is in
[ux-design-catalogue.md](ux-design-catalogue.md) and
[ux-design-detail-and-connect.md](ux-design-detail-and-connect.md).

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

## Not built yet

No connect flow. The detail CTA links to the existing install path on
`/mcp-app-store`, which already works. Registry ingestion, the universal OAuth
flow, per-agent grants, and custom-server addition are Phases 3–8.
