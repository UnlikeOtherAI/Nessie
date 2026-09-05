# Files, phases, exclusions and risks

Part of [the project boards design](overview.md).

## 8. Files

New:

```
api/prisma/migrations/20260906100000_project_boards/migration.sql
api/prisma/migrations/20260906110000_task_field_definitions/migration.sql
api/prisma/migrations/20260906120000_board_sources/migration.sql
packages/schemas/src/boards.ts · board-lifecycle.ts · task-fields.ts · board-sources.ts
packages/team-admin/src/board-structure.ts · board-placement.ts · task-fields.ts
packages/team-admin/src/board-source-apply.ts · board-source-credential.ts · board-source-writeback.ts · project-administration.ts
packages/board-sources/ · board-source-jira/ · board-source-linear/ · board-source-trello/ · board-source-github/ · board-source-providers/
api/src/routes/boards.ts · task-fields.ts · board-sources/{connections,sources,webhooks}.ts
api/src/services/boards.ts · task-fields.ts · board-sources.ts (re-exports, per the PA-tools rule)
api/src/services/integration-plugin-manifests/board-sources.ts
worker/src/control/board-source-sync.ts · board-source-webhook.ts · board-source-health-dispatch.ts · board-source-webhooks-renew.ts
worker/src/run/pa-tools/ticket-fields.ts
admin/src/facades/boards/hooks.ts (replaces facades/board) · facades/task-fields/hooks.ts · facades/board-sources/hooks.ts
admin/src/components/kanban/BoardSwitcher.tsx · SourceStatusStrip.tsx · ExternalKeyPill.tsx · TaskFieldsSection.tsx · TaskFieldControl.tsx
admin/src/pages/project/settings/BoardsSettingsSection.tsx · BoardColumnsEditor.tsx · BoardCreateDialog.tsx · FieldsSettingsSection.tsx · SourcesSettingsSection.tsx · ConnectSourceDialog.tsx · SourceMappingPanel.tsx
admin/src/pages/settings/connections/ProjectToolConnections.tsx
admin/e2e/navigation/cases/phone-board-switch.mjs
```

Changed: `api/prisma/schema.prisma`; `packages/team-admin/src/project-structure.ts`,
`project-tasks.ts`, `project-task-move.ts`, `project-task-records.ts`;
`packages/runtime/src/builtin-ticket-tools.ts`; `worker/src/run/pa-tools/tickets.ts`;
`worker/src/control/index` wiring and the periodic intervals; `api/src/register-api-routes.ts`;
`api/src/lib/server-context.ts`; `api/src/contracts/tasks-board.ts`;
`packages/schemas/src/realtime-ws.ts` (`board.updated`), `ids.ts` (`BoardIdSchema`);
`packages/mcp-manage/src/apps/app-store-detail.ts` (`setupSurface`);
`admin/src/pages/project/ProjectView.tsx`, `ProjectBoardTab.tsx`,
`ProjectSettingsPage.tsx` (becomes the host); `admin/src/components/kanban/KanbanBoard.tsx`,
`KanbanCard.tsx`, `TaskDialog.tsx`, `kanban-config.ts`;
`admin/src/components/features/projects/ProjectWorkSection.tsx`,
`project-dashboard-data.ts`; `admin/src/navigation/prewarm.ts`;
`admin/src/pages/AppDetailPage.tsx`; `admin/src/lib/query-keys.ts`;
`admin/test/tab-param.test.ts`; `docs/navigation/page-types-and-motion.md` §1;
`docs/standards/comms-connector.md` gains a sibling sentence pointing here, and
`AGENTS.md` → Architecture gains one routing bullet for this document.

Deleted: `api/src/routes/board.ts`, `api/src/services/board.ts`,
`admin/src/facades/board/hooks.ts`.

## 9. Delivery plan (F)

Each phase is one PR, mergeable and useful alone, in dependency order.
**Phase 1 is the smallest thing that is genuinely shippable**: after it a
project has many boards with their own columns, and nothing else in the product
changes.

| # | Phase | Contents | Acceptance |
|---|---|---|---|
| 1 | **Boards as views** | Migration 1; `Board`/`BoardColumn`/`TaskBoardPlacement`; `board-structure.ts`, `board-placement.ts`; moved lifecycle maps; `boards.ts` routes; `canAdministerProject`; PA `ticket_board_read`/`ticket_list` changes; `BoardSwitcher`, `ProjectBoardTab` on the board read, `BoardsSettingsSection` + `BoardColumnsEditor`, Overview links per board; `phone-board-switch`; tab-param table + test | Throwaway-DB migration apply; a project shows its migrated board with existing pins intact; create a second board with different columns, drag the same task on both, both remember; an agent run completing the task moves it to Done on both boards (T3 fixed — pinned test); a project admin who is not org owner can add a column; `ticket_move` still works with a `columnId` from `ticket_board_read`; Playwright screenshots at desktop and phone |
| 2 | **Custom fields** | Migration 2; `TaskFieldDefinition`, `Task.fieldValues` + GIN; `task-fields.ts` (both packages); routes; `TaskFieldsSection`, card chips, `FieldsSettingsSection`; board `field` filter; `ticket_fields_read`, `ticket_update.fieldValues` | Define seven fields of the seven types, set values in the dialog, see chips on the card; a board filtered on a select option shows only matching cards (DB-backed test on the GIN path); deleting a definition clears values (test proves the `- key` runs); type change refused |
| 3 | **Sources core + Linear, read-only** | Migration 3; `@nessie/board-sources` + `board-source-linear` + `board-source-providers`; connection OAuth routes + Connections page group; source routes; sync worker (initial, incremental, sweep, webhook, renew); `applyInboundItem`; health transitions + `board_source_health` alert; `SourcesSettingsSection`, `ConnectSourceDialog`, `SourceMappingPanel`, `SourceStatusStrip`, `ExternalKeyPill`, dialog banner; `board.updated`; App Store manifests + `setupSurface` | Connect Linear, attach a team, see issues on the board within the sync window with correct categories; a state renamed in Linear reflects within the poll interval; a webhook delivery updates a card without a poll; revoking the token in Linear moves the source to `needs_reauthorization` with exactly one alert (DB test on `healthRevision`); a deactivated owner produces `owner_inactive`; the source's tasks are readable by `ticket_read` with the link line; removing the source leaves native tasks |
| 4 | **Write-back (Linear)** | `writeMode`, `board-source-writeback.ts`, the `writeBack` collaborator in move/update/assign, refusals, echo suppression, `stateBindings` on columns, identity links + email matching + People table | In `read_only` a category-changing drag snaps back with the sentence; in `read_write` it changes the Linear state and the webhook echo writes no `TaskEvent` (fingerprint test); an invalid target is refused synchronously; assigning an unlinked user is refused with the remedy; a bound column writes back its bound state |
| 5 | **Jira adapter** | 3LO, `cloudId`, `search/jql` paging, `statusCategory` defaults, transitions resolution, unsigned webhooks with URL token + 30-day renew sweep, `/user/search` email match | Same checks as 3 and 4 against a Jira Cloud site; `JIRA_NO_TRANSITION` surfaces on a workflow that forbids the move; webhook renewal proven by a clock-advanced test |
| 6 | **GitHub adapter** | App JWT + installation tokens, user-to-server link, Issues container, Projects v2 container (GraphQL), `X-Hub-Signature-256`, `projects_v2_item` | An Issues repo and a Projects v2 board each attach and sync; closing an issue in GitHub moves the card to Done; moving a Projects item changes its `Status` |
| 7 | **Trello adapter** | Key + one-shot token flow, lists as states, HEAD-then-POST webhooks with HMAC-SHA1, poll re-read | Attach a board; list moves reflect; a card moved in Nessie moves in Trello |

Phases 5–7 are independent of each other and can be built in parallel once 4
has landed.

## 10. Deliberately not in v1

- **Swimlanes / group-by** on a board. The filter vocabulary is closed; a
  second axis is a later, separate decision.
- **Per-board field visibility** (`showOnCard` is per definition, not per
  board).
- **Comments, attachments and history import.** Comments have their own
  audience upstream (§5.3); attachments need the `FileService` chokepoint and
  quota, a second design.
- **Sprint ↔ iteration sync** (Jira sprints, Linear cycles, Projects
  iteration fields) and Jira Software boards as containers.
- **Creating upstream from Nessie.** A native task on a source board stays
  native; "New task" does not create a Jira issue. The inbound direction is
  what "use them as a data source" asks for.
- **Run-lifecycle write-back.** `updateTaskStatus` on a mirrored task changes
  Nessie's status only. The hook is one `enqueueQueueJob` in
  `applyTaskStatus` behind a source flag; it is not built until a person asks
  for an agent's completion to close a Jira ticket unattended.
- **Ticket tools for shared agents**, and therefore the `requiresApproval`
  gate on external writes they would need.
- **Organisation-level field definitions**, **field types beyond seven**,
  **a query builder**.
- **MCP-backed sources.** Stated in §5.2; the MCP connectors keep their job.
- **A new `ProductSurface` type** (§6.6).
- **Multiple links per task** (one task ↔ one external item).

## 11. Risks and open questions (G)

Each with the default the build proceeds on.

1. **Provider app registration is a deployment prerequisite.** Every adapter
   needs a per-deployment client id/secret (and, for GitHub, an App with a
   private key and webhook secret; for Trello, a Power-Up key and secret).
   *Default:* `NESSIE_BOARD_<PROVIDER>_*` env, unset means unregistered and
   hidden, documented in `docs/deployment.md` in phase 3. Production needs the
   Linear app created before phase 3 ships.
2. **Linear webhook delivery for OAuth apps.** The adapter assumes app-level
   webhooks fire for every authorised workspace, signed with the app's webhook
   secret. *Default:* build the webhook path against that, and rely on the
   adapter-declared 5-minute poll as the fallback, so a wrong assumption costs
   freshness, not correctness. Verify in phase 3 before the PR.
3. **Jira webhooks are unsigned and expire.** *Default:* per-source URL token
   (hashed) plus the renew sweep; if a deployment cannot expose a public
   callback, the poll carries it. Confirm the allowed-callback-domain
   requirement on the Atlassian developer console during phase 5.
4. **Project administrators gate boards.** This widens who can change a
   board from org owners to `ProjectMember.role ∈ {owner, admin}` — the row
   exists and is written, but nothing has enforced it before, so some projects
   may have stale `admin` rows. *Default:* proceed; it is Nessie-owned data and
   an org owner can correct membership.
5. **Email auto-matching of assignees.** Matching a provider's email to
   `User.email` is a read of UOA-mirrored data, but a wrong match assigns work
   to the wrong person. *Default:* exact, case-folded equality against
   **active** members only, recorded as `matchedBy: 'email'` and visible in the
   People table where it can be overridden; never fuzzy.
6. **Dropping `Task.columnId` / `position`.** `TaskRecord` is consumed by the
   admin only (`mobile/` and `ios/` have no reader), but a stale client would
   send `columnId` it no longer receives. *Default:* drop in phase 1; the
   contract is versioned by deploy, and the admin ships in the same PR.
7. **Board size.** `GET /api/tasks` caps at 200 silently; a Jira project can
   have thousands of open issues. *Default:* the board read returns ≤500 by
   `updatedAt desc` with a visible *"Showing the 500 most recently updated"*
   notice, and the initial import bounds done work by `syncWindowDays`. A
   paginated board is not designed here.
8. **Realtime scope for `board.updated`.** No `project` WS scope exists.
   *Default:* organisation scope, content-free (a project id only), refetch
   entitlement-checked — the `dashboard.updated` reasoning.
9. **Push preference for source health.** *Default:* a new
   `pushBoardSourceHealth` key beside `pushTriggerHealth`, generic body,
   cause behind the deep link — not a shared "any capability health"
   preference, which would need its own design.
10. **Rate limits under many sources.** *Default:* one `rate_limited`
    transient with the shared backoff and a per-organisation concurrency cap
    of 2 sync jobs (`NESSIE_BOARD_SOURCE_CONCURRENCY`), following the
    dashboard refresh caps; no per-provider budget accounting in v1.
11. **GitHub App permission scope.** An installation may be scoped to
    selected repositories, so a container the person can see may be outside
    the installation. *Default:* `listContainers` lists only what the
    installation token can reach and says so in the picker's empty state.
12. **BuildMe.** T10's placeholders point at this design. *Default:* leave the
    BuildMe manifest's `column-mapping` control `blocked` until its board API
    exists; when it does, it is a fifth adapter and nothing here changes.
