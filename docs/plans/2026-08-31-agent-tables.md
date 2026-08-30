# Agent Tables — agent-owned, shareable simple databases at SaaS scale

**Status:** design proposal — research + design only, no code.
**Date:** 2026-08-31
**Related:**
[2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
(the scope/visibility model this design reuses),
[2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md)
(ownership = stewardship),
[AgQL brief](../../../AgQL/docs/brief.md) (the query/storage **contract** this
design implements a subset of),
[AgQL rollout](../../../AgQL/docs/rollout.md) (where Nessie sits in AgQL's own
deployment plan),
[DeepCRM brief](../../../deepcrm.live/docs/brief.md) §5 and
[DeepCRM schema-engine](../../../deepcrm.live/docs/schema-engine.md) (the
composable storage engine this design adapts).

## The idea in one paragraph

Every Nessie agent can design simple databases for itself: **SQLite-style
logical tables** — typed columns, rows, uniqueness, indexes — that it creates,
edits, queries, and shares through tool calls. A competitor-research agent
keeps a `competitors` table; a recruiting agent keeps `candidates`; a PA keeps
its owner's `subscriptions`. Visibility and sharing follow the **agent scope
model** exactly: whoever can see the agent can see (and be granted use of) its
tables; a private agent's tables are private; sharing wider is a grant. And it
must hold at **SaaS scale**: thousands of orgs × dozens of agents × dozens of
tables each means the number of *logical* tables is effectively unbounded, so
the architecture is metadata-driven — a logical table is **rows in a shared
physical structure**, never a physical Postgres table per logical table.

## One engine or three? — the reconciliation verdict

The three prior designs **do reconcile into one engine**, because they occupy
three different layers and barely overlap:

| Layer | Source | What it contributes here |
|---|---|---|
| **Contract** — what an agent may ask, how queries/writes look, determinism, errors, limits, receipts | AgQL brief | The query IR (v0 subset: single dataset, `records`/`aggregate` modes), the Ingest contract (`insertOnly`/`replace`, stable ids, idempotency keys, CAS, write receipts with named visibility states), the closed kind system, `create_dataset`-style provisioning ("agents never create tables — the engine does"), scratch/durable tiers, quotas, the error style, and — decisively — §3.8's **placement-is-an-adapter-strategy** rule, which is the "infinite tables" answer stated as spec |
| **Storage engine** — how metadata-defined tables physically live in shared Postgres | DeepCRM brief §5 | JSONB current-state per row, metadata tables for types/columns, materialised unique-key table, append-only change log, the transactional write-path invariant list, `schema_version` caching. Adapted, not copied: the CRM's domain machinery (relations with edge attributes, pipelines, merge/dedup, activities) stays out |
| **Identity, scope, sharing, surfaces** — who owns a table, who sees it, where humans meet it | Nessie | `Agent.ownerUserId` (stewardship), `Agent.visibility` (`workspace`/`private`), the entitlement predicates (`listAgentsForUser` / `buildAgentVisibilityWhere`), `PolicyRule`/`PolicyBinding` for grants, `ApprovalRequest` for widening, the disclosure-basis sink, `Budget` + usage-event accounting, the worker queue, Rule zero surfaces |

The two genuine tensions are **timing** and **service boundary**, and both
have clean resolutions (argued in full in §"Conflicts", below):

1. **The AgQL runtime does not exist yet**, and AgQL's own rollout puts Nessie
   at Phase 3, behind Remember Ninja. Resolution: build a **Nessie-native
   engine that speaks the AgQL v0 contract shape** — same query JSON, same
   ingest JSON, same error discipline, same closed kinds — so agents learn one
   language once and the engine can later be re-based onto the real AgQL
   runtime as a binding change, invisible to every agent and stored query.
   What we do *not* do is invent a third query grammar (DeepCRM already has a
   second, bespoke one; adding another is exactly the fragmentation AgQL
   exists to end).
2. **DeepCRM's engine lives inside a CRM** whose brief explicitly says "not a
   general database". Resolution: reuse the *design*, not the *service*. Agent
   Tables is a Nessie capability (new `packages/agent-tables` + tables in
   Nessie's own Postgres), built to the same shapes, with a noted future
   option of extracting a shared engine package once both exist.

## The scale architecture (the heart)

### The claim to make real

"Near-infinite logical tables" decomposes into two very different problems:

- **Table count** — 10,000 orgs × 50 agents × 20 tables = 10M logical tables.
  Trivial *if* a logical table is a metadata row, catastrophic if it is DDL:
  millions of physical tables bloat the Postgres catalog, wreck autovacuum
  and backup, and per-tenant DDL under load takes locks the whole instance
  feels. Salesforce proved the metadata answer at planetary scale (one shared
  `MT_Data` + pivot index tables); DeepCRM chose the same family for the same
  reason; AgQL §3.8 names per-dataset physical tables "wrong at fleet scale"
  in as many words. This design follows all three: **a logical table is a
  schema definition; rows live in one shared, partitioned physical structure.**
- **Row count** — the shared structure must serve billions of rows without
  any single query touching more than its own (org, table) slice, and without
  per-column DDL (expression indexes per logical column would just move the
  DDL explosion one level down — this is the one place we deliberately
  diverge from DeepCRM, whose `is_indexed` creates real expression indexes and
  can afford to because a CRM tenant has ~dozens of attributes, not millions).

### Metadata model

All tables carry `organization_id`, timestamps, and actor columns
`(created_by_type ∈ human|agent|system, created_by_id)`; every read resolves
tenancy from the authenticated run context, never from arguments (house rule).

**`agent_tables`** — one row per logical table.
- `id`, `organization_id`, `owner_agent_id` (FK → agents), `owner_user_id`
  (steward — see §Ownership; composite tenancy FK to `organization_members`,
  the `Agent.ownerUserId` pattern), `slug` (unique per owner agent), `name`,
  `description` (**mandatory** — AgQL's rule: an undescribed dataset is one no
  other agent can ever use; the description is what `table_list` shows other
  agents), `visibility` (§Sharing), `durability ∈ {scratch, durable}`,
  `expires_at?` (scratch only), `schema_version int`, `lifecycle ∈ {active,
  archived}`, cached `row_count` and `data_bytes` (maintained by the write
  path, the cost gate's input), `archived_at?`.
- CHECK: scratch ⇒ `expires_at` set; archived ⇒ read-only in the service.

**`agent_table_columns`** — one row per column.
- `table_id`, `slug`, `name`, `description`, `kind` (closed set, §Kinds),
  `config jsonb` (enum options; decimal precision/scale; money currency;
  reference target table), `is_required`, `is_unique`, `is_indexed`,
  `default_value?`, `archived_at?`, `position`.
- Adding a column is a metadata insert + `schema_version` bump. Removing one
  archives it (values stay in row JSONB; the column vanishes from schemas and
  validation). Evolution is **additive-only and versioned** (AgQL rule);
  narrowing changes (new `is_required`/`is_unique` on existing data, enum
  option removal) run as guarded jobs that refuse with the colliding rows
  listed rather than mutating meaning silently.

**`agent_table_rows`** — the one shared row store, **hash-partitioned by
`organization_id`** (fixed partition count, e.g. 32, created once in the
migration — no runtime DDL ever).
- PK `(organization_id, table_id, row_id)`; `row_id` is the **agent-supplied
  stable string id** from the ingest contract (AgQL: stable ids are what make
  idempotent memory writes possible), engine-generated UUID when omitted.
- `data jsonb` — current state, validated against column metadata at every
  write (DeepCRM's read-path choice: one row, one read, no EAV pivot).
- `version int` (optimistic concurrency / `ifVersion` CAS), `created_at`,
  `updated_at`, actor columns, `deleted_at?` (soft delete; retention job hard
  deletes).
- Indexes, all prefixed `(organization_id, table_id, …)`: the PK;
  `(organization_id, table_id, updated_at desc)` for recency listing; GIN
  `jsonb_path_ops` on `data` per partition (equality via `@>` on any column
  without declared indexes).

**`agent_table_index_entries`** — the **typed pivot index**, replacing
per-column expression indexes (the Salesforce `MT_Indexes` shape). One row per
(row × indexed column):
- `(organization_id, table_id, column_id, row_id)` PK, plus exactly one of
  `value_text` (normalised: NFC, case-folded per kind rules, deterministic `C`
  collation — collation version is part of the determinism contract),
  `value_num numeric`, `value_ts timestamptz`.
- B-trees on `(organization_id, table_id, column_id, value_text)` /
  `(…, value_num)` / `(…, value_ts)` — three shared indexes serve
  equality/range/order on **every** indexed column of **every** logical table.
  Flipping `is_indexed` on later backfills entries via a worker job (receipt
  states report `index: pending → ready`, §Receipts).

**`agent_table_unique_keys`** — DeepCRM's `record_unique_keys` generalised:
`(organization_id, table_id, column_id, normalized_value)` UNIQUE → `row_id`.
This is both the constraint (`is_unique` is a real database uniqueness, not
application code) and the upsert/dedup lookup. A violation surfaces as a typed
`duplicate` error carrying the colliding `row_id`, so the agent can decide to
replace, re-id, or read first.

**`agent_table_changes`** — append-only field-level change log, **durable
tables only** (see §Conflicts #4): `table_id`, `row_id`, `column_id?`,
`kind ∈ {create, set, unset, delete, restore, schema}`, `old_value`,
`new_value`, actor, provenance `{agentId, runId, toolCallId}` from the run
context, `occurred_at`. This is the audit detail and the future
"value at time T" replay; it is deliberately *not* written for scratch tables,
whose whole point is cheap disposable working state.

**`agent_table_grants`** — the sharing unit (§Sharing).

**Not built:** an edge/link table (`record_links`), relation types with edge
attributes, merge/dedup machinery, per-value validity intervals, `is_multi`
array columns, views/lists metadata. Simple tables stay simple; each of these
has a named home in DeepCRM if an agent's problem is actually a CRM problem.

### Scale math, honestly

- **Logical tables**: 10M tables ≈ 10M `agent_tables` rows + ~100–500M column
  rows. Ordinary B-tree territory; catalog untouched.
- **Rows**: hash partitioning by org spreads load and vacuum; every index
  leads with `(organization_id, table_id)` so a query's working set is its own
  slice regardless of neighbours. B-trees stay shallow into the billions of
  rows. A pathological single tenant can later be `DETACH`ed to its own
  partition or promoted (below) without touching the contract.
- **Per-table ceiling**: a hard row cap per logical table (default **100k
  rows**, org-raisable to 1M via config) with an AgQL-style refusal-with-remedy
  beyond it ("this table is at its row cap; archive rows, raise the limit, or
  this is warehouse-shaped data that belongs elsewhere"). The cap is what
  keeps "simple tables" true and keeps the query cost model honest.
- **Write amplification**: one row write = 1 row + ≤ indexed-column pivot rows
  + ≤ unique-key rows + (durable) change rows. With column caps (≤ 64 columns,
  ≤ 8 indexed, ≤ 4 unique per table) that is bounded and predictable.
- **Promotion (the AgQL placement escape hatch, deferred but designed for)**:
  because every access path goes through `table_id` indirection and the engine
  compiles all SQL, a later `placement` field on `agent_tables`
  (`shared` | `dedicated`) can move one huge, hot, durable table into its own
  physical table with real typed columns — engine-owned migration, invisible
  to agents, exactly AgQL §3.8's "migrate a dataset between layouts as it
  grows or is promoted". v1 ships `shared` only; nothing in the contract
  changes when `dedicated` lands.

### Query performance model

Every compiled query is bounded by construction:

1. **Prefix always** — every SQL statement the compiler emits is anchored on
   `(organization_id, table_id)`; there is no cross-table or cross-org scan in
   the grammar at all (single-dataset queries, per AgQL v0).
2. **Route by index** — predicates on `is_indexed` columns compile to joins
   against `agent_table_index_entries` (equality, range, ordering); equality
   on unindexed columns uses the GIN `@>` path; range/order on unindexed
   columns is allowed **only** when the table's cached `row_count` is under a
   scan threshold (default 10k) — above it, a typed cost refusal names the
   remedy ("set is_indexed on `close_date`", which is one `table_alter` call
   plus a backfill job).
3. **Caps** — `take` mandatory-with-default (default 50, max 200 rows into
   the model channel), aggregate scans capped (default 100k rows), statement
   timeout (5s), predicate-tree depth 2, in-list ≤ 200, one query per call.
   Deployments may lower, never raise (AgQL limit discipline).
4. **Read-only role** — query compilation runs on a role that cannot write;
   the ingest path runs on a writer role confined to the `agent_table_*`
   namespace (AgQL's three-privilege-tier rule; the third, DDL, exists only in
   migrations because there is no runtime DDL).

## The kind system (closed, AgQL's)

Adopted from AgQL's closed kinds rather than DeepCRM's 20 CRM attribute types,
because determinism and future portability live or die here (see §Conflicts
#5):

| Kind | Storage in `data` | Pivot value | Notes |
|---|---|---|---|
| `id` | string | text | row ids and reference values |
| `text` | string | text (normalised) | NFC, length-capped (default 8 KiB) |
| `boolean` | bool | num (0/1) | |
| `enum` | string code | text | options in column `config`; code vs label distinguished |
| `integer` | number | num | int64 range checked |
| `decimal(p,s)` | **string** | num | exact decimals travel as strings (AgQL: hashing must never depend on float formatting) |
| `money(currency)` | `{amount: string}` | num | currency fixed per column in `config`; mixed-currency aggregation is impossible by construction |
| `date` | `"YYYY-MM-DD"` | ts | |
| `instant` | ISO-8601 UTC | ts | |
| `duration` | ISO-8601 duration | num (seconds) | |
| `reference(table)` | string row id | text | must resolve to a live row in a table the **writer can read** (AgQL ownership rule 7: a link the caller cannot fully read is refused). Queries stay single-table; the agent dereferences with a second query |

Binary `float` is excluded (AgQL exact core); there is **no free-form `json`
column** in v1 — DeepCRM's escape hatch is deliberately not carried over
(§Conflicts #5). No `is_multi` arrays in v1: one column, one value.

## The write path (invariant list — DeepCRM §5.4, adapted)

Every mutation (`table_put`, delete, schema change) is one transaction that:

1. resolves tenant + actor from the run context, never from arguments;
2. checks entitlement (§Sharing) for the table and the action;
3. **enforces quotas before work begins** (Remember Ninja's rule): row cap,
   byte budget, table/column counts;
4. loads the live schema (cached per `schema_version`);
5. validates and normalises every value by kind; **rejects unknown columns**
   (no silent drops — "fix the contract");
6. checks `ifVersion` CAS where supplied; conflict → typed error with current
   version so the agent re-reads;
7. upserts `agent_table_unique_keys` (violation → typed `duplicate` with the
   colliding row id) and `agent_table_index_entries` for indexed columns;
8. writes the row, the change rows (durable), and updates the cached
   counters;
9. records the idempotency key — every mutating tool takes `idempotencyKey`;
   replays return the original result verbatim (the retried-agent-turn rule:
   a retry must not duplicate rows).

### Receipts and freshness

`table_put` returns an AgQL-shaped write receipt with **named visibility
states** per record: `{record: committed, index: ready|pending,
embedding:<spec>: pending|ready}` (embedding states arrive with Phase 3
search). Synchronous states (`record`, unique keys) are `committed` in the
response; asynchronous ones (index backfill after `is_indexed` flips, future
embeddings) are jobs, and a query may pass
`afterWrite: {receipt, require: [...]}` to wait-or-fail rather than
sleep-and-retry. For v1's synchronous pivot writes this is nearly always
trivially satisfied — the contract is adopted anyway so the shape never has to
change when async states appear.

## The query surface — AgQL v0 subset, deterministic

Queries are JSON documents validated by a published schema (zod at the tool
boundary), single dataset, two modes in v1:

```json
{ "mode": "records", "table": "competitors",
  "where": { "all": [
    { "field": "tier", "op": "eq", "value": "enterprise" },
    { "field": "last_checked", "op": "inLast", "value": { "days": 30 } } ] },
  "order": [{ "field": "arr", "dir": "desc" }],
  "take": 25 }
```

- **Modes**: `records` (fetch) and `aggregate` (group + measures:
  count/countDistinct/sum/avg/min/max, per-aggregate filters, ratio-with-
  null-on-zero). `retrieve` (semantic) is Phase 3.
- **Operators (closed)**: `eq, neq, in, lt, lte, gt, gte, between, isNull,
  notNull`, bounded escaped `contains`/`startsWith` on text (never regex), and
  the anchored relative-time family (`inLast`, `inCurrent`, `inPrevious`) —
  calendar math is the compiler's, and **every execution carries an explicit
  anchor timestamp** (logged, replayable); the compiler never reads the clock
  mid-query. `all`/`any`/`not` composition, depth ≤ 2.
- **Determinism**: one meaning per construct; orderings extended to a total
  order with `row_id` tie-break so `take`/pagination reproduce; validation
  errors in specified order; text comparison under one pinned
  normalisation+collation. Same query, same data, same answer — the exact-core
  promise for this engine's subset.
- **Errors as language** (AgQL §3.12): every rejection names the offending
  part by JSON pointer, states the rule, and **enumerates legal alternatives**
  ("unknown column `revanue`; this table has: revenue, tier, arr, …") — while
  a table the caller may not see yields the same `unknown` shape as a
  nonexistent one, in every path.
- **No SQL, ever**: model strings are only ever matched against catalog keys
  (table/column slugs, enum codes) or bound as parameters. Physical
  identifiers are engine-owned. There is no raw mode and no passthrough.

Big results move **by reference, never through context**: the model channel
gets ≤ 200 capped rows; `table_export` materialises full results as a CSV/JSONL
file through the one `FileService` chokepoint into the knowledge base (quota-
gated, accounted), returning the attachment reference — AgQL §3.10's
by-reference principle implemented with machinery Nessie already has.

## The agent-facing tools

Builtins in the worker toolset (available to every agent — this is a base
capability like memory, not a granted integration; deployments can gate via
the ordinary tool-policy machinery). Names follow house convention; shapes
follow the AgQL MCP profile so a later runtime swap is a rename at most:

| Tool | Does | Notes |
|---|---|---|
| `table_create` | declare a table: name, description, columns (closed kinds), `durability` (default `scratch`), `visibility` (default derived, §Sharing) | the `create_dataset` analogue; refuses on quota; **there is no DDL anywhere in the surface** |
| `table_list` | catalog of tables the caller may see, with descriptions + row counts | scope-narrowed: what the agent can name and what it may query are the same set |
| `table_describe` | full schema, quotas, lifecycle, grants (owner view) | the read that makes every id-taking tool usable |
| `table_alter` | add column, archive column, add enum option, flip `is_indexed`, set `is_unique` (collision-checked), rename display names, edit description | additive-only; schema_version bump; backfill jobs with receipts |
| `table_put` | insert/replace records (stable ids, CAS, idempotency key, per-record outcomes, receipt) | AgQL Ingest verbatim; no update operators, no merge — `replace` is whole-record |
| `table_delete_rows` | delete by ids (soft), same receipt contract | |
| `table_query` | the query surface above | returns schema + capped rows + truncation flag + receipt |
| `table_export` | full result → CSV/JSONL file by reference | FileService, quota-gated |
| `table_share` / `table_unshare` | grant/revoke read|write|define to workspace, a team, an agent, or a person | widening beyond current audience needs steward approval (§Sharing) |
| `table_promote` | scratch → durable (re-validates quota, keeps provenance) | AgQL `promote_dataset` |
| `table_drop` | two-phase guarded destruction: preview (row count, grants, dependent references, confirm token) → confirm | Remember Ninja's pattern; durable shared tables route through `ApprovalRequest` |

Tool descriptions are the spec agents read (DeepCRM's rule zero, headless
edition): each ships with a description good enough to use unprompted, and the
capability is not done until it does.

## Ownership, visibility, sharing — the scope model, reused

### Ownership

A table is owned by the **agent** that created it (`owner_agent_id`) and
steered by that agent's **steward** (`owner_user_id`, copied from
`Agent.ownerUserId` at creation; ownership transfer of the agent moves its
tables' stewardship with it). Two special cases, both structural:

- **PA-created tables belong to the person, not the singleton.** The PA is one
  org row acting per-user via `effectiveUserId`; a table it creates stamps
  `owner_user_id = effectiveUserId` and `visibility = private` — it is that
  person's table, served by their assistant, invisible to everyone else. This
  is the same "per-user fact on the shared row" resolution as
  `AgentBinding.principalUserId`. In a shared-channel presence run the PA's
  table tools follow the presence capability posture: the owner's private
  tables are part of the owner-private tier — absent or approval-routed, never
  readable on a stranger's word.
- **Unowned/system agents** (Librarian-tier `systemManaged` rows have no
  steward by CHECK): their tables carry `owner_user_id = null` and are
  workspace-visible; administrative actions on them are org-owner-gated.

### Visibility — derived from the agent, like everything else

`agent_tables.visibility ∈ {inherit, private, workspace}`, default `inherit`:

- **`inherit`** — the table's readers are exactly the people who can see the
  owning agent, computed **at read time through the existing predicates**
  (`buildAgentVisibilityWhere` + channel entitlement), never stored as a copy.
  A workspace agent's tables are visible to whoever reaches the agent; a
  private agent's tables resolve to owner-only automatically. This is the
  product rule from the task stated as one line of code reuse: *whoever can
  see the agent can see its data structures.*
- **`private`** — owner (steward) only, regardless of the agent's audience;
  forced for PA-created tables and for tables of `visibility=private` agents
  (a private agent must not mint workspace-visible artifacts — the same rule
  that makes `spawn_subtask` children inherit `private`).
- **`workspace`** — explicitly published to the org, even if the owning agent
  is later narrowed.

*Seeing* a table means it lists in `table_list`/`table_describe` and is
readable. **Writing is narrower by default**: the owning agent, its
`spawn_subtask` children, and the steward. Everything wider is a grant.

### Grants — widening is a grant, never a mutation

`agent_table_grants`: `(table_id, subject_type ∈ {organization, team, agent,
human}, subject_id, actions ⊆ {read, write, define}, granted_by actor,
created_at)` — append-only in spirit; revoke deletes the row (AgQL §3.7 rule
6: "who can see X" is always owner tuple + grant set, and revoking is deleting
a row, not un-mutating a label). Enforcement composes with the existing
`checkPolicy` engine as a new resource type (`agent_table`) so deny-overrides
and org policy administration keep working; the grant rows are the allow
bindings.

**Autonomy vs consent, made deterministic.** An agent may share on its own
exactly when the proposed audience is **a subset of the table's current
derived audience** (e.g. a workspace agent granting `write` on its own
workspace-visible table to another workspace agent — no new person can read
anything they couldn't already). Any *widening* — anything that lets a person
read who could not before (private → anyone; agent-inherit → workspace;
a grant to a specific human outside the audience) — is a **principal
decision** (AgQL: "sharing is a release action confirmed through the
principal channel; a model can propose publication; it cannot perform it"):
the tool call creates an `ApprovalRequest` addressed to the steward, and the
grant lands when the human approves. Since grants are data, "can the agent do
this alone?" is a pure set comparison, never a judgment call.

**Cross-team note.** Teams are grant *subjects*, not tenants: Nessie agents
are org-scoped entities reached by channel entitlement, so the isolation
boundary for tables is the organization, and a team grant scopes to that
team's members. This deliberately diverges from DeepCRM's compound org+team
tenant — see §Conflicts #3. Cross-*org* sharing does not exist here at all;
if it ever does, it is AgQL's cross-application published-dataset mechanism,
not a flag.

### Disclosure — table reads feed the sink

A table has an audience; a run that reads a table narrower than its
destination must not launder the contents into a wider room. So **every table
read feeds `ConsumedSourceSink` in the same change that ships it** (the
standing AGENTS.md obligation): the source scope is derived from the table's
effective audience (owner + grants), `computeReplyBasis` does the rest, and a
reply built on a private table into a shared channel gets withheld from
readers who don't satisfy the basis. Skipping this would make Agent Tables the
biggest disclosure hole in the product on day one; with it, tables inherit the
entire existing provenance discipline for free.

## Isolation, quotas, and staying-deterministic at scale

- **Tenant isolation**: `organization_id` on every table, in every PK/index
  prefix, resolved from the authenticated context; hash partitioning by org;
  composite tenancy FKs for stewards. There is no query shape that can cross
  it — the grammar has no cross-table form and the compiler injects the
  prefix, not the caller.
- **Quotas (defaults, deployment-tunable, enforced before work)**: 100 tables
  per agent · 500 per org baseline; 64 columns (8 indexed, 4 unique) per
  table; 100k rows per table; per-row value caps (8 KiB text, 256 KiB row);
  org byte budget accounted through storage-usage events against
  `Budget.storageLimitBytes` (the FileService accounting pattern applied to
  row bytes — local ops telemetry on `/ops/usage`, **never** UOA credits; UOA
  stays the sole commercial authority).
- **Runaway protection**: mandatory `take`; scan thresholds + cost refusals
  with remedies; statement timeouts; per-run tool budgets already cap call
  volume; scratch TTL (default 14 days, extendable within quota) with a
  reaper job so abandoned experiments cannot silt up the fleet (AgQL's
  lifecycle rule); idempotency keys make retried turns write-once.
- **MCP-native determinism**: the tool input schemas *are* the language
  schemas; validation is portable pure code; same invalid input, same error,
  every time; anchored time; canonical ordering; no clock or randomness in
  compilation. When these tools are later also exposed to external MCP
  clients (a family product reading a shared table), the same service
  functions back a stateless MCP surface, DeepCRM-style — nothing about the
  contract assumes the Nessie worker.

## Humans: Rule zero surfaces

A capability is not done until a person can reach it:

- **Agent detail → "Tables" tab** (the owning surface): the agent's tables
  with description, row count, size, durability, visibility, grants; a capped
  row browser (read-only, entitlement-gated by the same predicates the tools
  use — one predicate, never two); grant management + approval surfacing for
  widening requests; drop/archive.
- **In-context doorway**: when a run's reply used a table, the existing
  basis/source affordances name it; `table_export` artifacts land as ordinary
  KB attachments people already know how to open.
- **Ops**: `/ops/usage` gains table-storage lines (org/agent/table bytes and
  counts) beside file storage — owner-only telemetry, never beside customer
  billing.

## Boundaries — what Agent Tables is *not*

- **Not memory.** Thoughts/memory stay the unstructured, semantically-recalled
  substrate; tables are typed rows queried deterministically. The line for
  agents (stated in tool descriptions): *remember* impressions, *tabulate*
  facts you'll filter, count, or share. The memory stack's own AgQL future is
  the rollout's Phase 3 and independent of this feature.
- **Not a CRM.** If the shape is customers/deals/activities with dedup,
  pipelines, and merge — that's DeepCRM, one MCP connector away, with a real
  domain engine. Agent Tables is for everything that isn't anyone's domain
  product: trackers, research tables, checklists-with-data, small reference
  sets.
- **Not a warehouse.** Row caps and refusals-with-remedy say so explicitly.
- **Not a second knowledge base.** Documents and files stay in KB; a table
  export is a KB file.

## Conflicts between the three designs, and resolutions

1. **Query language: AgQL IR vs DeepCRM's bespoke filter grammar vs nothing
   yet shipped.** DeepCRM consciously built a small one-off filter JSON;
   AgQL's whole thesis is that every such one-off is the fragmentation to
   end. **Resolved for AgQL**: Agent Tables speaks the AgQL v0 subset shape
   from day one, implemented natively. DeepCRM predates this decision and
   stays as-is; if it ever converges, that is a DeepCRM decision.
2. **Timing: AgQL rollout puts Nessie at Phase 3, after Remember Ninja proves
   the engine.** Building agent tables now, natively, neither waits for nor
   forks the runtime: the contract shape is adopted, the engine is
   deliberately swappable (compiler behind a service seam, physical layout
   invisible to agents), and when the AgQL runtime exists, Agent Tables
   becomes its most natural Nessie on-ramp — a catalog + Postgres binding —
   rather than a migration. Flagged in [AgQL rollout](../../../AgQL/docs/rollout.md).
3. **Tenancy: DeepCRM's tenant is compound (org, team); Nessie agents are
   org-scoped with channel entitlement, and `Agent.teamId` is explicitly
   ambient context, not an entitlement source.** A table pinned to a team its
   owning agent isn't entitled through would be unreachable — the exact
   Rule-zero defect. **Resolved for the Nessie model**: org is the isolation
   boundary; team is a grant subject. If per-workspace agent scoping ever
   lands (the scopes doc's deferred third enum value), tables follow the
   agent automatically via `inherit`.
4. **History: DeepCRM logs every field change and offers bitemporal reads;
   AgQL scratch datasets are cheap and TTL'd.** Both, by tier: durable tables
   get the change log (audit + future `row_history`), scratch tables get
   none. Promotion starts logging from that moment; pre-promotion history is
   honestly absent rather than fabricated.
5. **Type system: DeepCRM's 20 CRM types (email, phone, domain,
   personal_name, json escape hatch, is_multi) vs AgQL's closed exact kinds.**
   **Resolved for AgQL's kinds**: the CRM types are domain normalisers that
   belong to the CRM, `float` and free `json` break determinism and
   indexing, and multi-valued columns drag in fan-out semantics AgQL v0
   deliberately excludes. The cost — no arrays, no blobs — is the "simple"
   in simple tables, and each exclusion has a named workaround (a second
   table + `reference`, text serialisation, or DeepCRM).
6. **Relationships: DeepCRM has first-class edges with attributes; AgQL v0
   has no joins at all.** **Resolved for AgQL v0**: `reference(table)`
   columns with read-entitlement-checked targets, single-table queries,
   dereference by a second query. The expressiveness cliff is real
   (AgQL §5.3 names it); if real usage demands joins, they arrive as AgQL's
   own later bounded join edition, not as a local invention.
7. **Sharing consent: AgQL requires principal confirmation for widening;
   Nessie agents are autonomous employees expected to act.** **Resolved as a
   set rule**: audience-subset shares are autonomous, widenings are
   steward-approved via `ApprovalRequest`. Deterministic, no judgment calls,
   both briefs satisfied.
8. **Where results go: AgQL's two-channel model (model preview vs principal
   result) assumes a conforming host; Nessie tool results go straight into
   run context.** **Resolved pragmatically**: capped previews in the model
   channel + export-by-reference through FileService deliver the
   data-moves-by-reference property; the full principal-channel/receipt
   architecture waits for the real runtime. This is an honest subset, not a
   claim of host conformance.

## New vs reused

| Need | New | Reused |
|---|---|---|
| Logical tables at scale | `agent_tables` / `agent_table_columns` / partitioned `agent_table_rows` / pivot `agent_table_index_entries` / `agent_table_unique_keys` / `agent_table_changes` + engine package | DeepCRM storage shapes (JSONB current state, unique-key table, change log, write-path invariants); Salesforce pivot-index precedent; Nessie Postgres + migrations discipline |
| Query/write contract | the v0-subset compiler + validators | AgQL kinds, query modes, operators, limits, receipts, ingest modes, error style, anchored time — adopted, not invented |
| Ownership & visibility | `owner_agent_id`/`owner_user_id`/`visibility` on tables; PA effective-user stamping | `Agent.ownerUserId` stewardship, `Agent.visibility`, `buildAgentVisibilityWhere`, entitlement predicates, presence/`effectiveUserId` machinery |
| Sharing | `agent_table_grants` + audience-subset autonomy rule | `checkPolicy` engine (new resource type), `ApprovalRequest`, audit log |
| Safety at scale | quotas, row caps, scan thresholds, TTL reaper, cost refusals | Budget + usage-event accounting, worker queue jobs, idempotency-replay pattern, run tool budgets |
| Disclosure | table-source scope derivation | `ConsumedSourceSink` / `computeReplyBasis` / basis stamping — unchanged machinery, new feeder |
| Human surface | Agent detail Tables tab + row browser | existing agent detail scaffolding, TabBar, Dialog, `/ops/usage` |
| Export | `table_export` | `FileService` chokepoint + KB attachments |
| Future search | per-table EmbeddingSpec-style config | Nessie embedding pipeline (`EMBEDDING_DIMENSIONS`, Ledger routing), AgQL receipt states |

## Phased path

1. **Core engine + tools** — metadata tables, partitioned row store, pivot
   indexes, unique keys, write path with receipts + idempotency;
   `table_create/list/describe/put/query(records, aggregate)/delete_rows/drop`;
   `inherit`/`private` visibility; scratch TTL + reaper; quotas; disclosure-
   sink wiring; Tables tab (read-only). *This alone delivers the product
   sentence: every agent can design and use simple databases.*
2. **Sharing + evolution** — grants + audience-subset rule + widening
   approvals; `table_alter` with backfill jobs; `table_promote`; change log on
   durable tables; `table_export`; row browser + grant management UI; ops
   usage lines.
3. **Search + scale hardening** — opt-in semantic/lexical search over text
   columns (embedding states in receipts, `retrieve` mode); promotion to
   `dedicated` placement for outlier tables; cross-product read surface
   (stateless MCP exposure of the same services) if a family product needs it.
4. **AgQL convergence** — when the AgQL runtime ships (rollout Phases 0–2
   proven), re-base the engine as an AgQL catalog + adapter; agent-facing
   tools keep their shapes; stored queries and prompts survive verbatim.

## Open questions

1. **Default durability** — `scratch` (safe, self-cleaning, but agents may
   lose tables they meant to keep) vs `durable` (no surprises, but silt).
   Proposed: scratch by default with the TTL stated in the create result and
   a nudge to promote; revisit after real usage.
2. **Who may create** — every agent by default (proposed), or
   tool-policy-gated per agent like granted integrations? Default-on matches
   "base capability like memory"; a deployment can still gate.
3. **Steward deactivation** — private tables of a deactivated owner should
   follow the private-agent rule (pause/park, existence-only admin view)
   rather than the workspace rule. Adopt the scopes doc's carve-out verbatim?
4. **Approval ergonomics** — widening approvals land as `ApprovalRequest`;
   is the steward's PA DM the right delivery surface (mirroring elevation
   alerts), or the channel where the share was proposed?
5. **Row-cap defaults** — 100k default / 1M org max are guesses; validate
   against the first real workloads before hardening refuse-with-remedy copy.
6. **Change-log retention** — `agent_table_changes` never deleted by product
   code (audit-grade, DeepCRM's stance) vs retention-windowed (it is not the
   org `AuditLog`)? Proposed: retention-windowed with the org audit log
   keeping the coarse events.
7. **Shared engine extraction** — once Agent Tables and DeepCRM both run,
   extract a shared schema-engine package (the `@deep/mcp-inbound` question
   again) or let the two implementations drift deliberately? Defer until the
   second implementation hurts.
8. **Naming** — "Tables" is the working name (`table_*` tools). "Datasets"
   matches AgQL vocabulary but reads as analytics; "Tables" matches the
   SQLite-style mental model in the product idea. Pick before tool names ship,
   since renaming tools breaks prompts.
