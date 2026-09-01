# Tenant-isolation conformance suite

Nessie is multi-tenant: the whole data model hangs off
`Organisation → Project → Team → Channel`, and every child table carries an
`organization_id`. The single most important security invariant is therefore
**tenant isolation**: a caller authenticated in organisation B must never be
able to read or mutate organisation A's rows, no matter how privileged they are
inside their own org.

This suite is the systematic, machine-checked proof of that invariant across the
REST surface. It is the pragmatic port of block/buzz's multi-tenant conformance
testing (`docs/reviews/2026-07-23-buzz-comparison.md` §4, P0).

Location: `api/test/conformance/`. Run it with the repo's standard test command:

```bash
pnpm --filter @nessie/api test          # runs the whole api suite, conformance included
# or just this suite:
cd api && node --test --import tsx 'test/conformance/**/*.test.ts'
```

## What it proves

For a representative matrix of resource areas, it asserts that **a legitimate
owner of org B**, acting against **org A's resources**, gets `403` / `404` /
empty on the canonical read, and is rejected on the canonical mutation with the
org A row left untouched.

| Resource area | Canonical read | Canonical mutation | File |
|---|---|---|---|
| Channels | `GET /api/channels` (empty) | `PATCH /api/channels/:id`, `POST …/archive` (403) | `channels.test.ts` |
| Approvals | `GET /api/approvals`, `GET …/:id` (404) | `POST …/:id/resolve` (404) | `approvals.test.ts` |
| Audit log | `GET /api/audit-log`, `GET …/:id` (404), `GET …/verify` (own chain only) | — (read-only surface) | `audit-log.test.ts` |
| Triggers | `GET /api/triggers` (empty) | `DELETE /api/triggers/:id`, `POST …/pause` (404) | `triggers.test.ts` |
| Agents (+bindings, activity) | `GET /api/agents` (empty), `GET …/:id/status` (404) | `PUT /api/agents/:id` (404), `POST …/:id/bindings` (404) | `agents.test.ts` |
| Runs (lifecycle) | `GET /api/runs/active` (empty) | `POST …/:id/cancel`, `POST …/:id/restart` (404) | `runs.test.ts` |
| Projects | `GET /api/projects`, `GET …/:id` (404) | — | `resources-read.test.ts` |
| Tasks | `GET /api/tasks`, `GET …/:id` (404) | — | `resources-read.test.ts` |
| Iterations | `GET /api/projects/:id/iterations` (404) | — | `resources-read.test.ts` |
| Threads / messages | `GET /api/threads/:id/messages` (404) | — | `resources-read.test.ts` |
| Comms connections | `GET /api/comms/connections` (empty), `GET …/:id` (404) | — | `resources-read.test.ts` |
| Workflow installations | `GET /api/workflow-installations` (empty) | — | `resources-read.test.ts` |
| MCP instances | `GET /api/mcp/instances` (empty) | — | `resources-read.test.ts` |
| Knowledge base | `GET /api/knowledge-base/spaces` forwards the **caller's** org | — | `knowledge.test.ts` |
| Alerts | `GET /api/alerts` (empty; also per-recipient within the caller's org) | `POST /api/alerts/read` (no-op, row untouched) | `alerts.test.ts` |

## How it works

Each case boots the **real route module** on a fresh Fastify instance and drives
it with `app.inject(...)`. Two things make the assertions honest rather than
vacuous:

1. **A faithful in-memory Prisma** (`tenant-store.ts`). It applies the *exact*
   `where` clause each route/service hands it — scalar equality, `in` / `not` /
   comparison operators, nested `AND` / `OR` / `NOT`, and to-one relation
   filters resolved through the conventional `<relation>Id` foreign key. If a
   handler forgets to scope a query by `organizationId`, the store returns the
   foreign-org row and the test turns **red**. The store never injects its own
   scoping — tenancy must come from the code under test. `tenant-store.test.ts`
   guards the store itself (proves it returns seeded rows and honours `where`),
   so a bug that made every query return empty cannot hide a leak.

2. **A maximally-privileged attacker** (`harness.ts`, `seedTenants`). The
   caller is seeded as a full **owner** of their own org (org member, team
   owner, project member). With those membership fallbacks present, the *only*
   thing that can stop them from reaching an org A resource is a correct
   `organizationId` check. Remove that check in a handler and the fallbacks
   would grant access — turning the conformance case red. (Verified: deleting
   the org check in `canManageChannel` flips the channel mutation cases from
   `403` to a non-403.)

The real `createRequestHelpers(prisma)` runs against the fake store, so
accessibility gates (`isAgentAccessibleToActor`, `getChannelIfMember`,
`isTriggerAccessibleToActor`, …) exercise their genuine org filters.

## Extending it — every new resource gets a conformance row

**When you add a route that reads or mutates a tenant-scoped resource, add a
conformance row for it in the same change.** This is part of the definition of
done for a new resource surface, exactly like updating the docs.

1. Pick the canonical read (a list and/or a by-id GET) and, if the resource is
   mutable, one canonical mutation.
2. In the matching `*.test.ts` (or a new one for a new area), `seedTenants(store)`
   and seed the resource under **orgA** with just the fields the scoping gate
   touches (usually `id` + `organizationId` + whatever the gate's `where`
   reads).
3. `makeApp(registerYourRoutes, store, foreignOwner())` and `inject` the read →
   assert empty / 404. Inject the mutation → assert 403/404 **and** that the
   seeded orgA row is unchanged (`store.rows('model')`).
4. Add the row to the table above.

If a route module has a bespoke deps shape (e.g. `registerMcpRoutes`), wrap it in
the `register` callback and pass only the deps it needs (see the MCP case in
`resources-read.test.ts`).

## What it deliberately does NOT prove

- **No full-stack boot / real Postgres.** The suite runs each route module
  against the in-memory store, not a live DB. This keeps it fast and
  dependency-free, at the cost of not exercising the actual SQL. Row-level SQL
  scoping is covered by the owning package's own tests (e.g. `@nessie/knowledge`
  for the knowledge provider).
- **Knowledge base is checked at the route boundary only.** KB row filtering
  lives inside the `KnowledgeProvider` (the first-party provider scopes in SQL).
  The conformance case pins the *route's* responsibility — that it forwards the
  authenticated caller's org and never a client-supplied one — not the
  provider's SQL.
- **No mutation-testing of scope clauses.** The negative control was run by hand
  (removing a scope check and watching a case go red); the suite does not yet
  automatically perturb `where` clauses to prove each one is load-bearing.
- **Depth is intentionally shallow.** One canonical read + one canonical
  mutation per area — breadth over depth. It is a conformance floor, not an
  exhaustive per-endpoint authz matrix.

The success path (owner reading their *own* org's resource) is intentionally not
asserted for most areas because the in-memory store does not hydrate relation
`include`/`select` payloads that mapping code expects. Non-vacuousness is instead
guaranteed by `tenant-store.test.ts` and the privileged-attacker seeding above.
