# Live Data Dashboards

> **Status:** agreed design, not yet in delivery — **revision 1**
> **Date:** 2026-08-13
> **Provenance:** three independent designs (Fable, Kimix, Codex Sol) against one
> shared brief, merged here. §15 records every place they disagreed and which
> answer won. §16 lists what still needs the owner's call.
> **Routes:** `/dashboards`, `/dashboards/:dashboardId`

---

## 0. The one-paragraph version

A dashboard is a typed, versioned, entitlement-scoped workspace object holding
widgets on a grid, fed by declared external JSON sources. Agents build them the
same way a person does by clicking — by choosing from a closed catalogue of
renderer-owned component kinds and binding declared fields to slots. They never
emit markup, styling, URLs, actions, formatter code, or chart-library
configuration; the boundary is structural, not filtered. A widget is one object
with three homes — the canvas, a message, a knowledge page — rendered by one
component parameterised by surface, and embedded everywhere as a *reference*
(live) or a frozen immutable *snapshot* (static), never as copied data. External
responses become a bounded normalized table through the JMESPath evaluator
Nessie already has, fetched once per source through `safeFetch` under a
deliberate, visible, audited source authority, and served to every viewer from
one cache. Access is resolved live at every read by one function; embedding
grants nothing. Versions are append-only, attribute agent edits to the run that
made them, and restore by appending.

---

## 1. Why this section exists, and where the line is

Nessie already refused charts once, deliberately. The project overview is "a
router, not a report — no hero numbers, no timeline, no charts"
([2026-08-11-project-dashboard.md](./2026-08-11-project-dashboard.md)). That
doctrine holds, and this plan does not weaken it.

The distinction is **purpose, not data**:

- The **project overview** answers "where do I go next?" Every element is a
  doorway. A chart there is decoration, because you cannot click a trend line to
  get to your work.
- A **dashboard** is an instrument panel someone deliberately authored because
  monitoring, comparison, or measurement *is* the task. The question it answers
  is "what is the state of this thing?", and a number over time is the honest
  answer to that question.

So: the overview gains **one router row per pinned dashboard** — `Revenue watch ·
2 stale · updated 4m →` — a link, never a chart. `/projects/:projectId/insights`
becomes the project's dashboard doorway, rendering the same scope-parameterised
index component as `/dashboards`, not a second implementation.

---

## 2. Object model

All tables carry `organizationId` as a required FK and are queried with it —
never a bare `findUnique` on a caller-supplied id (§11.6).

```prisma
enum DashboardHome        { organization project team channel personal }
enum DashboardAuthorType  { user agent }
enum DashboardSourceKind  { http }          // in-process adapters are a later kind
enum DashboardRefreshMode { manual interval }
enum DashboardGrantLevel  { view edit }
enum DashboardAccessMode  { delegated viewer }   // viewer reserved for internal adapters

model Dashboard {
  id             String  @id @default(uuid()) @db.Uuid
  organizationId String  @map("organization_id") @db.Uuid
  home           DashboardHome
  projectId      String? @map("project_id") @db.Uuid   // exactly one of these is set,
  teamId         String? @map("team_id")    @db.Uuid   // matching `home`; enforced by a
  channelId      String? @map("channel_id") @db.Uuid   // check constraint, not convention
  ownerUserId    String? @map("owner_user_id") @db.Uuid

  title          String
  description    String?
  layout         Json     // per-breakpoint rects, see §5
  revision       Int      @default(1)   // optimistic concurrency
  createdByType  DashboardAuthorType @map("created_by_type")
  createdBy      String   @map("created_by")
  archivedAt     DateTime? @map("archived_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
}

model DashboardWidget {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid   // denormalized; every query uses it
  dashboardId    String @map("dashboard_id") @db.Uuid
  kind           String                                     // closed enum, §3
  schemaVersion  Int    @default(1) @map("schema_version")
  spec           Json                                       // validated WidgetDefinitionV1
  sourceId       String @map("source_id") @db.Uuid
  binding        Json                                       // field → slot map, validated against source schema
  lockedAt       DateTime? @map("locked_at")                // "agents can't change this widget"
  @@index([organizationId, dashboardId])
}

model DashboardDataSource {
  id              String @id @default(uuid()) @db.Uuid
  organizationId  String @map("organization_id") @db.Uuid
  name            String
  kind            DashboardSourceKind @default(http)
  origin          String                       // immutable once a credential is attached
  path            String                       // stored separately from origin
  queryParams     Json?                        // strict literals + closed relative-time tokens
  credentialRef   String? @map("credential_ref")   // server-minted secret_dashboard_*; never read back
  credentialMode  String?                      // 'bearer' | 'header'
  credentialHeader String? @map("credential_header")
  authorityUserId String  @map("authority_user_id") @db.Uuid  // whose access refreshes this
  accessMode      DashboardAccessMode @default(delegated)
  transform       String                       // JMESPath, compiled at write, ≤4 KiB
  outputColumns   Json                         // declared [{ key, label, type, nullable }], ≤32
  refreshMode     DashboardRefreshMode @default(manual)
  intervalMinutes Int?                         // closed preset: 5 | 15 | 60 | 360 | 1440
  latestSnapshotId String? @map("latest_snapshot_id") @db.Uuid
  lastAttemptAt   DateTime? @map("last_attempt_at")
  lastValidatedAt DateTime? @map("last_validated_at")
  lastErrorCode   String?   @map("last_error_code")   // stable code, never a message
  etag            String?
  archivedAt      DateTime? @map("archived_at")
  @@unique([organizationId, name])
}

// Immutable normalized dataset. Bytes live in FileService (§11.7).
model DashboardDataset {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  sourceId       String   @map("source_id") @db.Uuid
  attachmentId   String   @map("attachment_id") @db.Uuid   // canonical JSON envelope blob
  schemaVersion  Int      @map("schema_version")
  rowCount       Int      @map("row_count")
  byteSize       Int      @map("byte_size")
  fetchedAt      DateTime @map("fetched_at")
  @@index([organizationId, sourceId, fetchedAt(sort: Desc)])
}

// A frozen point in time: spec + binding + dataset, pinned together.
model DashboardWidgetSnapshot {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  widgetId       String @map("widget_id") @db.Uuid
  kind           String
  schemaVersion  Int    @map("schema_version")
  spec           Json                                  // frozen copy — widget deletion cannot orphan it
  binding        Json
  datasetId      String @map("dataset_id") @db.Uuid    // FK protects the blob from GC
  takenByType    DashboardAuthorType @map("taken_by_type")
  takenById      String @map("taken_by_id")
  authorityNote  String? @map("authority_note")        // "captured under Alice's API access"
  createdAt      DateTime @default(now()) @map("created_at")
}

model DashboardVersion {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  dashboardId    String @map("dashboard_id") @db.Uuid
  versionNumber  Int    @map("version_number")
  layout         Json
  widgets        Json                                  // frozen validated specs, not joins
  authorType     DashboardAuthorType @map("author_type")
  authorId       String @map("author_id")
  runId          String? @map("run_id") @db.Uuid       // the run that made the change
  summary        String                                // deterministic sentence, §8
  createdAt      DateTime @default(now()) @map("created_at")
  @@unique([dashboardId, versionNumber])
}

model DashboardGrant {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  resourceType   String                                // 'dashboard' | 'widget' | 'widget_snapshot'
  resourceId     String @map("resource_id") @db.Uuid
  subjectType    String                                // 'user' | 'agent' | 'channel' | 'team' | 'project' | 'knowledge_space'
  subjectId      String @map("subject_id") @db.Uuid
  level          DashboardGrantLevel
  createdBy      String @map("created_by")
  expiresAt      DateTime? @map("expires_at")
  revokedAt      DateTime? @map("revoked_at")
  @@unique([resourceType, resourceId, subjectType, subjectId])
}

// Where an embed physically sits. Grants nothing by itself.
model DashboardEmbedPlacement {
  id                     String @id @default(uuid()) @db.Uuid
  organizationId         String @map("organization_id") @db.Uuid
  mode                   String                        // 'live' | 'static'
  widgetId               String? @map("widget_id") @db.Uuid
  widgetSnapshotId       String? @map("widget_snapshot_id") @db.Uuid
  targetType             String                        // 'message' | 'knowledge_page_version'
  targetId               String @map("target_id") @db.Uuid
  createdBy              String @map("created_by")
  createdAt              DateTime @default(now()) @map("created_at")
}
```

**Home.** A dashboard has exactly one home — organization, project, team,
channel, or personal — which supplies its default audience and management chain.
`GET /api/dashboards` returns everything the actor may read **across the
organization**, with project/team/channel/personal as *explicit filters the
caller asks for*. It never silently narrows to the session's project or team
(Rule zero §2 — the exact mistake that once hid people's own documents).

**One widget, three homes.** `DashboardWidget` is the only live widget and always
belongs to a dashboard, which supplies its lifecycle, source, history, and
management surface. "Standalone" means *independently referenced*, never copied.
One renderer — `DashboardWidgetCard` with `surface: 'dashboard' | 'message' |
'knowledge'` and `mode: 'live' | 'static'` — is used on all three, parameterised
and never forked (Rule zero §4). Layout is not part of an embed; the host
supplies a bounded card size.

---

## 3. The widget contract — the "no arbitrary code" boundary

The contract is closed **structurally**, not by sanitising. The browser receives
a server-produced `DashboardWidgetProjectionV1` — never the agent's original tool
arguments, never a render tree.

### 3.1 The catalogue — five kinds

| kind | The question only it answers |
|---|---|
| `stat` | What is the number now, and is it moving the right way? |
| `timeseries` | How has it moved over time? (line/area, ≤12 series) |
| `bar` | How does it split or rank across categories? (vertical/horizontal, grouped/stacked) |
| `table` | What are the actual records? (typed columns, one default sort) |
| `status` | Is the thing ok / warning / failing / unknown — since when? |

**Cut by name, with reasons:** pie and donut (a sorted bar answers the only
question a pie pretends to); gauge and progress ring (a `stat` with a target bar
uses less ink); area-as-its-own-kind (a `timeseries` preset); scatter, heatmap,
pivot, funnel, map (real but rare — v2 candidates when someone asks *with data in
hand*); **markdown/text widget, image, iframe, and "custom"** (the thin end of
the freeform wedge this entire boundary exists to prevent — the dashboard
description and each widget's own caption slot carry prose).

**Extension path:** a new kind needs a product question the five cannot answer,
plus a new discriminant in the shared schema, a renderer taking only normalized
props, accessibility and cap tests, diff support, compact message/knowledge
rendering, export behaviour, and a dual-reader migration plan. There is no plugin
registry and no JSON pass-through to the chart library — ever.

### 3.2 The authored schema

`WidgetDefinitionV1` in `packages/schemas/src/dashboards.ts` — a discriminated,
`.strict()` Zod union. Unknown keys are **errors**, not ignored extension points.
Every bound field name must exist in the source's declared output columns.

```ts
type PresentationV1 = {
  style: 'standard' | 'compact' | 'emphasis'
  title: string                  // 1..120 code points
  subtitle?: string              // 0..180
  detail?: string                // 0..240
  caption?: string               // 0..240
  status?: { label: string; tone: 'neutral'|'info'|'success'|'warning'|'danger' }
  legend: 'hidden' | 'bottom' | 'right'
  density: 'cozy' | 'compact'
  tone: 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral'
}

type NumberFormatV1 = {
  kind: 'number' | 'compact_number' | 'percent' | 'currency' | 'duration' | 'bytes'
  precision?: 0|1|2|3|4|5|6
  currency?: string              // ISO 4217, exactly three ASCII letters
  unit?: string                  // short literal, ≤8 code points
}
```

Three worked examples:

```jsonc
// timeseries
{ "kind": "timeseries", "schemaVersion": 1,
  "presentation": { "style": "standard", "title": "Requests per day",
                    "subtitle": "status.example.com", "legend": "bottom",
                    "density": "cozy", "tone": "accent" },
  "binding": { "sourceId": "9f3d…", "x": "observed_at",
               "series": [ { "key": "successful", "label": "Succeeded" },
                           { "key": "failed",     "label": "Failed" } ] },
  "format": { "kind": "compact_number" },
  "options": { "curve": "linear", "stacked": false } }

// table
{ "kind": "table", "schemaVersion": 1,
  "presentation": { "style": "compact", "title": "Open incidents",
                    "legend": "hidden", "density": "compact", "tone": "warning" },
  "binding": { "sourceId": "…", "columns": [
      { "key": "id",        "label": "ID",       "format": { "kind": "number" } },
      { "key": "severity",  "label": "Severity" },
      { "key": "age_hours", "label": "Age", "format": { "kind": "duration", "unit": "h" } } ],
    "sort": { "key": "age_hours", "direction": "desc" }, "maxRows": 50 } }

// stat
{ "kind": "stat", "schemaVersion": 1,
  "presentation": { "style": "emphasis", "title": "MRR", "legend": "hidden",
                    "density": "cozy", "tone": "success" },
  "binding": { "sourceId": "…", "value": "mrr", "compareTo": "mrr_previous",
               "higherIsBetter": true, "spark": "mrr_series" },
  "format": { "kind": "currency", "currency": "GBP", "precision": 0 } }
```

And one that must be **rejected**, with the three separate reasons:

```jsonc
{ "kind": "timeseries",
  "binding": { "sourceId": "…", "x": "t",
               "series": [ { "key": "v", "formatJs": "d => d * 2" } ] },
  "presentation": { "title": "Revenue", "titleColor": "#ff0000" },
  "actions": [ { "label": "go", "href": "javascript:fetch('/api/admin')" } ] }
```

1. `formatJs` — unknown key, `.strict()` rejects. There is no code slot anywhere
   in the contract, so there is nothing to sanitise.
2. `titleColor` — unknown key. Colour never crosses the boundary; `tone` is an
   enum mapped to existing CSS custom properties by the renderer.
3. `actions` — **the contract has no actions field at all.** With no `href`,
   `src`, action, event, or drill-down slot in the schema, `javascript:`,
   `data:`, tracking pixels, and navigable cells cannot arise. Strings that
   happen to look like URLs stay text.

### 3.3 Where the boundary is enforced

- **Write time** — precise author-facing error before unsafe state is stored;
  entitlement and caps checked atomically.
- **Read time** — the database, an old schema version, a restored document, a
  blob, and client/server skew are all treated as untrusted. A persisted widget
  no current reader can validate renders an inert `unsupported_widget` panel
  carrying only server-authored copy and the widget id; its source refresh is
  paused and owners get a diagnostic event with the validation path but **no
  values**. The system never guesses a fallback mapping.
- **Client** — the admin parses the server projection a third time as a
  resilience boundary. Server authorization stays authoritative.

This mirrors the habit `MessageUiCards.tsx` already has (zod `safeParse` at
render, drop on invalid) — made explicit and given a named inert state instead of
silently vanishing.

### 3.4 States

`DashboardWidgetFrame` owns seven states on every surface: `loading` (fixed
skeleton, no outbound request caused by rendering), `empty` ("No data returned" —
a success, not an error), `fresh`, `stale`, `error with prior data`, `error
without prior data`, `denied`, plus `unsupported`.

Every widget carries a **non-removable freshness footer**: `● Live · 2m ago` /
`● Stale · updated yesterday 17:40 ↻` / `📌 Snapshot · 12 Aug 14:02`. Staleness
desaturates the plot (never the numbers) and names its age, so a day-old widget
*shows its data* and *confesses its age* in one glance. Errors are an inline
strip, never a red border round the whole card — a wall of red cards during an
outage is noise. `denied` is a lock tile with no data, no error body, and no
source URL. Scheduled sources go stale at 2× interval (clamped 15 min–48 h);
manual sources at 24 h.

Formatting is `Intl.NumberFormat` / `Intl.DateTimeFormat` at the viewer's locale
and timezone. Percent uses the fractional convention (`0.0123` → `1.23%`). Null
renders as an em dash and is omitted from plotted series — **never coerced to
zero**. Non-finite numbers, invalid datetimes, and mixed column types fail
dataset validation rather than becoming chart values.

---

## 4. Data sources, transform, and liveness

### 4.1 Binding an API — four declared steps

Same four steps whether a person clicks a wizard or an agent calls the shared
commands:

1. **Declare endpoint** — HTTPS origin + path, GET only at v1. Query params are a
   strict object of bounded literals or a closed relative-time token
   (`{"relativeTime": "now_minus_24h"}`). No templating exists.
2. **Attach credential** *(optional)* — bearer or named header, supplied once
   through a dedicated route, minted to a `secret_dashboard_*` ref. Write-only:
   whoever attaches it, including an agent, can never read it back (§11.4).
3. **Select rows** — a JMESPath expression turning the JSON body into an array of
   records.
4. **Declare output columns** — ≤32 columns of `{ key, label, type, nullable }`
   where type is `string | number | boolean | datetime`. Rows carrying undeclared
   keys, wrong types, or missing non-nullable fields **fail the refresh**; they
   are not persisted "just in case".

### 4.2 The transform is JMESPath — reused, never rebuilt

Nessie already owns exactly the right tool:
[`packages/workspace-admin/src/workflow-jmespath.ts`](../../packages/workspace-admin/src/workflow-jmespath.ts)
— "the single JMESPath evaluator", with a stated envelope of 4 KiB expression /
1 MiB serialized input / 256 KiB output, evaluated in a `worker_thread`
terminated on a 1 s deadline, deterministic with no I/O, clock, or randomness,
compiled at save time and evaluated with the same grammar, and already previewed
in the admin with *the same jmespath.js* via
`admin/src/lib/workflow-designer/jmespath-preview.ts`.

**Dashboards must not add a second evaluator.** The work is to relocate it behind
a domain-neutral export (it currently reads as workflow-owned) and consume it —
AGENTS.md's "pause, plan a refactor, execute it, then reuse". The admin's
existing preview component gives source authors a live green/red transform
preview for free.

The pipeline is therefore exactly: **HTTP response → size-capped, JSON-only,
content-type-pinned body → JMESPath → declared-column validation → canonical
envelope.** There is no other transformation language, and the raw response is
discarded after normalization.

```json
{ "schemaVersion": 1,
  "columns": [ { "key": "observed_at", "type": "datetime", "nullable": false },
               { "key": "successful",  "type": "number",   "nullable": false } ],
  "rows": [ { "observed_at": "2026-08-13T12:00:00.000Z", "successful": 1842 } ] }
```

**Caps:** 2,000 rows · 32 columns · 512 code points per string · 2,000 plotted
points · 12 series · 256 KiB canonical dataset. A table binds ≤500 rows and pages
50 client-side; compact message/knowledge surfaces show ≤50 rows or points with a
link to the dashboard for entitled viewers.

### 4.3 Live vs static

- **Live embed** = a reference to `DashboardWidget.id`. Each authorized read
  resolves the current spec, binding, and the source's current dataset. An edit
  or a successful refresh changes what it shows.
- **Static embed** = a reference to a `DashboardWidgetSnapshot`, created by an
  explicit **Freeze snapshot** command. One transaction verifies access, copies
  the validated spec and binding, pins the exact dataset, records who captured it
  and under whose authority, and creates the placement. It never fetches and
  never follows later edits.

Snapshot **is the default** when posting into a conversation: a posted widget is
usually a quotation of a moment, and a quotation should not silently change under
the reader. Live is one click away and warns about audience reach before posting.

Dataset bytes are immutable JSON blobs stored through the one `@nessie/runtime`
`FileService`, so they create their `Attachment` + `StorageUsageEvent` and consume
`Budget.storageLimitBytes` like every other blob. They are never exposed through a
generic attachment URL — only the authorized snapshot resolver streams them, and
it re-validates the schema on the way out. Stored uncompressed: it makes quota
accounting equal the bytes that will be parsed and closes decompression ambiguity.

**Two-year readability** is the test a snapshot has to pass. It holds because the
frozen spec and dataset both carry `schemaVersion` and every historical version
keeps an explicit reader through the retention window, and because a snapshot
depends on nothing external — not the API, not the credential (deleting it has no
effect on frozen bytes), not the live widget.

### 4.4 Refresh — one cache, one scheduler

**Viewing a dashboard never fetches its API.** One source has one cache serving
all viewers, so N viewers cause 0 additional fetches. Refresh comes only from a
rate-limited manual action by a source manager, a preset schedule
(manual / 5 min / 15 min / 1 h / 6 h / 24 h), or a stale-while-revalidate enqueue
on authorized read when the source is already stale and nothing is queued.

Scheduling reuses the **existing trigger scheduler and queue** with a new target
kind that enqueues `dashboard.source.refresh` — no second scheduler, and no
`AgentTrigger` row, so refreshing a chart never creates an agent run or spends a
token. The worker calls the same `refreshDashboardDataSource` the API preview
calls, differing only by a `persist` option. A uniqueness rule permits one queued
or running attempt per source. Conditional GET uses stored ETag / Last-Modified;
a 304 advances `lastValidatedAt` without writing another blob. Failures back off
exponentially to six hours while preserving the requested cadence on next success.

Per-org defaults, all `NESSIE_DASHBOARD_*` backstops that agents cannot relax:
200 sources, 20 per dashboard, 50 widgets per dashboard, 4 concurrent refreshes
per org, 2 per origin, 32 process-wide, 60 refresh starts per org per minute, 10
manual refreshes per user per minute, 5-minute minimum interval.

### 4.5 Internal Nessie data — out of scope at v1, and why

Treating Nessie's own REST API as "just another endpoint" creates privilege
confusion: a delegated token could surface owner-only runs, ledger, messages, or
audit data through a broadly shared dashboard. So dashboard fetches **explicitly
deny the configured Nessie API/admin origins** on top of normal private-network
rejection, and forward no cookies or session headers.

When internal data does arrive it will be **named in-process adapters** —
`project_task_summary_v1` — calling the same domain function as the owning UI,
running `accessMode: viewer` against the live viewer's entitlement, with an
approved schema and redaction at the adapter boundary. Never SQL, never GraphQL,
never a loopback HTTP request, never a generic "Nessie table" or report builder.

---

## 5. The canvas

**Grid.** 12 columns ≥1200px, 8 at 768–1199, 4 below 768. 32px row unit, 12px
gutter. Each kind declares min/max sizes (stat 3×3, status 3×2, timeseries 4×5,
bar 4×5, table 6×5). Layouts are stored **per breakpoint**; adding a widget
derives the smaller layouts once, deterministically, after which they are
editable — responsive reflow that guesses is responsive reflow that is wrong.
Packing is vertical, overlap forbidden, moves compact in stable `(y, x, widgetId)`
order. Snapping is always on; there is no free placement, which is half of what
keeps agent output and human output visually identical.

**Libraries.** `react-grid-layout` 2.2.4 (MIT) for packing, drag, and resize —
`@dnd-kit` is already in the repo but supplies neither grid packing nor resizing,
and stretching it here means owning a collision engine. `recharts` 3.10.1 (MIT)
for line and bar: it renders **SVG**, and SVG presentation attributes accept
`var(--token)` directly, so charts follow a live theme switch with zero JS —
which no canvas renderer (Chart.js, ECharts, uPlot) can do without
`getComputedStyle` snapshots that go stale per `[data-theme]`. Both verified
React 19 compatible (RGL peer `>=16.3.0`; Recharts lists `^19.0.0` explicitly).
Tables are a plain `<table>`, not TanStack.

Both are quarantined: `DashboardGrid` is the only file importing the grid and it
loads **only in edit mode**; `DashboardChart` is lazy and accepts only
server-validated arrays and renderer-owned props — never user config, custom SVG,
or formatter callbacks. The chart chunk is absent from the dashboard list and
from stat/table-only routes. Bundle budgets are verified in CI before adoption.

**Screens.** `/dashboards` is the library: search, scope chips only when the
person picks them, and rows that answer a choice — title, home, freshness ("All
fresh" / "2 stale" / "Unavailable"), updated, creator. No request counts, no
storage bytes, no decorative metrics (Rule zero §3).

`/dashboards/:id` is view mode by default and chrome-free. Edit mode adds a
dotted grid and a toolbar; selecting a widget opens the right-hand pane —
drag-resized and width-persisted exactly like the reply-thread panel — which has
**one implementation and three tenants**: Inspector (Data tab: source picker then
slot-filler; Style tab: the three segmented controls plus the agent Lock),
Sources, and Versions. `+ Add widget` shows the five kinds as miniature live
examples captioned by their question ("Stat — *what is the number now?*").

**Keyboard and mobile.** Drag handles are focusable; arrows move by a cell,
`Shift`+arrows resize, with ARIA live announcements. Below 768px widgets are a
single stack in an explicit editable reading order; direct drag and corner resize
are off because they fight scrolling, replaced by "Move up / Move down" and size
presets in each card's menu. Editing on a phone is deliberately unsupported at
v1. Print uses a stylesheet; freshness footers become "as printed 13 Aug 09:12".
CSV per widget at v1; PNG deferred.

**Empty state.** The first line is *"Ask your assistant to build one"* with a
prefilled PA composer, above "or start with a blank canvas". The agent path is
the front door, not an afterthought.

---

## 6. Agents and people editing together

Agents edit **live**, through the same atomic operations a click produces — no
draft-and-approve gate, because versions are the safety net and approval friction
on a reversible visual change buys nothing. While a run is editing: a presence
pill in the header, per-widget touch marks, and **Stop** wired to the existing
run-cancel path. Per-widget **Lock** ("agents can't change this widget") is
enforced server-side, not by asking the model nicely.

Every agent run that changes a dashboard closes with one auto-version attributed
to the agent and carrying `runId`, so recovery from a bad build is one Restore.

### 6.1 The capability is a tool bundle, not an agent

**Decided 2026-08-13.** Dashboards are a *grantable tool bundle* in the ordinary
tool registry — **not** `personalAssistantOnly`, and not welded to one bespoke
agent. Nessie additionally ships one fixed stock dashboards agent so the
capability has an owner out of the box, but that agent is only a preset
definition holding the same tools any other agent can hold. Three consumers, one
implementation:

- the **Personal Assistant**, which already provisions workspaces;
- the shipped **stock dashboards agent**;
- any **user-designed agent** built in Agent Designer and granted the bundle.

Tools follow the standing rule — *a tool that does what a person does by clicking
calls the same function that person's button calls and mirrors that route's
authorization exactly* — with the shared functions in a new `@nessie/dashboard`
package consumed by both the API routes and the worker, never a second copy in
`pa-tools`. Because the tools take ids, the reads that resolve them ship with
them (`dashboard_list`, `dashboard_source_list`), or an agent can only act on
what it created in the same conversation.

Owner-gated actions stay **visible** to non-owners and refuse in words (the
`connector_*` precedent), and role is re-read from the live `OrganizationMember`
row at call time, never from the run's enqueue-time snapshot.

### 6.2 The agent sees the data, because it cannot choose a component otherwise

**Decided 2026-08-13.** Picking `timeseries` over `table`, and binding the right
field to the right slot, is impossible without seeing the shape and a sample of
the values. So `dashboard_source_probe` returns the **bounded normalized preview**
— declared columns plus a capped sample of rows — to the calling agent as part of
source creation and widget binding.

This pulls the untrusted-data framing of §11.2 forward into **Stage 1**: the
moment an agent can see external values is the moment indirect prompt injection
becomes reachable, so the Nessie-authored delimiter block, the escaping, and the
length bounds ship with the probe, not later with `dashboard_widget_read`.
Sample rows are capped harder than a render (≤20 rows, ≤8 columns shown) because
the agent needs the *shape*, not the dataset.

### 6.3 Full post-hoc editing, layout included

**Decided 2026-08-13.** "Move that one over there" is a normal instruction, so
the bundle is not create-only. Agents get the complete edit surface: add, remove,
rebind, restyle, retitle, **move, and resize**, plus source edits — every
operation the inspector and the canvas expose, over the same atomic ops a click
produces. Layout is agent-writable, snapped to the same grid, so an agent cannot
produce a layout a person could not have made by dragging.

### 6.4 The two limits that remain

Agents **cannot read a credential** (§11.4 — they may set one, never retrieve,
copy, or move one) and **cannot widen an audience**. An agent asked to post a
widget where the audience lacks access returns `DASHBOARD_SHARE_REQUIRED` for a
human to action; it never silently publishes data into a wider room. Since
delegation is the intended data model (§9.1), the share step is the one place the
risk concentrates, which is precisely why it stays human.

---

## 7. Widgets in conversations

A **separate `metadata.dashboardEmbeds` projection**, not an extension of
`IntegrationUiCard`. That contract is an ephemeral product-result card carrying
typed links and actions; a dashboard widget needs canonical identity, refresh
invalidation, source authorization, long retention, and live/static semantics.
They share the *visual shell* — kicker, border, panel, status-pill idiom — as
components and CSS conventions, not as a schema union. One card family by look,
two contracts by need.

**The projection is server-populated only.** Clients never submit embed metadata.

Posting flows from the dashboard (widget `⋯` → Post to chat…) and from the
composer (`+` → Dashboard widget). The dialog defaults to Snapshot, shows
live-vs-static as a visible choice rather than an implementation detail, and when
Live is chosen names the reach in real numbers — "40 people in this channel can't
see this source" — instead of abstracting it. A frozen card says which moment it
is from and offers `View live →` to anyone entitled.

---

## 8. Widgets in knowledge pages

**Correcting the brief: knowledge pages are TipTap HTML, not Markdown.** The
brief this design was commissioned from said Markdown; Codex Sol checked the code
and corrected it. `RichTextEditor` persists HTML, and the right pattern is
already in the repo.

A widget embed is a **custom atomic TipTap node**, built exactly like
[`wikilink-node.ts`](../../admin/src/components/features/knowledge/wikilink/wikilink-node.ts):
its only authored attribute is a server-minted `embedId`, it serializes to a
strict data-attribute contract, and `parseHTML` round-trips losslessly. Saving a
page parses the document, validates every embed id, and writes
`DashboardEmbedPlacement` rows for that exact `KnowledgePageVersion` in the same
transaction — the same shape as
[`packages/knowledge/src/native-links.ts`](../../packages/knowledge/src/native-links.ts)
maintaining the link index. **The page body never contains widget data, source
URLs, config, or grants.**

The read path is already injection-safe: `RichTextContent` parses stored HTML
through the ProseMirror schema, so scripts, handlers, and unknown tags are
dropped and nothing reaches the DOM as a raw string.

While **editing**, the node is a compact placeholder chip — `📊 ARR (Stat) · live
· from Revenue watch ✕` — not a live chart; cursor logic over a live chart is
misery for no benefit. While **reading**, it is the real
`DashboardWidgetCard surface="knowledge"`.

**Versioning:** restoring an old page version restores the old *reference*. A live
node then shows current data (it is a live reference — that is what was chosen); a
static node stays historically exact. The editor labels this plainly.

**RAG:** chunking emits a short placeholder — `[Live data widget: API request
volume; data omitted; updated 13 Aug 2026 12:15 UTC; widget 7f…]`. External rows
never enter knowledge chunks or embeddings, which closes indirect prompt
injection through retrieval.

**Export:** each node resolves under the *exporting viewer's* entitlement — an
authorized live node materializes as a timestamped static table plus a link, a
static node uses its frozen data, an unauthorized node becomes `[Dashboard widget
unavailable]`. Exports never emit script, iframe, external URL, or secret.

---

## 9. Access

One function, `resolveDashboardAccess({ actor, organizationId, resource, target? })`,
is called by list, get, source reads, embed resolution, export, realtime, and every
agent tool. Deny-overrides `checkPolicy` is evaluated after role, membership, and
grant candidates.

Capabilities are separate, not a ladder: `view`, `edit`, `source_manage`
(credential operations stay owner/admin-only even here), `share` (a sharer can
never grant what it lacks), `archive` (v1 archives; purge follows retention, not a
button).

### 9.1 The crux — whose entitlement renders the data

**External HTTP sources are always `delegated`.** Confirmed by the owner on
2026-08-13, in their words: *"if I put numbers into a dashboard with my API key
and make it available, then whoever I give access to is going to see the
numbers — yes."* That is the intended behaviour, not a compromise.

The external service cannot
evaluate a Nessie viewer, and one-cache scheduling means one fetch under one
authority; "render with the viewer's entitlement" is not expressible against a
third-party API. So the authority is explicit, named in the UI ("Data is
refreshed using Alice's API access and is visible to this dashboard's audience"),
recorded on the source, shown in Share, carried into version history, and audited
on creation, authority change, and audience widening.

This is a *deliberate, visible delegation*, not accidental inheritance: the
authority must have the right to publish, a human source manager confirms the
declared output schema, and an agent can create an uncredentialed source or bind
an approved one but can never turn a private credential into a new publisher. If
the authority is deactivated or revokes the secret, refreshes stop and the source
visibly goes stale.

`viewer` mode is reserved for the future in-process internal adapters (§4.5),
where it *is* expressible. The two modes are closed by source kind — a client
cannot relabel an external source as viewer-scoped.

### 9.2 Embedding grants nothing

At creation:

```
actor may read the widget AND the target container
  AND actor may share it to that audience
  AND the audience already inherits access, or a grant is explicitly confirmed
→ create embed + grant + placement, atomically
```

On **every** later read:

```
viewer may read the target message/channel or page version/space
  AND viewer may read the exact dashboard/widget/snapshot resource
  AND no deny applies AND tenant envelopes match
→ return the validated projection; else unavailable/404
```

A copied `embedId`, `widgetId`, attachment id, exported link, or scraped message
JSON cannot bypass either half. Losing channel membership, a revoked grant, a
deny, deactivation, or the page moving out of reach makes resolution return 404
immediately — the blob being old or in a browser cache is irrelevant, because
delivery is authenticated and non-public.

Granularity is dashboard, single live widget, or single snapshot; a widget grant
exposes that widget's projection and provenance only, never the dashboard or the
source config. Audience grants (channel, team, project, knowledge space) follow
membership dynamically and the UI says so before creation.

**No public or anonymous links at v1** — unanimous across all three designs.
Data is fetched under a credentialed authority and snapshots are durable; a
bearer URL would add a second entitlement system with its own revocation and
crawler-cache problems before the internal model is proven. Written as a
deliberate deferral, not an omission.

---

## 10. Versions

A version is a checkpoint of **structure** — widgets, bindings, styles, layout —
**never of data**. Data has its own immutable lineage in datasets and snapshots.
Versions are append-only and auto-created on leaving edit mode (or 10 min idle),
on each agent run's completion, and on every restore. **Restore appends** a new
version ("Restored to 4 Aug"); history only ever grows.

The change summary is composed **deterministically from the op log** — this is
structural fact, not content interpretation, so the no-string-matching rule is
untriggered: *"Ana widened Revenue and switched it to weekly"*, *"Quill added
Churn (Stat) and ARR by region (Bar), and set Revenue to emphasis."* Verb table
per op type, grouped by author, capped at three clauses plus "and 2 more".

The **diff is spatial**, because a line diff of a layout is meaningless. Viewing
an old version renders it read-only on the canvas with a banner; widgets added
since get a dashed success outline, removed ones a ghost danger outline labelled
"removed since", moved or resized ones a warning tick — the same tone vocabulary
`VersionHistory.tsx` already established for text, applied to space.

Agent rows carry the agent glyph and `via run →`, deep-linking the conversation
that caused the change through `Run.replyRootMessageId`. Identical row anatomy
for people and agents; only the glyph and the run link differ.

Dashboard versions and `KnowledgePageVersion` stay **parallel mechanisms** — they
version different aggregates (authored dashboard config vs page body + embed
placements) — and neither copies the other's machinery.

---

## 11. Security posture

### 11.1 The rendering surface
Closed structurally (§3.2): no code slot, no colour, no class, no style object,
no `href`/`src`/action/event field anywhere in the contract, no Markdown or HTML
interpretation, no `dangerouslySetInnerHTML`, no table cell rendered as HTML,
image, or link. Chart tooltips and legends are Nessie components receiving
numeric coordinates and plain text; Recharts never sees a formatter function or a
config spread. Widgets cannot trigger mutations — "Open dashboard", "View
source", and "Refresh" are server-generated chrome outside the authored contract,
routing to fixed internal routes by opaque id after authorization.

### 11.2 Untrusted values
Strings validated as Unicode, control characters (except tab/newline) rejected,
bidi controls stripped or visibly escaped, capped at 512 code points / 2 KiB.
Column keys are ASCII identifiers ≤64 chars; labels come from the *authored*
definition, never dynamically from an external value. Values are React text
nodes, never concatenated into HTML, SVG attributes, CSS, URLs, or class names.

**Back into agents:** refresh and rendering never invoke a model. Message and
knowledge hydration adds only an inventory marker — widget id, title, live/static,
freshness — never rows. Values reach a run only through an explicit authorized
`dashboard_widget_read`, which returns a bounded projection inside a
Nessie-authored, length-bounded, escaped delimiter block that external content
cannot close, following the posture already used for untrusted checkpoint working
notes. Each call uses its own live actor context; no agent inherits another's
source access.

### 11.3 Egress
Every fetch — API preview, on-demand, scheduled, conditional revalidation, retry
— goes through one `fetchAndNormalizeDashboardSource` in `@nessie/dashboard`,
which calls `@nessie/runtime` `safeFetch`/`pinnedFetch`. No path accepts a
pre-fetched body and none uses `assertSafeUrl` + plain `fetch`.

**`maxRedirects: 0` for credentialed calls** — stricter than redirect
revalidation, because even a safe public redirect should never receive an
origin-bound secret. HTTPS only; userinfo and fragments rejected; DNS resolved
once and every dialed address vetted and pinned; loopback, link-local, private,
metadata, and multicast ranges refused; the Nessie API/admin origins denied even
though publicly routable.

Response controls: 10 s total deadline including body; `Accept: application/json`
and only JSON content types accepted; **`Accept-Encoding: identity` with any
encoded response rejected**, which closes decompression bombs outright rather
than accounting for compressed size; `Content-Length` over 1 MiB rejected plus a
streaming byte counter for absent or dishonest lengths; JSON depth 20 / 50,000
nodes; then the JMESPath caps; then the 256 KiB dataset cap. A source that starts
returning 10 MB stops at one bounded megabyte with
`DASHBOARD_SOURCE_RESPONSE_TOO_LARGE` and backs off. No response body ever enters
a log, error, audit row, or refresh record. Rate limits key from authenticated
org/user/source ids, so header spoofing cannot shift ownership.

### 11.4 Credentials
Encrypted through the existing AES-256-GCM secret store currently owned by
`packages/mcp-manage/src/mcp-oauth-secret-store.ts`, with the storage interface
first extracted into a domain-neutral package (dashboards would be its third
consumer — justified reuse, not speculative abstraction). Distinct
`secret_dashboard_` prefix.

One plaintext route, `PUT /api/dashboard-data-sources/:id/credential`. The client
never submits a ref; the response returns only
`{ attached, mode, headerName, lockedOrigin, rotatedAt }`. No read API ever
returns the ref, ciphertext, length, or prefix.

**Agents may set a credential; they may never read one.** Decided 2026-08-13,
following the existing `connector_set_secret` precedent — conversational setup is
how connectors already work, and refusing it here would make an agent-driven
dashboard impossible to finish. `dashboard_source_set_credential` is a
**write-only** tool: it forwards a value the user supplied in the conversation
straight to the encrypted store and returns only `{ attached: true }`.

The exfiltration primitive stays closed, because two separate things are being
denied and only one of them moved:

- An agent can attach a credential **it was just given**. There is nothing to
  steal — the user already had the value.
- An agent can never *obtain* a stored credential. Refs are server-minted and
  never returned, plaintext is never readable back, there is no test/echo tool,
  and the origin lock below means an existing credentialed source cannot be
  retargeted at an attacker's host. So "take Alice's stored key and point it
  somewhere else" remains inexpressible — that was always the real attack, and
  it is closed by the ref model and the origin lock, not by who may type a key.

Two residual risks this creates, both handled rather than accepted: a key pasted
into chat lands in message history and the run transcript, so the UI offers a
secret field on the connect card and the tool description instructs the agent
never to echo the value; and a member could attach a key to a source whose data
then reaches that source's audience — which is the delegation model working as
intended (§9.1), gated at the share step, and audited on attach.

**The exfiltration primitive is closed by construction.** A credential is bound to
exact org, source, authority user, placement, and normalized
`scheme://host:port`, and injected server-side only after a live check and an
exact origin comparison. A credentialed source's origin, method, auth mode, and
redirect policy are **locked**: any human-authorized change to one of them
atomically revokes the secret, disables refresh, and demands a new credential.
Agents may retarget a binding or an uncredentialed path, never the origin or auth
placement of a credentialed source. "Point Alice's key at my server" is not
expressible.

Errors are stable codes (`SOURCE_TIMEOUT`, `SOURCE_AUTH_REJECTED`,
`SOURCE_SCHEMA_MISMATCH`). Viewers see only stale/unavailable wording; source
managers additionally see status class, timings, counts, and a redacted
validation path — never upstream text.

### 11.5 Snapshot longevity vs live rights
A snapshot freezes **bytes acquired under an authority, not the right to read
them** (§9.2). A deactivated user reads nothing. A member removed from a channel
cannot read the message and therefore cannot resolve its snapshot. If a grant's
human author is deactivated, that explicit grant becomes **inert pending owner
review**, while inherited home access recalculates independently — so abandoned
delegated publications do not silently outlive their author.

### 11.6 Tenancy
Every table carries `organizationId`; every service entry takes the org from
authenticated actor context, never a body field; no public command accepts a
caller-chosen envelope. Named scoping for widget, dataset, snapshot, embed,
export, list/search, history, and blob reads — with **no direct blob endpoint by
attachment id**; only the authorized snapshot resolver streams dataset bytes.
Export re-authorizes every embed individually, and unauthorized entries render as
unavailable rather than being omitted in a way that leaks counts.

**Realtime** adds a `dashboard` scope whose published payloads are *content-free
invalidations* — an opaque stream key and a revision, no title, ids, data, or
error detail. Entitlement is re-run before each delivery (matching the channel
transport's live membership recheck, not the initial subscription), revocation
emits a scope invalidation and closes the subscription, and a widget-only grantee
gets an opaque widget-scoped key rather than the dashboard stream. Clients then
refetch through normal authorized routes, so no race can deliver data after
access loss.

### 11.7 Resource safety
Dataset blobs go through `FileService` — quota-reserved before a snapshot becomes
current, `StorageUsageEvent` on write and delete, prior snapshot retained if the
upload or quota fails. Unreferenced live history keeps the newest 50 per source
for 30 days; anything referenced by a widget snapshot, placement, page version,
or audit retention is FK-protected, with a 90-day recovery window after the last
reference goes. Client caps (rows, points, series) mean a widget cannot lock a
viewer's browser. The per-org limits in §4.4 are what stops an agent creating 500
widgets on 10-second refreshes — and the 5-minute floor is not agent-relaxable.

### 11.8 Audit
`AuditLog` entries for: dashboard create/archive/restore, source create/update/
archive, **credential attach/rotate/revoke**, authority change, `accessMode`
change, grant create/revoke, embed creation with its audience, snapshot freeze,
and export. Version history is *not* sufficient on its own: it records structural
change by design and deliberately not data, authority, grants, or reads, so the
security-relevant events would otherwise be invisible. Delegated-read logging is
sampled under volume but always records the **first** read per viewer per source.
Owner/admin read the audit; source managers get non-secret diagnostics.

---

## 12. Doorways (Rule zero)

| Where you are standing | The doorway |
|---|---|
| Sidebar | **Dashboards** — the owning surface |
| Project → Insights tab | the same index component, `scope=project` |
| Project → Overview | one router row per pinned dashboard — a link, never a chart |
| A channel | posted card footer `Open dashboard →`; composer `+` → Dashboard widget |
| A knowledge page | the embed node's footer link; `/widget` in the editor |
| Global search | dashboards and widgets indexed by *title and metadata only* — never cell values |
| The agent that built it | the run's completion message links it; agent drawer lists "Dashboards this agent edits" |
| A failing source | the widget error strip's "View source" → the Sources pane |

Every doorway is a parameterisation of the index component, `DashboardWidgetCard`,
or a plain link. No second implementations.

---

## 13. Delivery

**Stage 1 — a complete, reachable vertical slice.** Entities + migration, strict
v1 schemas, the shared `@nessie/dashboard` authorization/version/refresh services,
audit, quotas, read-time validation; `/dashboards` and `/dashboards/:id`
view/edit/history, sidebar entry, project Insights doorway; all five renderers
with every state; the source wizard, manual + scheduled HTTPS GET JSON, JMESPath
normalization (relocated, not reimplemented), owner-only credential attach;
realtime invalidation; append-only versions, spatial diff, restore, optimistic
concurrency, archive, home inheritance, grants. Verified with headless Playwright
across every renderer state, breakpoint, theme, and the access-denied state.

Plus the **complete agent tool bundle**, registered as ordinary grantable tools
and held by the PA, the stock dashboards agent, and any Designer-built agent:
`dashboard_list`, `dashboard_create`, `dashboard_source_list`,
`dashboard_source_create`, `dashboard_source_probe`,
`dashboard_source_set_credential` (write-only), `dashboard_widget_add`,
`dashboard_widget_update` (rebind, restyle, retitle), `dashboard_widget_move`
(position and size), `dashboard_widget_remove`, and `dashboard_version_list` /
`dashboard_restore`. The probe's untrusted-data framing (§6.2, §11.2) ships here,
not in Stage 3 — an agent sees external values from the first source it creates.

This is genuinely useful before any embedding exists: a person can find, create,
monitor, edit, share, and restore a dashboard, and an agent can do the same.
Nothing server-only, no unreachable canvas.

**Stage 2 — conversations.** Freeze-snapshot, the channel/thread picker and post
flow with the reach warning, message rendering, per-widget and per-snapshot
grants, compact layout, live-embed invalidation. One shared function for human
and agent posting.

**Stage 3 — knowledge.** The TipTap node, per-version placements, knowledge-space
grants, export materialization, the RAG placeholder, the authorized
`dashboard_widget_read` tool with untrusted framing, search and knowledge
doorways.

Chat and knowledge are staged separately only because their privilege-laundering
test matrices are independent. **No insecure generic embed ships early**, and no
security control, quota, retention reference, audit entry, or access check is
deferred to a later stage.

**Stage 4 — hardening at measured scale.** Retention sweeps, owner usage
reporting, load tests at the configured caps, and any additional component kind
that has earned its place by then.

---

## 14. Explicitly not built

Arbitrary HTML/Markdown/SVG/JS/CSS/SQL in widgets, formatter or template code,
raw JSON editors, iframes, images, arbitrary URLs or actions, mutation buttons ·
agent credential *read* or retrieval of any kind, caller-chosen secret refs,
browser-side
external fetches, private-network endpoints, authenticated redirects, internal
Nessie HTTP endpoints · non-GET methods, GraphQL, webhook/push sources,
sub-5-minute schedules, streaming APIs, per-viewer fetches, custom request bodies
· public or anonymous links, cross-organization grants, email embeds, exported
active content · custom colours or hex pickers, chart-library config, plugin
widgets, pie/gauge/map/scatter/heatmap/pivot, conditional scripting, arbitrary
drill-down · SQL or report-builder access to Nessie tables, owner telemetry on
member surfaces, charts copied onto the project overview · CRDT editing, cursor
collaboration, automatic conflict merge · a second scheduler, realtime, secret
store, audit system, or JMESPath evaluator · retaining raw responses, indexing
external cell values into search or RAG, or putting dashboard data into an agent
context without an explicit authorized tool call and untrusted framing.

---

## 15. Where the three designs disagreed, and what won

| # | Question | Fable | Kimix | Sol | Decision |
|---|---|---|---|---|---|
| 1 | Widget catalogue | 5: stat, trend, breakdown, table, status | 6: + pie, markdown_note | 4: line, bar, table, stat | **5** — Sol's four plus Fable's `status`, which answers a categorical-health question none of the others can and is nearly free. Pie cut 2–1; `markdown_note` cut as the freeform wedge. |
| 2 | Chat embedding | separate `metadata.widgetEmbeds` | extend `IntegrationUiCard` | separate, **server-populated only** | **Separate, server-populated.** Sol's reasoning decides it: the card contract is an ephemeral product-result surface with links and actions; a widget needs identity, invalidation, source authorization, retention, and live/static. Shared shell, separate contract. |
| 3 | Data entitlement (the crux) | not deeply addressed | per-source `delegateMode`, default `viewer` | `delegated` forced for external, `viewer` reserved for internal | **Sol.** Viewer entitlement is not expressible against a third-party API and contradicts one-cache scheduling. Kimix's contribution survives as the *source-object* visibility gate and the visible-provenance chip. |
| 4 | Scheduling | (not specified) | new `DashboardRefreshSchedule` poller table | existing trigger scheduler, new target kind | **Sol** — AGENTS.md bans a second scheduler. Kimix's real concern ("refreshing a chart is not running an agent") is met by the target-kind discriminant: no `AgentTrigger` row, no run, no tokens. |
| 5 | KB embedding | `::widget{}` Markdown directive | `::dashboard-widget[]` Markdown directive | **TipTap atomic node** | **Sol**, and it is a correction of *my* brief, which wrongly told all three that pages are Markdown. Fable's and Kimix's UX reasoning survives on top of the correct mechanism. |
| 6 | Grid + chart libraries | RGL + Recharts | RGL + Recharts | RGL + Recharts, both lazy behind adapters | **Unanimous**, with Sol's quarantine. Verified React 19 compatible. |
| 7 | Transform | in the source contract | JMESPath, reuse the evaluator | JMESPath, relocate behind a neutral export | **Unanimous on reuse.** Independently reached by two models and confirmed against the file. |
| 8 | Public links at v1 | no | no | no | **Unanimous no.** |
| 9 | Internal Nessie data | (out of scope) | partial | out of scope + deny Nessie origins | **Sol** — privilege confusion is the decisive argument, and the future shape (named in-process adapters, `viewer` mode) is specified rather than left open. |
| 10 | Agent editing model | live ops, presence, locks, Stop | (light) | audience-widening refusal | **Fable's UX + Sol's `DASHBOARD_SHARE_REQUIRED`.** |
| 11 | Version diff | spatial diff on the canvas | version rows | typed server-side diff | **Fable's spatial diff** over Sol's typed diff computed server-side. A line diff of a layout is meaningless. |

**On reviewer reliability:** the standing rule is to verify claims rather than
accept them. All five of Kimix's file citations checked out. Both library picks
verified against the npm registry for React 19. Two of three models inherited a
factual error I put in the brief; only Sol checked it against the code. Kimix's
§A2 also contains a visible self-correction left in the text ("no, cut that"),
which is a drafting artifact, not a defect in the conclusion.

---

## 16. Open questions for the owner

### Resolved

- **Delegated access — settled 2026-08-13, yes.** A dashboard's audience sees the
  numbers fetched under the source authority's credential. This was the single
  biggest judgement call in the plan; §9.1 is now confirmed behaviour rather than
  a proposal. The safeguards around it stay as specified — named authority in the
  UI, audit on authority and audience change, refreshes stop and the source goes
  visibly stale if the authority is deactivated or revokes the secret.
  **Consequence to design against:** because delegation is the intended model,
  the moment that carries the risk is *granting*, not fetching. The share step is
  where the audience must be stated in real numbers, and it is the step that must
  never be reachable by an agent acting alone (§6).

- **Agents may set credentials — settled 2026-08-13, yes, write-only.** Following
  the `connector_set_secret` precedent. §11.4 rewritten; the plan's original
  "agents can never touch a credential" was wrong and would have made an
  agent-driven setup impossible to finish.
- **The capability is a grantable tool bundle, plus one shipped stock dashboards
  agent — settled 2026-08-13.** Not `personalAssistantOnly`, not welded to a
  bespoke agent (§6.1).
- **Agents get the data sample and the full edit surface including layout —
  settled 2026-08-13** (§6.2, §6.3).

### Still open

1. **"Static agent" — confirm the reading.** Taken to mean Nessie ships one fixed
   stock dashboards agent definition, while the capability itself is a tool
   bundle any agent can hold. If it meant something else, §6.1 is the section to
   correct.
2. **`status` as a fifth kind** — included on Fable's argument, cut by Sol as
   unnecessary to prove the product. Cheap to build, easy to drop.
3. **Personal dashboards** — kept as a home. If personal-scope dashboards are not
   wanted at v1, dropping them removes a whole entitlement branch.
4. **Stage 1 without embedding** — Stage 1 is useful and reachable on its own, but
   the request that started this was largely about widgets in conversations. If
   chat matters more than the canvas, Stage 2 can be pulled forward at the cost of
   shipping the post flow against a thinner editor.
5. **CSV export at v1** — included; it is also the easiest way for data to leave
   the entitlement model. Worth an explicit yes or no.
