# Tools, Triggers & Agent Designer redesign

> Status: shipped 2026-07-06.

One pass over the three operator surfaces under **Admin → Agents** — Tools
(`/agents/tools`), Triggers (`/agents/triggers`) and the Agent Designer
(`/agents/designer`) — to make them usable end-to-end and to fix the tool
permission model the designer writes.

## 1) Agent tool policy — the contract, now surfaced end-to-end

The worker resolves an agent's tools from `Agent.toolPolicy`
(`Record<string, boolean>`) with **two key spaces**:

| Tool kind | Policy key | Default when key absent |
|---|---|---|
| Builtin (`web_search`, `file_read`, …) | the tool id | **allowed** (org registry `enabled` permitting); `false` denies (`worker/src/run/tool-policy.ts`) |
| MCP / connector | the `ToolRegistryEntry` uuid | **denied**; `true` allows (`worker/src/run/mcp-toolset.ts`) |

What changed:

- **`AgentRecord` now returns `toolPolicy`** (`api/src/contracts/agents.ts`,
  `mapAgentRecord`), so editing an agent round-trips its real policy. Before,
  the designer silently reset tools on every edit.
- **The designer's tool picker uses the live catalog** instead of a hardcoded
  six-entry list whose ids (`bash`, `file-read`, …) never matched real builtin
  ids. The catalog merges `/api/tools` (builtin descriptors, any actor) with
  `/api/mcp/tools` (connector registry, owner only) —
  `admin/src/facades/designer/tool-catalog.ts`. The same module owns
  `buildToolPolicy` (sparse policy: builtin → record only denials, MCP →
  record only allowances) and `isToolEnabled` (effective-state resolution).
- The agent detail **Tools tab** (`AgentAvailableTools`) shows the same
  catalog resolved against the agent's actual policy, matching the worker's
  runtime behaviour.
- **Designer chat** (`POST /api/designer/chat`) accepts an optional
  `availableTools` array; the system prompt lists the org's real tool ids so
  `toggle_tool` / `batch_toggle_tools` calls target keys that exist.

Per-agent grants on the Tools page (`ToolGrant` allow/deny rows) remain a
separate, additive system; deny-overrides still wins at execution time.

## 2) Triggers page

- List column: search (name / target / type), status + type filter pills, a
  type icon per row, and a compact schedule summary ("Every 60 min",
  "Cron 0 9 * * 1-5 (Europe/London)", "next in 2 h").
- The duplicate "Scheduled queue" section (a second fetch of the same records
  via `/api/triggers/scheduled`) was replaced by a derived "Up next" strip
  computed from the main list.
- Detail column: **Delete** (two-step confirm; a 409 `TRIGGER_DELETE_BLOCKED`
  from the API is explained inline), "Run now" with pending/success/error
  feedback, a webhook panel with copy-to-clipboard endpoint + API key, and
  delivery history with per-status tones.
- Editor dialog: trigger type is picked from radio cards with descriptions
  (create mode); cron presets (hourly / daily / weekdays / weekly / monthly)
  fill the expression field.
- All display helpers live in one module:
  `admin/src/components/features/triggers/trigger-presentation.ts`
  (previously split and partially duplicated between `pages/triggers/` and
  `components/features/triggers/`). `useDeleteTrigger` joined the triggers
  facade.

## 3) Tools page

- The dedicated filter column is gone; the page is now
  `[search + filters + list] → [detail + agent access]`.
- Search covers label, tool id and description; source/status pills map to
  `/api/mcp/tools` query params; tags collapse into a select.
- The one-row grant matrix was replaced by `ToolAgentAccessPanel`: a vertical
  per-agent list with switches, a granted-count summary and an explicit
  read-only `denied` pill (deny-overrides).
- Schema/transport JSON blocks in the detail drawer are collapsible.

## 4) Design language (second pass, same day)

A follow-up pass replaced the first iteration's card-heavy look with an
explicit set of rules; new work on these surfaces should follow them:

- **One fact, one place.** The trigger type lives in the header (icon +
  label) only; the schedule is a single definition row; status is one pill.
  The former Type/Mode/"Up next"/disabled-pill duplications are gone —
  the list is sorted soonest-next-run so it *is* the queue.
- **Exception-based badges.** A tool row renders a source/transport/status
  badge only when the value deviates from the default
  (builtin / direct / active). A visible badge means "look at me"; 36 rows
  of identical pills mean nothing.
- **One primary action per view.** Trigger detail: "Run now" is the only
  filled button; pause/edit are quiet; delete is a de-emphasised text
  button at the bottom, needing a second click. List columns keep their
  single primary ("New trigger").
- **Flat grouped lists, not stacked cards.** Rows live in one bordered
  container with hairline dividers and a 2px accent bar for selection
  (`divide-y` + `border-l-2`); status is a colour dot in rows, spelled out
  in the detail.
- **Filters: one segmented control + quiet selects.** The glanceable,
  operational dimension (trigger status with counts, tool source) gets the
  `SegmentedControl` primitive (`components/primitives/SegmentedControl.tsx`);
  narrowing dimensions (type, status, tag) collapse into compact selects.
- **Forms ordered by decision weight.** The trigger editor runs
  name → type → target → type-specific config → optional description, with
  the enabled Switch in the footer next to the submit actions.
- Meaningless identifiers are hidden: connector policy keys (registry
  uuids) no longer render in the designer tool picker; builtin ids do,
  because operators grep for them.

## 5) Workflows wired in (same day)

The workflow surfaces were brought up to the same standard and connected to
the trigger/tool/agent machinery:

- **`GET /api/workflows` was broken with real data**: the list view replaced
  the stored graph with `{}`, which `WorkflowGraphSchema` (min 1 step)
  rejects — the endpoint 500'd as soon as one template existed. The list now
  returns the real graph (`api/src/services/workflows.ts`).
- **Workflows page IA**: one workflow list (search, derived status pill)
  with drill-down workflow → installation → run; installations are
  subordinate rows in the template detail instead of a parallel top-level
  list of UUIDs.
- **Installation detail is the operational hub**: facts as a definition
  list (channel resolved to its label), an inline **Add trigger** button
  that opens the same `TriggerEditorDialog` used by the Triggers page
  (pre-targeted at the installation), trigger rows that deep-link to the
  Triggers page, and a run list with status dots, relative time and
  duration. Start-run explains itself when the installation is not active.
- **Run detail** is a step timeline: status dot, type, duration, error;
  payload JSON collapsed by default; skip/block/unblock only render when
  the step state actually allows them; cancel/retry appear per run state.
- **Designer node inspector** edits structured fields instead of raw JSON:
  agent steps get agent/channel/instruction/subject (with an inline warning
  when the channel is missing — the runtime requires it), tool steps get
  their primary arguments (`web_search.query`, `web_fetch.url`,
  `state_get/put.key`…), scheduled/interval triggers get cron/timezone/
  minutes. An "Use earlier step output" panel lists upstream steps as
  ready-to-paste `{{steps.<id>.output}}` binding tokens. Raw JSON remains
  under an "Advanced" disclosure.
- **Authenticated scheduled-trigger provenance**: the agent
  `TriggerEditorDialog` POST cannot supply identity fields itself. The API
  strips `createdByUserId`, `launchOrigin`, and `createdViaTool`, then stamps
  the authenticated org/project/team/user after verifying current team
  membership. Existing REST schedules without that server-owned origin must be
  cancelled and recreated; the scheduler rejects them before run enqueue.
- Template trigger nodes materialise into real installation triggers at
  install time (verified live: scheduled trigger created with correct
  next-run).

## 6) n8n adoptions (same day, third pass)

- **Test run from the designer** (`useWorkflowTestRun`): the header's "Test
  run" persists the graph, reuses/creates an installation, starts a run and
  polls it; per-step status renders on the canvas nodes (step runs map to
  nodes via `stepKey` = graph step id) and the inspector shows the selected
  node's last-run status, error and output.
- **Save-time template validation** (`validateWorkflowGraphSteps`,
  `api/src/services/workflows.ts`): unsupported step types, duplicate step
  ids, unknown tool names, missing/nonexistent agent ids and environment
  steps without a template reference are rejected with a 400
  `WORKFLOW_TEMPLATE_INVALID` listing every issue. Values containing
  `{{ … }}` binding tokens are exempt from literal checks; `channelId` is
  never required (the runtime falls back to the installation channel). The
  designer surfaces save failures in the header and stops autosave from
  re-submitting a rejected graph.
- **Workflow lifecycle events** (`worker/src/control/workflow-run-events.ts`):
  terminal runs enqueue `trigger.event.dispatch` with event types
  `workflow.run.completed` / `workflow.run.failed` (dedupe key
  `workflow-run-event:<runId>:<status>`), so an event trigger listening for
  `workflow.run.failed` implements an n8n-style error workflow with no new
  machinery.
- **Template JSON export/import**
  (`admin/src/components/features/workflows/workflow-transfer.ts`): Export on
  the template detail downloads `{name, description, graph, triggers,
  version}`; Import on the Workflows page validates the file and creates a
  template — the groundwork for a template gallery.

## 7) Known follow-ups

- The designer's provider/model select lists are still hardcoded; the
  inference control plane (`/api/inference/models`) is the natural source once
  routing profiles are wired into agent creation.
- Role-scoped grants (`ToolGrant.roleId`) have no UI yet — the Tools page only
  manages agent-scoped grants.
- `getTriggerConfigRows`/`getScheduleSummary` interpret `config` client-side;
  if new trigger config fields land in `packages/runtime/src/scheduling.ts`,
  update `trigger-presentation.ts` alongside.
