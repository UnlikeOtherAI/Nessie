# Surfaces

Part of [the project boards design](overview.md).

## 6. Surfaces (D)

### 6.1 Owning surface and doorways

| Capability | Owning surface | In-context doorways |
|---|---|---|
| Boards | `/projects/:id/board?board=<boardId>` — `BoardSwitcher` (`TabBar`, `role="tablist"`) in `ProjectPageHeader`'s `tabs` slot | header overflow **New board…**, **Board settings…**; Overview → Work section lists every board (`Board · Dev board · Jira board`) instead of one link |
| Columns | `/projects/:id/settings?section=boards&board=<id>` (`BoardsSettingsSection`) | column header menu **Edit columns** (administrators) |
| Custom fields | `/projects/:id/settings?section=fields` (`FieldsSettingsSection`) | `TaskDialog` Fields section → **Manage fields…** (administrators); card chips |
| Sources | `/projects/:id/settings?section=sources[&source=<id>]` (`SourcesSettingsSection`, `SourceMappingPanel`) | board empty state **Connect a source**; header overflow **Connect a source…**; `SourceStatusStrip` pills under the board header; the bell (`board_source_health`) → the source with its remedy; `/apps/:slug` **Use as a project board source**; Overview → Work section line *"Jira needs reconnecting →"* |
| Connections | `/settings/connections` → *Project tools* group | Sources section **Connect** (creates or reuses the caller's connection) |

### 6.2 The Board tab with N boards

`ProjectView` passes `tabs={<BoardSwitcher projectId boards />}` to
`ProjectPageHeader` when `tab === 'board'`. `BoardSwitcher` is the shared
`TabBar` with one item per board in `position` order, driven by
`useTabParam('board', boardIds, defaultBoardId)` — linkable, refresh-safe,
never a history entry; an unknown or absent `?board=` reads as the default
board, so an old bookmark degrades to the board the project opens on. The
host/param table in `docs/navigation/page-types-and-motion.md` §1 and
`admin/test/tab-param.test.ts` gain the row:

| host | param | values |
| a project board (`ProjectBoardTab`) | `board` | one per board of the project (default: the project's default board) |

Under the header, when the project has sources: `SourceStatusStrip` — one
`Pill` per source, `Jira PROJ · synced 2 min ago` in the neutral tone, or the
health state's label in `warning`/`danger` with the remedy verb, linking to the
source's settings page. It answers "is what I am looking at current?", which is
the decision a person makes before dragging.

`KanbanBoard` is unchanged in shape: it receives the board's columns and
`BoardTaskRecord[]` (already placed by the server) and only groups by
`columnId`. `placeTask` and `statusToCategory` leave `kanban-config.ts`.

### 6.3 Settings

`ProjectSettingsPage` (297 lines today) becomes a host of three sections
selected by `useTabParam('section', ['boards','fields','sources'], 'boards')`
rendered as a `TabBar` at the top of the `PageBody`, each section its own file:

- `admin/src/pages/project/settings/BoardsSettingsSection.tsx` — a `RowList`
  of boards (name, style pill, default marker, column count; **Delete** refuses
  the last board and asks which board becomes default when deleting the
  default); **New board** opens `BoardCreateDialog` (`Dialog`: name, style,
  *Start with the default columns* / *Copy columns from …*). Selecting a row
  (`?board=`) shows the board's name, style, filter (`sources` choice +
  optional field/option narrowing) and `BoardColumnsEditor` — the existing
  `ColumnRow` UI moved here, each row gaining the **Shows external states…**
  multi-select when a source exists.
- `FieldsSettingsSection.tsx` — definitions as rows (name, type, *Show on
  card* toggle, options editor for select types, delete with the
  `FIELD_IN_USE_BY_SOURCE` refusal in words); **Add field** row.
- `SourcesSettingsSection.tsx` — connected sources as rows (provider glyph,
  name, health pill + remedy button, freshness, write-mode pill); **Connect a
  source** opens `ConnectSourceDialog`: provider picker (registered providers
  only) → OAuth in a popup on `split` / full-page redirect on `single` (the
  comms flow) → container picker from `listContainers` → attach. Selecting a
  row (`?source=`) renders `SourceMappingPanel.tsx`: **States**, **Fields**,
  **People** tables (§5.8), **Write mode** as a `TabBar` radiogroup with the
  copy *"Read only: Jira decides. Read & write: moving a card here moves it in
  Jira, under <owner>'s account."*, **Sync now**, **Pause / Resume**,
  **Remove** (`ConfirmDialog`: *"Its tickets stay on the board as ordinary
  tasks and stop updating."*).

Non-administrators see the sections read-only with the existing sentence
("Only project administrators can change …").

### 6.4 Cards and the dialog

- **External item on a card**: where the project pill sits today, an
  `ExternalKeyPill` — provider glyph (Font Awesome brand set through the shared
  icon primitive) + `PROJ-123`; click opens `externalUrl` in a new tab with
  `noopener`, `stopPropagation` so the dialog does not also open. An unmapped
  assignee renders as a muted `J. Doe · Jira` pill in place of the assignee
  pill. Field chips per §4.5.
- **`TaskDialog`**: a `Notice` at the top of an external task — *Linked to
  Jira PROJ-123 · synced 2 min ago · Open in Jira*; in `read_only` the
  source-owned controls are disabled with a `FieldLabel` hint *Owned by Jira*
  (the scoped-settings rule: greyed and named, never hidden). `TaskFieldsSection`
  per §4.5.

### 6.5 Empty states and copy

| Where | Copy | Action |
|---|---|---|
| Board with no columns | *This board has no columns yet.* | **Add columns** → settings |
| Board whose filter matches nothing (native) | *Nothing on this board. New tasks appear in the first column.* | **New task** |
| Source board, first sync running | *Bringing in Jira PROJ — first sync running.* | — (pill shows progress) |
| Source board, synced, nothing matches | *Connected to Jira PROJ. No issues match this board's columns yet.* | **Board settings** |
| Sources section, none | *Connect Jira, Linear, Trello or GitHub to bring their work onto this project's boards.* | **Connect a source** |
| Sources section, no provider registered on this deployment | *No project tools are configured on this deployment. An operator sets `NESSIE_BOARD_*` to enable one.* | — |
| Fields section, none | *No custom fields. Add one to track anything a task needs beyond title, priority and deadline.* | **Add field** |

Never used: "integration", "sync engine", "data source" as user-facing nouns —
the product says **source**, **board**, **field**, **connection**.

### 6.6 The App Store and the plugin manifest

Each provider gets a first-party manifest in
`api/src/services/integration-plugin-manifests/board-sources.ts` with two
install entries: the existing `remote_mcp_oauth` (Linear, Atlassian, GitHub —
"for agents in conversation") and `native_data_source` — *"Connect from a
project's Settings → Sources; work appears on the project's boards"*. Trello,
which has no MCP row, gets a first-party `McpCatalogEntry` with
`distribution: builtin` and no transport, so `/apps` lists it as one app like
the rest (app-store.md: one row is one app, never a second catalogue).
`IntegratedProduct` rows are seeded with `category: project_management`,
`defaultInstallState: native`, linked by `mcpCatalogEntryId`.

`AppDetailPage` gains one action, **Use as a project board source**, when the
detail response carries `setupSurface: { kind: 'project_sources', provider }`
— decided **server-side** in `app-store-detail.ts` from the manifest's install
modes and the registry (the store reads a decision). It opens a project picker
(`Popover`, the caller's administrable projects) and navigates to
`/projects/:id/settings?section=sources&connect=<provider>`, an intent the
section consumes once (`useConsumedIntent`, as `?connect=true` on the app page
does). The same `setupSurface` shape is the "configure in settings" affordance
the scoped-settings plan recorded as not done for Browserbase; it lands here
with one consumer and Browserbase can adopt it.

A new `ProductSurface` type is deliberately **not** added: the Sources picker
reads the env-driven registry, and the app page reads the manifest it already
has. A surface type would have been a third statement of the same fact.

### 6.7 Phone

- The switcher scrolls its own track inside the header (`TabBar` never calls
  `scrollIntoView`); `KanbanBoard`'s existing column paging handles narrow
  viewports; the `SourceStatusStrip` wraps.
- Settings sections stack; the mapping tables become one row per state with
  the picker below the name (`RowList` already does this).
- Source connect on `single` is a full-page redirect through the same
  server-authored OAuth state; the callback page is the constant HTML page
  that posts to its opener on `split` and navigates back to
  `?section=sources` on `single` — the app-store callback rule, never a
  caller-supplied return URL.
- New navigation case `admin/e2e/navigation/cases/phone-board-switch.mjs`,
  modelled on `phone-tab-switch.mjs`: switching `?board=` animates no
  navigation layer and moves neither region; registered in `cases/index.mjs`.
  `phone-push`, `phone-back` and `phone-cold-start` are unaffected because
  the project's route pattern does not change.

### 6.8 Navigation registrations

- `surfaces.ts` and `prewarm.ts`: the project pattern is unchanged; prewarm
  fetches `GET /api/projects/:id/boards` instead of `/board`.
- `useTabParam` rows: `board` on the board tab, `section` and `source` on
  settings (`source` is a selection inside a section, the `agentTab` precedent
  for a named param).
- Every dialog here is `Dialog`/`ConfirmDialog` on `useOverlay`; the project
  picker is `Popover`; nothing new is added to the allowlists.
