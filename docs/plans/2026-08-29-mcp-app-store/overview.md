# MCP App Store

Browsing and installing an integration should feel like installing an app in
Slack or Notion, not like configuring a server. `/apps` is that surface.

**Status:** all eight phases shipped — the catalogue, registry ingestion, the
generic MCP runtime, universal OAuth, platform auth UX, agent grants, and custom
servers. What remained after that was making the store fill itself on a real
deployment: the two catalogue seeds now run in `redeploy.sh` after the
migration, and a scheduled worker sweep runs the registry sync ~every 6 hours
(and once shortly after startup) so the ~5,500 apps arrive and stay fresh
without anyone running a CLI.

## Table of Contents

- [ux-design-catalogue.md](ux-design-catalogue.md) — the catalogue page, the
  app card and its eight states, categories, search, responsive behaviour.
- [ux-design-detail-and-connect.md](ux-design-detail-and-connect.md) — the app
  detail view, the universal Connect flow, connection management, agent access,
  custom servers, trust badges, and the component reuse map.

## Table of Contents

- [ux-design-catalogue.md](ux-design-catalogue.md) — the store: browse, search,
  categories, and the app card.
- [ux-design-detail-and-connect.md](ux-design-detail-and-connect.md) — one app's
  detail page and the connect flow.

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

**A prefix lane covers the first two keystrokes.** Full text matches whole
lexemes and the trigram lane needs three characters, so `"fi"` answered empty
while `"fin"` answered — the store stopped narrowing exactly as a person began
to type. `prefixTerm` OR-s Postgres' own `to_tsquery('simple', 'fi:*')` onto the
whole-word query, so an exact match still outranks a prefix hit. It is the only
tsquery text this module assembles by hand, so the lexeme is **whitelisted
rather than escaped**: the last word lowercased, everything outside `[a-z0-9-]`
dropped, trailing hyphens trimmed (tsquery rejects them), and nothing left means
no prefix term at all. The bound parameter stays the raw user text; `:*` is the
one interpolated character and it is a literal.

Its tests are worth reading before adding another: a 2-character prefix is
*intrinsically* low-signal — on the synced registry `"fi"` matches ~1,600 of
5,500 rows, all legitimately (`FileToPDF`, `Financial`, `Filtrix`). A test that
seeds one row and asserts it lands inside a `LIMIT`ed slice is therefore
measuring how full the shared database is, not whether prefix matching works.
Assert on a token the catalogue does not carry, and assert *that the lane
answers*, never a position.

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
- **Icons come from the distribution that declares them.** The registry's
  `server.icons` raster is cached when present. When it is absent, an
  owner-triggered sync can resolve an IDE-style `ideToolIconPath` from the same
  public GitHub repository named by the record, but only for the descriptor
  entry whose endpoint is the one being imported. The relative path cannot
  escape the repository; SVG is structurally reduced to static shapes and
  rasterised server-side; and the browser receives only the cached raster
  attachment, never an upstream or raw SVG URL.

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

**A catalogue name is the record author's claim, and the store must not repeat
it as fact.** The registry lets any author pick any name: the store's "Jira" is
not Atlassian but an entry published by `waystation` pointing at
`waystation.ai/jira/mcp`. Two rules follow, both learned from that one row.

- **`authMethod` is evidence only on an entry a human authored.** On an ingested
  row it is the column default — the registry does not describe a server's auth
  — so 4,685 of 5,532 rows read `none` and *none* reads `oauth2`. Rendering that
  as "This app needs no sign-in" turned a default into a promise and told people
  Jira needs no sign-in. For an ingested row the dialog instead says what will
  happen ("Nessie will ask waystation what sign-in it needs") and lets the
  protocol answer, since auth is discovered at connect time (probe → 401 →
  RFC 9728). `catalogueStatesAuth` is that predicate, in `app-connect-copy.ts`
  so it can be asserted rather than living inline in the component.
- **The dialog names the publisher**, because it is the one screen where a
  person decides to trust a server. The card carried "By waystation" and the
  dialog carried nothing, so the moment of consent named a famous company and
  nobody else. A `community` entry is additionally marked "not verified by
  Nessie" — the same reason a trust badge is never minted from a self-declared
  field.

Error copy follows from the same rule: an unreachable server is reported as
"the server listed for Jira", never "Jira's server". The latter announces an
outage at Atlassian on the strength of a stranger's listing and sends the reader
to check the wrong thing.

**Connecting happens on `/apps`, in a dialog that says what it will do.**
Connect used to navigate to the Connectors page, which dropped the person out
of the store mid-decision and into a surface built for a different question.
`AppConnectDialog` runs the whole flow in place and states the cost of the
click *before* it is made — "Connecting opens a … sign-in window", "needs no
sign-in", or "needs an API key" — read from `AppSummaryRecord.authMethod`. That
field is on the wire for exactly this reason and is the auth *method* only: the
presenter's `STORE_CATALOG_SELECT` still cannot emit `authConfig`, a
`credentialRef`, or the endpoint. A failure keeps the person in the dialog and
says nothing was saved, because a half-made connection they cannot see is worse
than a refusal they can retry.

A card's **pill and its action are two different jobs** — the pill says what
state the app is in, the action says what you can do — so they must never carry
the same word. `connecting` broke that: a "Connecting…" pill sat beside a
*disabled* "Connecting…" button, which named no decision and read as a rendering
fault. The state stays on the pill and the action is now the doorway the code's
own comment already described ("Finish setup" → the accounts tab), because
`connecting` is `lifecycleState: 'pending_setup'` — an install waiting on a key
nobody entered sits there indefinitely, so the label must offer a way on without
promising the system will resolve it.

**Narrowing to a category leaves that shelf and no other.** The server keeps
counting every category while `?category=` narrows the slice — deliberately, so
the dropdown can offer the ones you are not looking at — but the page rendered a
section per *counted* category, so picking Communication painted fifteen other
headings and pushed the apps themselves below the fold. `visibleShelves` narrows
the body while `sections` stays whole for the toolbar, the Featured strip is
hidden (four apps from other categories are the same interruption the headings
were), and the surviving shelf renders `standalone`: no heading, since the
dropdown directly above already reads "Communication (150)", and no two-row cap
or "Show all", since collapsing the only thing on the page is not a move anybody
wants. It still pages, so the whole category is reachable.

The catalogue's toolbar is one row: search, the All/Installed filter, then the
category `<select>` right-aligned. Categories were a chip row, which the
registry's ~5,500 apps made unusable — 16 categories do not fit a line, and a
horizontally-scrolled chip strip hides its own tail. The dropdown's first option
is "All categories" and carries **no count**, deliberately: the filter
immediately to its left already shows that same total, and two adjacent controls
both reading "All (1092)" say nothing about which one narrows what. Counts stay
on the individual categories, where each names a real choice, and every count is
the server's aggregate rather than the length of the loaded slice. Narrowing is
a server round trip (`useApps({ category })`) — per §"Search is the database's
job", the client never filters what it was sent.

## Not built yet

Icon caching — `iconsCached` is always 0, because a cached icon has to go
through the `FileService` chokepoint and a raw upstream icon URL must never
reach a browser. Resource and prompt counts are `null` (undetermined, never
guessed as 0) for any server whose listings could not be read.
