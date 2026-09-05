# Live Data Dashboards — delivery and decision record

This chapter continues the numbered design in [the overview](./overview.md).

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
widgets, heatmap/pivot/funnel/map, conditional scripting, arbitrary
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


---

## 17. Delivery log — Stage 1

Built and merged 2026-08-13/14. Seven commits, each verified before merge.

**Shipped:** the closed widget contract (`@nessie/schemas`); eight Prisma models
with three CHECK constraints; `@nessie/dashboard` (egress, normalize, probe,
access, and the four service modules); eleven API routes; the
`dashboard.source.refresh` worker job and its due-source sweep; the admin
surface with all five renderers, the drag/resize canvas and version history;
and the eleven-tool grantable agent bundle.

### Where the build deviated from §1–§16

- **The JMESPath evaluator moved rather than being wrapped.** It lived in
  `workflow-jmespath.ts`, named for its one consumer. Dashboards became the
  second, so it is now `sandboxed-jmespath.ts` with neutral exports and the old
  names kept as aliases. No caller changed.
- **The services live in `@nessie/dashboard`, not `api/src/services`.** The plan
  said agent tools call the same function the route calls; that is only literally
  true if the worker can import it. api keeps thin re-exports.
- **`react-grid-layout` v2 differs from what §5 assumed.** No `WidthProvider`
  (width comes from `useContainerWidth`), `ResponsiveLayouts` not `Layouts`, a
  `compactor` function instead of `compactType`, and drag/resize moved into
  `dragConfig`/`resizeConfig`.
- **Widget size limits are enforced on layout writes**, so an agent's move and a
  human drag are validated by one rule set — the plan asserted the property, the
  build needed `validateLayout` to make it true.

### Defects found by running it, not by reading it

- The bar chart plotted one bar per row, repeating a category as many times as
  it appeared. Only visible in a screenshot; now aggregates by category.
- Table and status cells rendered raw ISO timestamps.
- An invalid widget definition returned 500 with no message. The contract always
  rejected the write; the defect was that a caller could not tell what to fix.
  Now 400 naming the field. A duplicate source name likewise now returns 409.
- Generating the migration as a diff against a live database emitted destructive
  statements against unrelated tables — pre-existing drift between the committed
  migrations and `schema.prisma`. Worked around by diffing schema-to-schema;
  the drift itself is unfixed and needs its own change.

### Verification

Full 171-migration chain applied to a clean pgvector container, each CHECK
constraint proven to reject its bad row, cascade and restrict behaviour
exercised on real rows. The egress path is driven against a real self-signed
HTTPS server — actual TLS, real headers, a genuine 304, a 4 MiB stream cut at
the 1 MiB cap — plus a test asserting `safeFetch` still refuses loopback on the
unmodified path. End-to-end through the real API and admin with headless
Playwright: all five widget kinds rendering `fresh`. 962 tests green across
worker, dashboard, schemas and runtime.

### Stages 2–3 — also delivered

Snapshots (`freezeWidgetSnapshot`), embed placements with the two-check read
rule, grants with sharing as its own capability, `dashboard_widget_post`,
widgets rendering in the message feed off server-written
`metadata.dashboardEmbeds`, the TipTap embed node for knowledge pages, and the
add-widget panel.

One more defect surfaced only by looking: a frozen snapshot's footer read
"Live · 3m ago" — a quotation of a past moment claiming to be current, which is
exactly what the freshness footer exists to prevent. It now keys off the
projection's `snapshotId`.

### Widget catalogue expansion — 2026-09-04

The catalogue now has eight kinds. `donut` is a bounded part-to-whole view that
aggregates one declared numeric column by a declared category; `gauge` binds a
current numeric value and current numeric target from the same source; and
`scatter` plots the declared relationship between two numeric columns. The
shared schema validates each binding both at mutation and read time, all three
render through `DashboardWidgetCard`, and their compact chat/knowledge surfaces
therefore use the same canvas implementation as the editor.

`stat` cards gained an optional icon from a fixed Font Awesome Free mapping. The
definition stores only the schema-owned id; it accepts no SVG, CSS class,
package, or arbitrary icon identifier. Recharts remains the sole chart renderer
and does not receive author-supplied configuration.

### Still not built

Realtime invalidation (embeds poll on a 60 s interval), CSV export, the stock
dashboards agent's bootstrap row, and the spatial version diff (§10 describes
it; the history panel currently lists versions and their deterministic
summaries without the canvas overlay). Restore is recorded in the model and the
API appends versions, but there is no restore button yet.
