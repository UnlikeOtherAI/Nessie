# Project boards: many boards, custom fields, external sources

**Date:** 2026-09-05 · **Status:** built (§12 records the as-built deltas)
**Owning surfaces:** Project → **Board** (`/projects/:projectId/board?board=`),
Project → **Settings** (`/projects/:projectId/settings?section=boards|fields|sources`),
and the per-user **Connections** page for the credentials.
**Supersedes, in part:** [2026-06-11-project-board-settings.md](../2026-06-11-project-board-settings.md)
(one board per project, `Project.boardStyle`, `Task.columnId`) — its core
invariant survives unchanged; its storage shape does not.

The owner asked for three things in one sentence: *connect Jira, Linear,
Trello, GitHub Projects or Issues or other systems directly into Projects and
use them as a data source for the project board; custom columns per project
and custom fields; multiple boards per project.* They are one design, because
each constrains the others: an external system can only feed a board if a
board is a **view** over a pool of work rather than a bucket that owns it;
custom fields are what external fields land in; and per-board columns are what
external states map onto.

## 0. The one-paragraph version

A **board is a saved view over its project's task pool**, never a container:
`Board` owns a name, a style, an ordered set of `BoardColumn`s (each still
mapped to one of the four lifecycle categories) and a closed filter; a task's
placement on a given board is a `TaskBoardPlacement` row written only by a
drag, and `Task.status` stays the one lifecycle truth the worker drives. **Custom
fields** are project-scoped definitions with a seven-type vocabulary, stored as
one validated JSONB column on `Task`, keyed by definition id. **External
systems** reach a board as **native provider adapters** in the mould of
`@nessie/comms-connect` — the vendors' own REST/GraphQL, webhooks and delta
cursors through `safeFetch`, never through the MCP servers (whose OAuth tokens
are resource-bound to the MCP endpoint and which have no cursors, no webhooks
and no stable schema). Items are **mirrored into ordinary `Task` rows** with a
`TaskExternalLink`, so agents, assignments, approvals, search, the PA's
`ticket_*` tools and the disclosure sink all work on them unchanged. A source
connects under one person's credential, is `read_only` until a project
administrator flips it, and when `read_write`, a drag writes to the vendor
**synchronously inside the request** and the mirror is rewritten from the
vendor's echo — the same rule the UOA rename follows. A source that stops
working owns how a person finds out, exactly as
[capability-health-alerts.md](../../standards/capability-health-alerts.md) says.

## 1. What is true today

Established by reading code, not assumed.

**T1 — one board per project, stored as a style plus a flat column list.**
`Project.boardStyle` (`kanban | scrum`), `BoardColumn { projectId, name,
category, position }`, `Task.columnId` (FK, `SetNull`) and `Task.position`
(`api/prisma/schema.prisma` 1435–1490, 3840–3880). `getProjectBoard`
(`api/src/services/board.ts`) lazily seeds the four default columns; project
creation seeds them through `defaultColumnCreateData` in
`packages/team-admin/src/project-structure.ts`, shared with the Agent
Designer's `project_create`.

**T2 — status is the lifecycle truth; column placement is a pin over it.**
`moveProjectTaskToColumn` (`packages/team-admin/src/project-task-move.ts`)
maps the destination column's category to a `TaskStatus` through
`CATEGORY_TO_STATUS`, validates it against `VALID_TRANSITIONS`, writes
`columnId` + `status` in one transaction, auto-assigns the actor on a move into
`in_progress`, and reindexes positions. The worker only ever writes `status`
(`worker/src/run/execute/lifecycle.ts` `updateTaskStatus`,
`run-suspend.ts` → `awaiting_approval`); it never touches `columnId`.

**T3 — the client resolves placement, and its rule has a latent bug.**
`placeTask` (`admin/src/components/kanban/kanban-config.ts`) returns the pinned
column whenever *that column still exists*, and only falls back to "first column
of the status's category" when there is no valid pin. It does not check that
the pinned column's category still matches the status. A task a person dragged
into *In progress* that an agent run then completes stays rendered in *In
progress* while its status is `done`. §3.3 fixes this as part of generalising
the rule.

**T4 — every board mutation is organisation-owner-gated; task mutations are
member-gated.** `api/src/routes/board.ts` uses `requireOwner` on
`PATCH /board`, `POST/PATCH/DELETE /columns`; `api/src/routes/tasks.ts` uses
`requireUserActor` + `listAccessibleProjectIds`. `ProjectMember.role`
(`owner | admin | member | viewer`) exists, is written as `owner` for the
creator, and gates nothing on the board today.

**T5 — the PA already mirrors the board routes.** `ticket_list / read /
board_read / create / update / assign / move / transition / iteration_set /
archive_done` (`packages/runtime/src/builtin-ticket-tools.ts`,
`worker/src/run/pa-tools/tickets.ts`) call the same `@nessie/team-admin`
functions the routes call, stamp `project:` scopes on the disclosure sink for
non-owners, and are `personalAssistantOnly`. `ticket_board_read` reads
`boardColumn` directly by `projectId`.

**T6 — there is no custom-field concept anywhere.** `customField |
custom_field | fieldValue` have zero hits outside this document.

**T7 — the MCP path cannot be a sync transport.** The curated Linear
(`https://mcp.linear.app/mcp`) and Atlassian (`https://mcp.atlassian.com/v1/sse`)
entries in `packages/mcp-manage/src/library.ts` sign in through dynamic OAuth,
and `mcp-oauth-completion.ts` binds the token to the MCP server URL per
RFC 8707 (`resource` on both legs). That token is not accepted by
`api.linear.app/graphql` or `api.atlassian.com`. `callInstanceTool`
(`mcp-instance-call.ts`) opens one connection per call and closes it.

**T8 — two precedents exist for "somebody else's data, refreshed".**
`@nessie/comms-connect` (per-user OAuth connections, encrypted credential row,
resumable `CommsSyncJob` checkpoints, adapter-declared polling, webhooks at
`/api/comms/webhooks/:provider`, owner-active gate in
`worker/src/control/comms-sync.ts`) and Live Data Dashboards
(`DashboardDataSource` with `authorityUserId`, `accessMode: delegated`,
`nextRunAt/claimedAt` claim, `consecutiveFailures` + capped backoff,
`lastErrorCode` stable codes, `secret_dashboard_*` refs minted once,
`fetchDashboardSource` as the one `safeFetch` chokepoint). §5.12 says which
parts of each this design takes.

**T9 — navigation and design-system facts this design sits on.**
`/projects/:id` and its six section siblings are one `tabHost` identity
(`admin/src/navigation/surfaces.ts` 216–228); sub-strips are `useTabParam`
(`page-types-and-motion.md` §1, host/param table); every single-select strip
is `TabBar`; modals are `Dialog`, drawers `Sheet`; `ProjectPageHeader` already
has an unused `tabs` slot; `ScreenHeader`'s subtitle may carry "a capability
state"; `EmptyState` takes one action slot. `task.updated` is published on the
WS transport but nothing in `admin/` subscribes to it — the board refetches on
mutation.

**T10 — BuildMe already reserved the words.** `BuildMeProjectHandoffIntent`
has `board_source_discovery`, its manifest lists a `project_board` card
"Board source readiness" and a *blocked* `column-mapping` control, and
`push-surface-presence.ts` knows a `project_board` surface. Nothing behind them
exists. This design is what they were waiting for; BuildMe becomes a fifth
adapter in §5.4 when its API exists.

## 2. Decisions at a glance

| Question | Decision | Rejected | Why |
|---|---|---|---|
| A board is a container or a view | **View** over the project's task pool | Container (task belongs to one board) | A container forks the pool per board, breaks the worker's status-driven placement, and makes "Jira board + team board over the same tickets" impossible. Deleting a view deletes no work. |
| Where per-board placement lives | `TaskBoardPlacement (taskId, boardId) → columnId, position` | Keep `Task.columnId` as the default board's pin | A single pin cannot express two `in_progress` columns on two boards. The table is one row per drag, nothing more. |
| `Project.boardStyle` | Moves to `Board.style`; column dropped | Keep as the default board's style | Two answers to one question. |
| `ColumnCategory` | Unchanged; every column on every board maps to one | Free-form columns with a status picker | The four buckets are what the worker, approvals and transitions drive; a board with no column for a category simply does not show that work. |
| Custom-field scope | **Project** | Organisation, board | Org needs inheritance semantics nobody asked for; board-scoped fields vanish when the same task is viewed on another board. |
| Field types | `text number date url select multi_select user` | + `checkbox`, `agent`, `rich_text`, `relation` | Seven cover Jira/Linear/GitHub/Trello's exportable fields; each extra type is a renderer, a validator and a mapping arm. |
| Field storage | One JSONB column `tasks.field_values`, keyed by definition id, GIN-indexed | EAV rows | The board reads whole tasks already; the only server-side filter needed is select-value containment, which GIN serves; EAV adds a table, an include and a reindex per card for no query it uniquely enables at ≤500 cards. |
| Transport to Jira/Linear/Trello/GitHub | **Native adapters** on the vendors' REST/GraphQL via `safeFetch` | MCP connector; vendor SDKs | T7: MCP tokens are resource-bound, MCP has no cursors/webhooks/stable schema, and one connection per call; SDKs use global `fetch`, which the egress lint bans. |
| Sync model | **Mirror into `Task`** + `TaskExternalLink` | Separate `ExternalItem` projected onto the board; live query-through | Everything that already works on `Task` (agents, runs, approvals, search, PA tools, disclosure) works on a mirrored item for free; a second model forks all of it; live query dies with the provider and is unreachable to agents. |
| Write-back | Source-level `writeMode` (`read_only` default, `read_write`); writes are **synchronous in the person's request**, mirror rewritten from the vendor's echo | Async job with local revert; per-field direction matrix | A refused Jira transition must snap the drag back with the reason, not surface a toast a minute later. Per-field matrices are speculative. |
| Agent-initiated external writes | Only through the PA, acting as the person, mirroring the button (no approval gate); unattended runs refuse; the run lifecycle never writes back in v1 | `requiresApproval` on ticket tools | A person's own click has no gate, and the PA mirrors it (personal-assistant-tools.md). The person-controlled gate is `writeMode`. Shared agents have no ticket tools today. |
| State mapping | Source maps external state → **category**; a board column may additionally **bind** specific external states | Per-board state → column mapping only | Category keeps the lifecycle truth board-independent; a binding is what lets "Code review" and "QA" be two Review columns and makes write-back precise. |
| Assignee identity | `BoardSourceIdentityLink (provider tenant, externalUserId) → userId \| agentId`; matched by exact email where the provider exposes it, else manual | Creating local users; storing provider emails | UOA owns identity. A link row is a binding key, the same kind as `User.uoaSub`. |
| Connection scope | Credential is **per person** (`BoardSourceConnection`, org-tenanted); a source is **per project** and names the connection it runs under | Org-wide service credential | Every provider here delegates a human's authority (Jira 3LO, Linear actor=user, Trello user token, GitHub user-to-server); the dashboard precedent already made "fetched under one visible authority" the model. |
| Reuse of Dashboards | Take its **security decisions** (minted refs, visible authority, claim/backoff, stable error codes, one fetch chokepoint), not its tables | Extend `DashboardDataSource` | A dashboard source yields immutable read-only datasets; a board needs mutable, row-identity-preserving, bi-directional mirrors. |
| Board switcher | `TabBar` in `ProjectPageHeader`'s `tabs` slot, driven by `useTabParam('board', …)` | A route per board (`/boards/:boardId`) | Boards are tabs of one screen; the param pattern is the documented one and needs no registry depth. |
| Who administers boards, fields, sources | Org owner **or** `ProjectMember.role ∈ {owner, admin}` via one shared predicate | Keep `requireOwner` | With N boards per project, needing an organisation owner to rename a column is unworkable; the project-owner row already exists. |


## Table of Contents

The design is one argument in seven parts; each chapter is authoritative for its
own area, and this page is the map. Section numbers are stable — a reference to
"§5.7" means section 5.7, wherever it now lives.

- **[Boards](boards.md)** — §3. A board is a view, not a container: the model,
  the placement rule and the bug moving it server-side fixed, the migration, and
  what changes in the shared task modules.
- **[Custom fields](custom-fields.md)** — §4. Project-scoped definitions, seven
  types, one JSONB column, and the verdict against EAV in the terms it was asked
  in.
- **[External sources](external-sources.md)** — §5. The per-provider transport
  verdict, why MCP is the wrong shape for sync, the mirror-into-`Task` model,
  the adapter contract, inbound sync, write-back, mapping, identity, health and
  egress.
- **[Surfaces](surfaces.md)** — §6. The owning surface and every doorway, the
  board tab with N boards, settings, cards, empty-state copy, the App Store and
  the phone.
- **[API and contracts](api-and-contracts.md)** — §7. Route tables and their
  gates, where each contract lives, authorization, realtime, and the personal
  assistant tools that mirror them.
- **[Delivery](delivery.md)** — §8–§11. The file list, the seven phases with
  their acceptance checks, what is deliberately not in v1, and the risks with
  the default each proceeds on.
- **[As built](as-built.md)** — §12. Where the code differs from this design,
  and the per-vendor assumptions that cannot be checked without a registered
  app. **Read this before treating any chapter as a description of the code.**
