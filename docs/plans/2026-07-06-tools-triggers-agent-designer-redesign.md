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

## 4) Known follow-ups

- The designer's provider/model select lists are still hardcoded; the
  inference control plane (`/api/inference/models`) is the natural source once
  routing profiles are wired into agent creation.
- Role-scoped grants (`ToolGrant.roleId`) have no UI yet — the Tools page only
  manages agent-scoped grants.
- `getTriggerConfigRows`/`getScheduleSummary` interpret `config` client-side;
  if new trigger config fields land in `packages/runtime/src/scheduling.ts`,
  update `trigger-presentation.ts` alongside.
