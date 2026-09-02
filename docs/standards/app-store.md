# The App Store (/apps)

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **The App Store (`/apps`) is the product surface on `McpCatalogEntry`, never
  a second catalogue.** One row is one app; a parallel `mcp_apps` table would
  guarantee drift. Store visibility is
  `moderationState IN ('curated','approved')` + `trustLevel <> 'blocked'`
  composed with `catalogTenancyWhere` — and `curated` additionally requires
  public+published or caller-owned, because the migration backfills `curated`
  onto every pre-existing non-public row and a bare `IN` would list one
  member's private draft connector to their whole organisation. **The store
  reads a decision and never re-derives one from `status`**: approval writes
  `approved`, rejection and deprecation write `hidden`, and submission writes
  nothing (a request is not a decision). Skipping those writes is what let a
  rejected connector keep rendering to its owner and a deprecated one keep an
  enabled Connect button. Ranking lives
  in Postgres (weighted name/aliases A, publisher B, tags C, prose D, plus a
  `pg_trgm` typo fallback); **the client filters nothing and re-sorts nothing**,
  because re-scoring the server's answer in the browser silently drops the
  fuzzy matches only the index can find. `search_vector` is trigger-maintained
  rather than a generated column — `array_to_string` is only STABLE and
  Postgres refuses it (`42P17`). Every `/api/apps` response goes through a
  presenter that cannot emit a `credentialRef`, auth/transport config, endpoint
  URL, or a raw upstream icon URL, and `listAgentsWithAppAccess` imports
  `buildAccessibleChannelWhere` from `@nessie/workspace-admin` rather than
  restating it, so a member-readable surface can never name an agent
  `GET /api/agents` would withhold. Spec:
  `docs/plans/2026-08-29-apps-catalogue/overview.md`.
- **App Store connect orchestrates the existing OAuth/instance machinery; it is
  never a second stack.** `POST /api/apps/:slug/connect` sequences
  `createInstance` → probe → `startOAuth`. PKCE must be present on BOTH legs —
  sending `code_challenge` without returning `code_verifier` makes any RFC 7636
  §4.6 server reject the exchange, and the completion tests that used an
  argument-ignoring stub are why that shipped unnoticed once. The OAuth callback
  stays a **constant HTML page that never redirects** (a caller-supplied return
  URL is an open redirect); it posts a fixed message to its opener at a
  server-resolved origin, and the popup carries `noopener` because its first
  navigation is the third-party authorize URL, not ours. **Installing an app is
  not granting it**: `McpServerInstance.requiresExplicitToolGrant` (default
  false) is carried into `projectMcpToolDescriptors` on both the create and
  update branches — update too, or a capability discovered by a later refresh
  projects open and silently widens the app — and the worker's existing
  `isExposed` enforces default-OFF. Never add a grant table: `ToolGrant` rows
  exist and the worker never reads them.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Apps catalogue — `/apps`".


Installing an integration should feel like installing an app in Slack, not like
configuring a server. `/apps` is that surface, filled from the official MCP
Registry (~5,500 apps). The invariants — second face on `McpCatalogEntry`,
store reads a decision (never re-derives from `status`), Postgres-owned
ranking with no client re-sorting, connect orchestrates the existing
`createInstance` → probe → `startOAuth` machinery (PKCE on both legs, constant
callback page, `noopener` popup), installing-is-not-granting via
`requiresExplicitToolGrant`, and the leak-proof presenter — live in
[docs/standards/app-store.md](app-store.md). Spec:
[docs/plans/2026-08-29-apps-catalogue/overview.md](../plans/2026-08-29-apps-catalogue/overview.md).
Facts not restated there:

- **Installed is one flat shelf; categories are a catalogue affordance.**
  `?installed=true` with no category returns a single alphabetical page spanning
  every category (`loadInstalledPage`), paged on `offset` against
  `installedCount` exactly as a category page is. It renders through the same
  `AppCategorySection` with `category: null` + `standalone` (`installedShelf`),
  so the flat list is a parameter of the shelf, never a second grid; the Featured
  strip is hidden there because, uncurated, it *is* that list. An empty grid also
  suppresses the footer nudge — the two said the same sentence with the same
  button one line apart — and `catalogueEmptyMessage` returns `actions`, so a
  search that found nothing inside Installed offers **Search all apps** (drops
  the narrowing, keeps the query) beside Add custom app.
- **Ingested rows are always `community`.** Trust decided from the advertised
  endpoint was forgeable: the record author picks that URL.
- **An app icon resolves on first view and the instance shares one copy.**
  Caching was wired only into the owner-triggered sync, so the scheduled sweep —
  the only sync that writes in production — left all 5,548 rows on a monogram.
  `resolveAppIcon` asks four sources in descending order of worth — the
  publisher's registry-declared `icons` (now captured at ingest; it used to be
  discarded), the site's own `<link rel="icon">`, conventional paths, then the
  publisher's GitHub avatar — unwrapping a PNG out of an `.ico` rather than
  rejecting it. That is 75% of rows measured, against 32% for guessed paths
  alone. It claims the attempt with
  one conditional `iconResolvedAt` UPDATE so dozens of cards fetch once and a
  site with no favicon is never re-tried unless a later registry sync supplies
  a new candidate, and **never blocks the request** — the route 404s immediately
  and the icon appears next visit. Bytes are
  origin-only-candidate, `safeFetch`-pinned, byte-capped, MIME-sniffed to raster
  (SVG dropped) and stored through `FileService`. The client reads it as an
  authed blob (`useAuthedObjectUrlFromPath`): `<img src="/api/…">` fails both on
  cross-origin (`app.` vs `api.`) and on the missing `Authorization` header.
- Service in `packages/mcp-manage/src/apps/`; seeds
  `pnpm --filter @nessie/api seed:apps` and `sync:registry`.
