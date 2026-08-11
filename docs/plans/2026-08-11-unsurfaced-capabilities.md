# Unsurfaced capabilities — what to show, where, and what to refuse

**Date:** 2026-08-11 · **Status:** Design spec, ready to build
**Input:** production audit of six server capabilities with real data and no interface.

The owner's diagnosis governs every decision here: *"you haven't covered all the places
where it should be."* The failure mode is not missing screens — it is capabilities that are
not reachable **from the screen where the question arises**. So every "surface" verdict below
names the owning page **and** every in-context entry point. The opposite failure is policed
just as hard: owner-only telemetry never touches member surfaces (AGENTS.md law: local ops
telemetry lives at `/ops`+`/ops/usage`, never beside `/tokens` customer credits), and no
field is displayed unless it drives a decision.

---

## 1. Verdict table

| # | Capability | Verdict | Who it is for | Why (one sentence) |
|---|-----------|---------|---------------|--------------------|
| 1 | Execution runners (`/api/execution-runners`) | **Fix data first, then a section on `/ops`** | Owner (deployment operator) | "Can this deployment execute sandboxed work, and if not why" is a health question, but 558 zombie rows are a worker-registration bug that no UI should paper over. |
| 1b | Execution env templates / instances / leases / usage-ledger | **Do not build** | — | All four are empty in production; the workflow-sandbox feature is dormant, and instances belong inside workflow-run detail when it wakes up, not on a standalone page nobody visits. |
| 2 | Audit summary + verify (`/api/audit-log/summary`, `/verify`) | **Fix the 500, then surface on `/audit`** | Owner (compliance/security) | A tamper-evidence chain nobody can trigger is a trust feature that was paid for and never delivered; the summary turns a 50-row scroll into a filterable overview. |
| 3 | Inference providers / credentials / models / routing profiles | **Surface as `/settings/models`** | Owner | A `draft`+`disabled` provider row silently does nothing while the worker falls back to deployment defaults — invisible configuration that *looks* configured is worse than none. |
| 4 | Run timing (`/api/ledger/runs/timing`) | **Surface on `/ops/usage`, echo per-run on Agents → Activity** | Owner | "Why was that run slow — queue, model, or tools?" is the first diagnostic question owners ask and the data already answers it. |
| 5 | Scheduled/upcoming triggers (`/api/triggers/scheduled`, `/upcoming`) | **Surface on `/agents/triggers` + an overdue signal on `/ops`** | Owner | The Triggers page shows configuration but not the *schedule* — "what fires next, and is anything overdue" — which is the operational half of the feature. |
| 6 | Effective policy (`/api/policy/effective`) | **Surface on `/policy` — gated on one small API addition** | Owner | The rules list shows inputs, not outcomes; but the endpoint is caller-scoped, and a self-only matrix for someone who passes every check is decoration, so build it only together with an owner-only `?userId=` parameter. |

---

## 2. Per-capability design

### 2.1 Execution runners — `/ops` "Execution" section

**The 558 rows are a data problem AND a UI problem, in that order.**

*Data problem (fix first, in the worker):* `runnerLabelPrefix` is `process.env.HOSTNAME`
(`worker/src/index.ts:169`), which in Docker is the container id — every redeploy mints a new
prefix, and `registerExecutionRunners` (`worker/src/control/execution/runners.ts`) upserts on
`(provider, label)`, so each deploy creates two rows (docker + gcloud) that are never reaped.
558 rows ≈ 279 deploys of garbage. Fix: inside `registerExecutionRunners`, after the upsert,
delete rows with `heartbeatAt < now() - 7 days` (same org scope). Keep the HOSTNAME label —
it is correct for multi-worker; the reap handles the churn. The `metadata.error:
"gcloud ENOENT"` rows are also *truthful*: the production image has no gcloud and no docker
socket, so the honest current state is "no execution capability", which is exactly what the
UI must say.

*UI:* a new **Execution runners** section on `/ops` (`OpsHealthPage`), below Queue, above
Dead-letter jobs. `/ops` is the right home: the page already computes worker liveness *from
these very rows* (`api/src/services/ops-health.ts`) and already shows an "Active runners"
stat with no way to see what is behind the number.

- **What to show — live runners only** (`heartbeatAt` within 5 min), one row each:
  - `provider` + `label` (mono) — *which backend, which worker process*. Decision: is the
    runner I expect present.
  - `status` as a tone pill (`active` success / `offline` danger) — decision: can sandboxed
    execution dispatch at all.
  - `capabilities.mode` (small `text-[color:var(--tx3)]`) — decision: what the runner can do.
  - When `status === 'offline'`: `metadata.error` in a capped one-line
    `text-[color:var(--danger-text)]` — this is the actionable field ("gcloud ENOENT" →
    install the CLI in the image / mount the docker socket). Decision: what to fix.
  - `heartbeatAt` relative ("32s") right-aligned — decision: is the row fresh or dying.
  - **Rejected fields:** `id`, `createdAt`, `updatedAt`, raw `capabilities` JSON — none
    drives an action.
- **Stale rows:** never listed. One quiet footer line only while any exist:
  "N stale runner records (no heartbeat > 24 h) — cleaned automatically after 7 days" in
  `text-[color:var(--tx3)]`. No expand, no table — after the worker fix this line trends to
  zero and disappears (`0` → render nothing).
- **Anatomy:** `admin-card` per the page's existing `Stat`/list idiom; section header uses
  the house `sectionTitle` style: `EXECUTION RUNNERS (N live)`.
- **Empty state** (no rows at all): "No execution runners registered — the worker has not
  started, or has never reached this database." (danger-tinted, because it duplicates the
  worker-down signal).
- **Error state:** the page's existing top error card covers a failed `/api/ops/health`;
  the runners query failing independently renders "Couldn't load runners" inside the section
  without blanking the rest (same independence rule as the project dashboard).

**Entry points (all of them):**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| `/ops` sidebar item | (existing) | Health | `/ops` — the section's home |
| `/ops` "Active runners" stat (existing) | the stat card becomes an in-page anchor link | unchanged number | scrolls to `#execution-runners` |
| `/agents/workflows` (`WorkflowsPage`) | banner, shown **only** when at least one installed workflow declares environment steps AND no runner is `active` | "No active execution runner — sandboxed workflow steps will queue. Check system health →" | `/ops#execution-runners` |

No sidebar badge, no member-visible surface anywhere: this is deployment telemetry.

### 2.2 Audit summary + verify — on `/audit`

*Fix first:* `getAuditLogSummary` (`api/src/services/audit.ts:206`) builds
`WHERE "organization_id" = $1` through `$queryRawUnsafe` with a JS string param —
Postgres has no `uuid = text` operator, hence the production 500. Fix: `$1::uuid` (and
`::timestamptz` casts on the date params while there). One-line change, test with a
Postgres-backed suite.

*UI — two additions to `AuditLogPage`, no new route:*

**(a) Chain verification.** Header gains a "Verify chain" `admin-button-secondary`. On click,
call `GET /api/audit-log/verify` (it walks the whole chain — show a spinner in the button;
disable while pending). Result renders as a dismissible tone pill directly under the header:

- `valid: true` → success pill: "Chain intact — {checkedCount} entries verified".
- `valid: false` → danger pill, not dismissible: "Chain broken at entry {firstBreak.id} —
  {reason}" where reason maps `broken_link` → "link to previous entry does not match",
  `entry_hash_mismatch` → "entry content was altered", `unexpected_prev_hash` → "chain start
  is wrong". The pill contains a "Show entry" link that loads
  `GET /api/audit-log/{firstBreak.id}` into the list (fetch-by-id, render as the standard
  entry card pinned at top with a danger border).
- Error state: warning pill "Verification failed to run — try again" (the verify walking a
  large chain can time out; never render that as "tampered").
- Fields: `valid`, `checkedCount`, `firstBreak.{id,reason}` — all three drive the
  react-or-relax decision. Nothing else exists in the response; show all of it.

**(b) Summary chips.** Above the entry list, one row of count chips (project-dashboard chip
styling) from `GET /api/audit-log/summary?groupBy=outcome`, plus a second call with
`groupBy=action` feeding a "Top actions" set:

- `Failures N` — danger-toned, **omitted at 0**; click sets `outcome=failure` on the list
  query (the list API already accepts `outcome`; the page just never sends it).
- Top 5 actions as `{action} N` chips; click sets the existing action filter input.
- Decision each chip drives: *what to filter to*. A chip that cannot set a filter is not
  rendered — which is why `groupBy=actorId` (raw uuids, unreadable) is **rejected** for v1.
- Empty state: no events in range → chips row hidden entirely (the list's existing
  "No audit events found" carries it).
- Error state: chips row silently absent (summary is sugar; the list must not depend on it).

**Entry points:**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| `/audit` sidebar item | (existing) | Audit log | `/audit` — home |
| `/settings/security` (`SecuritySettingsPage`) | new `admin-sec-row` in the org-security section, owner-only | "Audit trail — tamper-evident hash chain · Verify" | `/audit` (the Verify button is one click away; do not run the walk from settings) |
| `/policy` page header | quiet link, owner-only | "Changes are audited →" | `/audit?action=policy.` (pre-filled action filter — policy mutations already emit `policy.*` audit events) |

### 2.3 Inference control plane — new page `/settings/models`

The worker *does* consume these rows at run time (`worker/src/run/inference-provider.ts`):
an org provider row supplies `baseUrl` + credential binding **only when**
`enabled = true AND lifecycle_status = 'approved'`, and routing profiles hard-fail on
non-runnable providers/models. Production's one deepseek row is `draft` + `disabled`:
someone configured it (via API/CLI) and it has silently never applied. That is the exact
harm this page removes.

**Home:** new route `/settings/models`, sidebar **Organization** group, label
"Model providers", `ownerOnly: true` (matches the route's `requireOwner`). Register in
`admin/src/router.tsx` + `AdminSidebarNav.tsx` + `nav-items.tsx` owner list.

**Anatomy — one page, three stacked sections** (each a `DashboardSectionCard`):

1. **Providers** (`GET /api/inference/providers`). Row: `providerKey` (mono, bold) ·
   `connectorKind` (`compiled` / `openai-compatible`, `--tx3`) · lifecycle tone pill
   (`draft` = neutral `--overlay`/`--tx2`, `approved` = success, `deprecated` = warning) ·
   enabled toggle · `baseUrl` truncated (`--tx3`) · credential-binding presence dot
   ("credential bound" / "no credential" — presence only, **never** the ref or secret;
   from `GET /api/inference/credentials?providerId=`).
   - A `draft` or disabled row additionally shows the one line that justifies the whole
     page: "Not in effect — runs use deployment defaults for {providerKey}" in
     `text-[color:var(--warning-text)]`.
   - Row actions: **Approve** (`POST .../approve`, shown while `draft`), toggle
     (`PATCH { enabled }`; surface the API's
     `INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING` 400 verbatim as inline error —
     it tells the owner exactly what to do). Decision the row drives: *make this
     configuration real, or understand that it is not*.
2. **Models** (`GET /api/inference/models`, grouped under their provider row, expandable).
   Row: `model` (mono) · lifecycle pill · enabled toggle · Approve while draft. Same
   "not in effect" line when not runnable. Reject: capability snapshots JSON (inspect-only
   noise; a "view JSON" disclosure is acceptable, not default-rendered).
3. **Routing profiles** (`GET /api/inference/routing-profiles`). Row: name/id · lifecycle
   pill · enabled toggle · Approve · stage count ("3 stages", `--tx3`) with a read-only
   expandable stage list (provider → model per stage, each stamped runnable/not from the
   loaded provider+model data — a profile pointing at a non-runnable stage is the #1
   misconfiguration and the worker throws on it at run time; show it here *before* a run
   dies). **No visual profile editor** (see do-not-build).

- **Empty state (whole page):** "No organization-level providers. Runs use the
  deployment-configured providers and models. Add a provider here only to pin a custom
  base URL or credential for this organization." — this states the (correct) default so an
  empty page reads as *fine*, not broken.
- **Error state:** per-section inline "Couldn't load providers/models/profiles"; sections
  are independent.
- **Creation:** v1 ships read/approve/toggle only, plus a minimal "Add provider" dialog
  (providerKey select, connectorKind, baseUrl, optional first credential binding via
  `POST /api/inference/credentials`). Model/profile creation stays API-only until demanded —
  the audit found *invisible existing data*, not a missing authoring tool.

**Entry points:**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| Sidebar → Organization | new item | Model providers | `/settings/models` — home |
| `/agents/designer` model picker | inline warning chip when the selected provider/model has an org row that is `draft` or disabled | "Org override not active — deployment defaults apply" | `/settings/models` |
| `/ops/usage` token breakdown "By Provider" rows | quiet right-aligned link per row, owner-only | "Configure →" | `/settings/models` |

The Agent Designer chip is the load-bearing one: the designer is where a person is when
"which provider actually serves this agent?" arises.

### 2.4 Run timing — `/ops/usage` section + per-run echo on Agents → Activity

`/ops/usage` (`OperationalTelemetryPage`) is the mandated home — owner-only local telemetry,
already the page for spend-by-outcome. `/tokens` is off-limits by law.

**Home section — "Run latency"**, placed directly after "Spend by Run Outcome" (they answer
sibling questions: what runs cost / why runs were slow). Data:
`GET /api/ledger/runs/timing?limit=50` (`RunTimingRow` shape,
`api/src/services/run-timing-summary.ts`).

- **Row anatomy** (one `admin-card` row per run, newest first as served):
  - `runId` shortened to 8 chars, mono — the join key a person pastes into Activity/logs.
  - `outcome` tone pill (completed = success, failed/cancelled = danger, else neutral).
  - **`StackedDurationBar`** (new primitive, §5): one horizontal bar, width proportional
    within the row, segments = `queueWaitMs` (fill `var(--warning-soft)`), `inferenceMs`
    (fill `var(--accent)`), `toolMs` (fill `var(--overlay)` with `var(--sep)` border),
    remainder `totalMs − (queue+inference+tool)` (transparent, `--sep` hairline). Null
    segment → omitted from the bar, "—" in the legend.
  - Legend line under the bar, `text-[color:var(--tx3)] text-xs`:
    "queue 42s · inference 3m 10s ({inferenceCount}×) · tools 55s ({toolCount}×) ·
    total 4m 51s" + relative `recordedAt` right-aligned.
  - **Attention tint:** `queueWaitMs > 30 000` renders the queue legend term in
    `var(--warning-text)` (decision: scale/unstick the worker); `totalMs > 600 000` bolds
    the total (decision: look at this run's budget/loop).
  - **Rejected field:** `taskId` — there is no task-detail page to link; keep it in a
    `title` tooltip only.
- Decisions the three segments drive are the whole point: queue-heavy → worker capacity /
  stuck slot; inference-heavy with high `inferenceCount` → model latency or loop churn;
  tool-heavy with low `toolCount` → one hanging tool.
- **Empty state:** "No run timings yet — timings are recorded when runs finish."
- **Error state:** inline section error; rest of the page unaffected.

**Per-run echo — Agents → Activity** (`RunLifecyclePanel`): the recently-ended run rows
(the same rows that carry restart/continue) gain a single quiet line, joined client-side by
`runId` from **the same** timing fetch (one request, shared via the query cache):
"4m 51s — 65% inference · 18% tools · 14% queued". Owner-only render (gate on the same
`isOwner` the panel's checkpoint affordances use; members keep seeing the panel without
timing — telemetry never leaks to member surfaces even here). No timing row → render
nothing.

**Entry points:**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| `/ops/usage` sidebar item | (existing) | Operational usage | home section `#run-latency` |
| `/agents/activity` `RunLifecyclePanel` header | quiet right link, owner-only | "Latency history →" | `/ops/usage#run-latency` |
| `/agents/activity` ended-run rows | the timing line itself | e.g. "4m 51s — 65% inference…" | (informational; click → `/ops/usage#run-latency`) |

### 2.5 Scheduled/upcoming triggers — `/agents/triggers` "Up next" + `/ops` overdue signal

The Triggers page (`useTriggersPageState` → `GET /api/triggers`) shows every trigger's
*configuration*; `TriggerDetail` even renders `nextRunAt` — but only after you select the
right trigger. Nobody can answer "what fires in the next hour" or "is the schedule stuck".

**(a) "Up next" strip** at the top of `TriggerListColumn`, above the filters. Data:
`GET /api/triggers/scheduled?limit=5` (server-side filter to enabled+active
scheduled/interval; note for the builder: `listScheduledTriggers` in
`api/src/services/trigger-crud.ts` must gain `orderBy: { nextRunAt: 'asc' }` — today the
order is unspecified, which makes "next 5" a lie).

- **Row anatomy** (compact, 3 rows max shown, "Show all N scheduled" expands in place —
  project-dashboard idiom): trigger `name` (fallback `type`) · target ("→ {agent/workflow
  name}" via the registry maps the page already builds, `--tx3`) · `nextRunAt` as relative
  time right-aligned ("in 12m", bold when < 5 min).
- Click → selects that trigger in the existing list (same `setSelectedTriggerId` path — the
  detail pane with Run now / deliveries is already built; the strip's only job is routing).
- Fields rejected: `config`, `webhookApiKey`, timestamps other than `nextRunAt` — detail
  pane territory.

**(b) Overdue chip.** From `GET /api/triggers/upcoming` (semantically: *due before now* —
`nextRunAt <= now`, i.e. the sweep should already have fired them). A trigger due more than
2 sweep intervals ago (> 60 s; the sweep runs every 15 s) is genuinely stuck. Render:

- In the Up-next strip header: attention chip `Overdue N` (danger tone, **omitted at 0**);
  click filters the main list to those triggers (client-side by id).
- On the individual list rows and detail pane: an `Overdue` danger pill next to the status.
- Rows merely ≤ 60 s past due render as "due now" (neutral) — the sweep is simply about to
  take them; alarming on those is noise.
- **Empty states:** no scheduled triggers at all → strip collapses to one line
  "No scheduled triggers — schedules appear here when you create a scheduled or interval
  trigger." Zero overdue → no chip.
- **Error state:** strip absent, list unaffected.

**(c) The cross-surface signal — `/ops`.** A stuck schedule is a *worker* symptom (the sweep
lives in `worker/src/index.ts`), so `/ops` (Health) gains one stat card in the Worker
section: **"Overdue triggers"** (`Stat` with `danger` at > 0), sourced from the same
`/api/triggers/upcoming` + 60 s threshold, linking to `/agents/triggers`. This is the entry
point at the moment of need: an operator staring at Health because "my morning digest never
arrived" must be routed to the trigger, and a trigger owner staring at an overdue chip must
be able to discover it is the worker (the Health link in the sidebar completes the loop).

**Entry points:**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| `/agents/triggers` | Up-next strip | "UP NEXT" + rows | selects trigger in place — home |
| `/agents/triggers` | `Overdue N` chip | "Overdue N" | filters list to stuck triggers |
| `/ops` Worker section | new stat card | "Overdue triggers · N" | `/agents/triggers` |
| `/agents/triggers` detail pane | (existing) "Next run" fact row | unchanged | — |

### 2.6 Effective policy — `/policy` "Effective access" panel, gated on an API addition

`GET /api/policy/effective` resolves the **caller's own** 12×10 decision matrix — there is
no actor parameter. For the only people who can open `/policy` (owners), a self-matrix is
all-allow wallpaper. The honest design:

- **Required API addition (S):** owner-only `?userId=` on `/api/policy/effective`
  (build the target user's `AuthorizedActionContext` scope chain server-side; deny
  non-owners passing it). Without this, **do not build the panel** — a self-only matrix
  fails the "drives a decision" test.
- **UI (after the addition):** `/policy` becomes two stacked regions (no router change):
  the existing rules editor, plus an **"Effective access"** `DashboardSectionCard` with a
  member picker (reuse the members list from `/api/users` the admin already loads
  elsewhere) and the matrix: resource types as rows, actions as columns, each cell a tiny
  tone pill — allow = success, deny = danger, `default`-deny = neutral `--overlay` (visually
  distinct from an explicit deny, because "no rule reached" and "a rule denied" lead to
  different fixes). Cell tooltip: the winning rule's `scope:effect` when the service exposes
  it (v1 may ship decision-only).
  - Decision the matrix drives: after editing rules, *verify the outcome for the person who
    complained* — the read-back loop the rules list cannot provide.
  - **Empty state:** no member selected → "Pick a member to preview what they can do."
  - **Error state:** inline "Couldn't compute effective access."
- Deliberately **not** on `/settings/profile` for members: a member-facing "your access"
  grid answers a question nobody asked, in a surface that must stay quiet (noise rule).

**Entry points:**

| Screen | Element | Copy | Goes to |
|---|---|---|---|
| `/policy` | the panel itself | "EFFECTIVE ACCESS" | home |
| `/policy` rules list | after any rule create/delete succeeds, inline hint under the form | "Rule saved — preview its effect ↓" | scrolls to the panel, preserving the picked member |
| `/settings/members` row overflow menu (owner-only) | menu item | "Preview access" | `/policy?userId=…` (panel pre-picks the member) |

---

## 3. Do-not-build list

1. **Execution environment templates / instances / leases / usage-ledger pages.** All four
   endpoints return empty in production; the sandbox feature is dormant. When workflow
   sandboxes go live, instances render inside the workflow-run detail (where a person
   watches a run) and the usage ledger folds into `/ops/usage` — a standalone
   "Environments" page today would be six empty tables proving the audit's point in reverse.
2. **A standalone `/ops/runners` page.** Runner state is one section of Health; a route with
   one card is IA sprawl.
3. **Rendering the 558 stale runner rows** (paginated, filterable, exportable…). They are
   garbage; the worker deletes them. The UI's only obligation is the one-line count while
   they still exist.
4. **Audit analytics** (charts, actor leaderboards, `groupBy=actorId` chips). Counts that
   cannot set a filter are decoration; raw-uuid actor chips are unreadable. The summary's
   job is to *route into the filtered list*, nothing more.
5. **Routing-profile visual editor.** Profiles are rare, JSON-shaped, and validated
   server-side; v1 is list + runnable-check + approve. An editor is speculative generality.
6. **Inference model/profile creation UI beyond the minimal provider dialog** — authoring
   stays API-first until someone asks; the audit found invisible *existing* data.
7. **Self-only effective-policy matrix** (without the `?userId=` addition) and any
   member-facing "your access" surface.
8. **Sidebar count badges for any of the six.** The nav carries exactly the badges it has
   (alerts bell, unread). Attention lives as in-page chips (`Overdue N`, `Failures N`) and
   one Health stat; six new red dots in the sidebar is how badge blindness is manufactured.
9. **Run timing anywhere member-visible** — including the member view of Agents → Activity
   and anything on `/tokens` (both barred by the telemetry law).
10. **`/api/triggers/scheduled` as its own page/tab.** It is a strip on the page that
    already owns triggers.

---

## 4. Interconnection map — admin IA after this plan

Legend: **⚠ orphan today** = reachable only from the sidebar, with zero in-context inbound
links; **(new)** = added by this plan. Chat/knowledge/project surfaces that are already
richly interlinked (channels, projects, KB, approvals, alerts, search) are listed once,
collapsed.

| Surface | Links IN (before → after) | Links OUT (after) |
|---|---|---|
| `/channels`, `/projects/*`, `/knowledge-base`, `/approvals`, `/alerts`, `/search` | already dense (sidebar, bell, dashboards, deep links) | unchanged |
| `/agents` + `/agents/designer` | sidebar; agent chips in chat | **(new)** designer model-picker chip → `/settings/models` |
| `/agents/activity` | sidebar; budget-stop Continue notices in chat | cancel/restart/continue (existing); **(new)** "Latency history →" → `/ops/usage#run-latency` |
| `/agents/triggers` | ⚠ sidebar only → **+ `/ops` overdue stat (new)** | trigger detail → target channel (existing); **(new)** Up-next strip self-routes |
| `/agents/workflows`, `/agents/tools` | sidebar; designer | **(new)** workflows no-runner banner → `/ops#execution-runners` |
| `/audit` | ⚠ sidebar only → **+ `/settings/security` row (new), + `/policy` "changes are audited" (new)** | **(new)** verify-break "Show entry"; summary chips → filtered self |
| `/policy` | ⚠ sidebar only → **+ `/settings/members` "Preview access" (new)** | **(new)** → `/audit?action=policy.`; effective-access panel self-routes |
| `/tokens` (customer billing — UOA only) | sidebar; checkout returns | UOA-frozen actions only — **no link may be added between `/tokens` and any surface below this row** |
| `/ops` (Health) | ⚠ sidebar only → **+ workflows banner (new), + Activity via usage page (indirect)** | **(new)** overdue stat → `/agents/triggers`; runners stat → `#execution-runners` |
| `/ops/usage` | ⚠ sidebar only → **+ Activity "Latency history" (new)** | **(new)** provider breakdown "Configure →" → `/settings/models` |
| `/settings/models` **(new)** | sidebar Organization group; designer chip; `/ops/usage` provider rows | approve/toggle actions in place |
| `/settings/security` | sidebar | **(new)** audit row → `/audit` |
| `/settings/members` | sidebar; project dashboard "Manage →" | **(new)** overflow → `/policy?userId=` |

After this plan, no governance/ops surface is sidebar-only: every one has at least one
inbound link from the screen where its question arises, and every one links onward to the
place where the answer is acted on. That closure is the deliverable.

---

## 5. Reusable primitives

Small set; names reuse the project-dashboard spec (`docs/plans/2026-08-11-project-dashboard.md`)
where an equivalent exists. All in `admin/src/components/shared/`, all colour via tokens.

| Primitive | Definition | Used by |
|---|---|---|
| **`DashboardSectionCard`** (exists in the project-dashboard spec §6 — reuse, do not fork) | `admin-card` + header row (uppercase `--tx3` label, optional count, optional right link) + body slot | #1 runners section, #3 all three sections, #4 latency section, #5 Up-next strip, #6 effective-access panel |
| **`TonePill`** (new — extracts the success/warning/danger/neutral pill currently copy-pasted in `OpsHealthPage` `WORKER_TONE`, `AuditLogPage` outcome, `PolicyPage` effect) | `rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]` over `--success-soft/--success-text`, `--warning-*`, `--danger-*`, or `--overlay`/`--tx2` | #1 runner status, #2 verify result + outcome, #3 lifecycle status, #4 run outcome, #5 Overdue, #6 matrix cells — plus the three pages it is extracted from |
| **Count chip** (project-dashboard Work-chip styling — same border/rounded-full pill; promote to a shared `CountChip` when the dashboard lands) | `border border-[color:var(--sep)] rounded-full px-2.5 py-1 text-xs`, bold count, `--tx2` label; danger variant tints count `--danger-text` and is omitted at 0 | #2 summary chips, #5 `Overdue N`, project dashboard Work section |
| **`StackedDurationBar`** (new) | proportional horizontal segment bar (queue `--warning-soft` / inference `--accent` / tools `--overlay`+`--sep` border / remainder hairline) + legend line; null-safe | #4 only today — but it is the generic "where did the time go" mark for any future stage breakdown (workflow steps, sync jobs) |
| **Attention-stat** (existing `Stat` in `OpsHealthPage` with `danger` — extract alongside `TonePill`) | stat card whose value turns `--danger-text` when > 0 | #5 overdue stat on `/ops`; existing Dead queue stat |

Everything else (skeleton rows, "Show all N" in-place expansion, per-section load
independence) follows the project-dashboard idioms verbatim.

---

## 6. Build order (value per effort)

| Rank | Work | Size | Why here |
|---|---|---|---|
| **1** | **#2 Audit: `::uuid` cast fix + Verify button + summary chips** | **S** | A production 500 fixed with one cast, and a shipped-but-unreachable trust feature delivered with ~80 lines of UI on an existing page; highest credibility-per-line in the list. **Build first.** |
| 2 | #5 Triggers: Up-next strip + overdue chips + `/ops` stat (+ `orderBy nextRunAt` one-liner) | S–M | Pure assembly on existing pages/endpoints; converts a config page into an operational one and gives Health its first cross-link. |
| 3 | #4 Run timing: `/ops/usage` section + Activity echo | M | Data is fully baked (`RunTimingRow`); cost is one section + one shared query + the `StackedDurationBar` primitive that future surfaces reuse. |
| 4 | #1 Runners: worker reap + `/ops` section + workflows banner | M | The reap is the real fix (small, worker-side, needs a DB-suite test); UI is one section. Value is honesty about execution capability, which currently matters mainly when workflows wake up. |
| 5 | #3 `/settings/models` page | L | New route, three sections, mutations, designer integration — the most build for real but narrow value (one silent draft row today; grows with self-hosted orgs overriding providers). |
| 6 | #6 Policy effective: `?userId=` API + matrix panel | S+S | Cheap, but the question it answers ("why can't X do Y") is asked rarely today; gated on its API addition so it never ships as wallpaper. |

Extraction of `TonePill` (and `Attention-stat`) happens inside rank 1's turn — the audit page
already contains the pattern, and every later rank consumes it; that ordering keeps the
"pause, refactor, then reuse" rule intact.
