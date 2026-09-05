# API and contracts

Part of [the project boards design](overview.md).

## 7. API and contracts (E)

### 7.1 Routes

Gate legend: **member** = `requireActorContext` + `isProjectAccessibleToActor`;
**admin** = member + `canAdministerProject` (org owner, or `ProjectMember.role
∈ {owner, admin}`); **self** = the caller is the connection's owner.

Boards and columns — `api/src/routes/boards.ts` (replaces `board.ts`):

| Route | Gate | Body / result |
|---|---|---|
| `GET /api/projects/:projectId/boards` | member | `BoardRecord[]`, each with its `columns` — the one read the board tab, settings, Overview and prewarm share |
| `POST /api/projects/:projectId/boards` | admin | `{ name, style?, copyColumnsFromBoardId? }` → `BoardRecord` (201) |
| `PATCH /api/projects/:projectId/boards/:boardId` | admin | `{ name?, style?, filter?, position?, isDefault? }` |
| `DELETE /api/projects/:projectId/boards/:boardId` | admin | `?newDefaultBoardId=` required when deleting the default; refuses the last board (`BOARD_LAST`) |
| `GET /api/projects/:projectId/boards/:boardId/tasks` | member | `{ tasks: BoardTaskRecord[], truncated: boolean }` — placed by the server, ≤500 by `updatedAt desc` |
| `POST …/boards/:boardId/columns` | admin | `{ name, category, position?, stateBindings? }` |
| `PATCH …/boards/:boardId/columns/:columnId` | admin | `{ name?, category?, position?, stateBindings? }` |
| `DELETE …/boards/:boardId/columns/:columnId` | admin | placements cascade; cards fall back to category |

`GET /api/projects/:projectId/board` and `/columns*` are removed in the same
change; every admin caller moves.

Tasks — `api/src/routes/tasks.ts`, unchanged shapes except:

| Route | Change |
|---|---|
| `POST /api/tasks/:taskId/move` | `{ columnId, position? }` unchanged; the column implies the board; new refusals `SOURCE_READ_ONLY` (409), `SOURCE_REJECTED` (409, `{ code, detail }`), `BOARD_PROJECT_MISMATCH` (404 as `COLUMN_NOT_FOUND`) |
| `PATCH /api/tasks/:taskId` | gains `fieldValues?: Record<string, unknown \| null>`; refusals `FIELD_UNKNOWN`, `FIELD_VALUE_INVALID` (400), `SOURCE_READ_ONLY`, `SOURCE_REJECTED` |
| `POST /api/tasks/:taskId/assign` | refusals `SOURCE_READ_ONLY`, `SOURCE_REJECTED`, `ASSIGNEE_NOT_LINKED` |
| `GET /api/tasks`, `GET /api/tasks/:taskId` | `TaskRecord` loses `columnId`/`position`, gains `fieldValues` and `externalLink: { sourceId, provider, externalKey, externalUrl, remoteStateName, remoteAssigneeDisplay, lastInboundAt } \| null` |

Fields — `api/src/routes/task-fields.ts`:

| Route | Gate |
|---|---|
| `GET /api/projects/:projectId/fields` | member |
| `POST /api/projects/:projectId/fields` | admin — `{ name, type, options?, config?, showOnCard? }` |
| `PATCH /api/projects/:projectId/fields/:fieldId` | admin — `{ name?, options?, config?, showOnCard?, position? }` (never `type`) |
| `DELETE /api/projects/:projectId/fields/:fieldId` | admin — `FIELD_IN_USE_BY_SOURCE` |

Connections and sources — `api/src/routes/board-sources/connections.ts`,
`sources.ts`, `webhooks.ts`:

| Route | Gate | Notes |
|---|---|---|
| `GET /api/board-sources/providers` | any active member | registered providers, with `containerKinds` |
| `POST /api/board-sources/connections/:provider/start` | any active member | `{ reauthorizeConnectionId? }` → `{ authorizeUrl }`; mirrors `POST /api/comms/connections/:provider/start` |
| `GET /api/board-sources/connections/:provider/callback` | public | constant HTML page; posts `{ ok, connectionId }` to the opener at a server-resolved origin, or navigates to the stored return section on `single` |
| `POST /api/board-sources/connections/trello/complete` | any active member | `{ token }` submitted once, encrypted, never echoed |
| `GET /api/board-sources/connections` | any active member | the caller's own; org owners additionally see `{ id, provider, owner, status }` of every connection (no scopes, no tokens) so they can see whose credential a source runs under |
| `GET /api/board-sources/connections/:id/containers` | self | `listContainers` |
| `POST /api/board-sources/connections/:id/reauthorize` | self | starts OAuth bound to the connection; on completion every source on it returns to `active` with `nextRunAt = now()` |
| `DELETE /api/board-sources/connections/:id` | self | `CONNECTION_IN_USE` while sources name it; otherwise revokes upstream where the provider supports it and deletes the credential row |
| `GET /api/projects/:projectId/sources` | member | health, freshness, write mode, connection owner's display identity |
| `POST /api/projects/:projectId/sources` | admin + self on `connectionId` | `{ connectionId, container }` → seeds mappings, enqueues `board-source.sync.initial` |
| `GET …/sources/:sourceId` | member | with `stateMapping`, `fieldMappings`, the container's `states`/`fields`/`members` as last described, and identity links |
| `PATCH …/sources/:sourceId` | admin (+ self when changing `connectionId`) | `{ name?, writeMode?, syncWindowDays?, connectionId? }` |
| `PUT …/sources/:sourceId/mappings` | admin | `{ stateMapping, fieldMappings, identityLinks }` — whole document, validated against the last description |
| `POST …/sources/:sourceId/sync` | admin | manual; 1 per source per minute |
| `POST …/sources/:sourceId/pause`, `…/resume`, `…/retry` | admin | explicit health transitions |
| `DELETE …/sources/:sourceId` | admin | removes links and the webhook; tasks stay as native tasks |
| `POST /api/board-sources/webhooks/:provider/:token?` (+ `HEAD`) | public | enqueue only |

### 7.2 Contracts and where they live

- `packages/schemas/src/boards.ts` — `BoardIdSchema`, `BoardRecordSchema`,
  `BoardColumnRecordSchema` (with `stateBindings`), `BoardFilterSchema`,
  `BoardTaskRecordSchema`, the create/update bodies.
- `packages/schemas/src/board-lifecycle.ts` — `ColumnCategorySchema`,
  `statusToCategory`, `categoryToStatus`, `ARCHIVED_STATUSES`.
- `packages/schemas/src/task-fields.ts` — `TaskFieldTypeSchema`,
  `TaskFieldDefinitionRecordSchema`, `TaskFieldOptionSchema`,
  `TaskFieldValuesPatchSchema`.
- `packages/schemas/src/board-sources.ts` — provider/health/write-mode enums,
  the five topics and payloads, `BoardSourceRecordSchema`,
  `BoardSourceConnectionRecordSchema`, `StateMappingSchema`,
  `FieldMappingSchema`, `IdentityLinkSchema`, `TaskExternalLinkRecordSchema`.
- `api/src/contracts/tasks-board.ts` re-exports and loses the board shapes it
  owned; `TaskRecordSchema` gains `fieldValues` and `externalLink`. The admin
  derives its types from these (`architecture.md`: no hand-written DTOs).

### 7.3 Authorization

`canAdministerProject(prisma, viewer, projectId)` joins
`isProjectAccessibleToUser` in `packages/team-admin/src/project-structure.ts`;
`server-context.ts` exposes `requireProjectAdmin(actorContext, projectId,
reply)` beside `requireOwner`. Reads stay on the existing entitlement. Task
mutations keep `requireUserActor` + project access; the new refusals are
service errors mapped in the route, never decided in the route.

`ProjectMember` is Nessie-owned (a project has no UOA counterpart), so gating
on its role creates no second identity authority. The iteration routes keep
`requireOwner` untouched — out of scope, and a separate decision.

### 7.4 Realtime

One content-free event, `board.updated { projectId }`, on the `organization`
scope, published by the sync worker once per job and by the API after a
write-back echo. The admin's board facade invalidates
`taskKeys.forProject(projectId)` and `projectKeys.boards(projectId)` on
receipt; the refetch is entitlement-checked, so a project id reaching a
non-member reveals nothing they can read. This is the `dashboard.updated`
shape. `task.updated` is untouched.

### 7.5 PA tools — each mirrors one route

All `personalAssistantOnly`, `category: 'projects'`, calling the same
`@nessie/team-admin` function the route calls:

| tool | route mirrored | change |
|---|---|---|
| `ticket_board_read` | `GET …/boards` | now lists **every board** with its columns (`boardId`, `columnId`, category, style, whether a column binds external states) |
| `ticket_list` | `GET …/boards/:id/tasks` when `boardId` is given, else `GET /api/tasks?project=` | optional `boardId`; output shows `columnId` only for a board read |
| `ticket_read` | `GET /api/tasks/:id` | adds the external link line and field values |
| `ticket_fields_read` (new, `safe`) | `GET …/fields` | definitions with option ids, so `ticket_update` can set them without guessing |
| `ticket_update` | `PATCH /api/tasks/:id` | gains `fieldValues` |
| `ticket_move`, `ticket_assign`, `ticket_transition` | unchanged routes | same `writeBack` collaborator, refusals in words: *"Jira owns this ticket's status; the source is read-only."* / *"Jira refused: PROJ-123 has no transition to Done from In Review."* |

Board, field and source administration deliberately has **no PA tools** in v1:
they are set up once by an administrator on a settings page, and the PA's job
is the work on the board. `project_create` (Agent Designer) creates the
default board through the shared `defaultBoardCreateData`, so a project made
from chat has the same board as a clicked one.
