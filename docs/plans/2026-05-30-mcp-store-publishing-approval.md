# Apps catalogue — publishing, approval, and personal connectors

Status: implemented (2026-05-30)

Extends the MCP universal connector (`docs/plans/2026-05-16-mcp-universal-connector.md`)
so the catalog behaves like an app store:

- **Personal (private) connectors** — any signed-in user can author a connector.
  It starts `private` + `draft`, owned by the author (`ownerUserId`). The owner
  self-publishes it (`draft` → `published`) and installs it at their own `user`
  scope without any review.
- **Submit for the public store** — the owner submits a connector for public
  listing. Visibility flips to `public` and status moves to `pending_approval`.
- **Super-admin approval** — the reviewer is `User.superAdmin`, the instance-wide
  administrator. They review the queue and `approve` (→ `published`, store-wide)
  or `reject` (→ `private` `rejected` draft with a reason, freeing the public
  name so the author can revise and resubmit).
  **Amended 2026-08-16:** this was originally the per-organisation `owner` role
  ("no new auth concept"), which was defensible only while a Nessie instance
  held one flattened shared organisation. Under per-UOA-org tenancy publishing
  puts a connector in front of *every* organisation on the deployment, so it is
  instance administration and names the role that means that. Same reasoning for
  the `queue`/`all` management views and for mutating an instance-global
  (`organizationId: null`) catalog row — `canManageEntry`. An org `owner` still
  manages their own organisation's entries and install scopes unchanged.
- **Install** — anyone can install a `published` connector. Members may
  only install/manage at their own `user` scope; org owners install at any scope
  within their organisation (unchanged — install scope is organisation-scoped,
  not instance-wide).

## Data model

`McpCatalogEntry` gains:

- `visibility` (`private` | `public`) — `McpCatalogVisibility` enum.
- `ownerUserId` — owner of a private entry; `null` for public/store entries.
- `status` extended with `pending_approval` and `rejected`.
- approval audit: `submittedAt`, `reviewedAt`, `reviewedBy`, `rejectionReason`.

Uniqueness moves from the old `([organizationId, name])` composite to two
partial unique indexes (a single key cannot express both rules):

- public names are unique store-wide: `UNIQUE (name) WHERE visibility='public'`;
- private names are unique per owner and organisation:
  `UNIQUE (organization_id, owner_user_id, name) WHERE visibility='private'`.

Migrations: `20260530120000_mcp_catalog_status_review_states` (enum ADD VALUEs,
isolated because Postgres can't add and use an enum value in one transaction),
then `20260530120100_mcp_catalog_visibility_approval`.

## Lifecycle

```
private:  draft --publish--> published --deprecate--> deprecated
public:   draft|rejected --submit--> pending_approval --approve--> published
                                                       --reject--> rejected (private)
```

## Surfaces

- Service: `api/src/services/mcp-catalog.ts` (CRUD, visibility-scoped listing,
  access predicate, private publish/deprecate) and `mcp-catalog-review.ts`
  (submit/approve/reject).
- Routes: `api/src/routes/mcp/catalog.ts` (`/submit`, `/approve`, `/reject`,
  `?view=store|mine|queue|all`) and `instances.ts` (own-scope install gate).
- User surface: `/apps` for discovery and user-scoped connection. Catalogue
  review remains available to trusted API and personal-assistant callers.
- Seed: `api/src/db/seed-connectors.ts` seeds the public store with Context7
  (`pnpm --filter @nessie/api seed:connectors`).

## Out of scope

Organization-tier visibility, marketplace signing, and per-connector ratings —
deferred unless a need appears.
