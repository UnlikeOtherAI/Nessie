# Custom fields

Part of [the project boards design](overview.md).

## 4. Custom fields (B)

### 4.1 Scope: the project

A field definition belongs to a project. It is what "custom fields per project"
means, it is where an external source lands its fields, and it keeps a task's
fields stable across every board of that project. Organisation-level templates
are a later feature with inheritance semantics nobody has asked for.

### 4.2 Types — seven, each justified

| type | value shape in JSON | why it exists | external fields it receives |
|---|---|---|---|
| `text` | string ≤ 2,000 code points | free-form extras a card needs | Jira text fields, Trello text, GitHub Projects text |
| `number` | finite number | estimates, scores, counts | Linear `estimate`, Jira story-point fields, Projects number |
| `date` | `YYYY-MM-DD` | start/target dates beyond the one deadline | Linear target date, Jira date fields, Projects date |
| `url` | `https://` string | design links, PR links | Jira URL fields |
| `select` | option id | issue type, component, team | Jira issue type / component, Projects single-select, Trello list-type fields |
| `multi_select` | option id[] | labels, tags | Jira labels, Linear labels, GitHub labels, Trello labels |
| `user` | Nessie `UserId` | reviewer, reporter | Jira reporter, Linear creator |

Cut, with the reason: `checkbox` (a two-option `select` until a real case
appears), `agent` (the assignee already takes an agent; a second agent field is
speculative), `rich_text` (the task has `detail`), `relation` (a query
language in disguise). Adding a type later is one enum value, one validator
arm in `task-fields.ts` and one renderer arm in `TaskFieldControl`.

### 4.3 Storage — one JSONB column

```prisma
enum TaskFieldType { text number date url select multi_select user }

model TaskFieldDefinition {
  id              String        @id @default(uuid()) @db.Uuid
  projectId       String        @map("project_id") @db.Uuid
  organizationId  String        @map("organization_id") @db.Uuid
  name            String
  type            TaskFieldType
  position        Int
  showOnCard      Boolean       @default(false) @map("show_on_card")
  /// select / multi_select: [{ id, label, tone, retiredAt? }] — ids are stable,
  /// labels mutable, retired options stay readable and leave every picker.
  /// `tone` is the closed Pill tone set (components/primitives/Pill.tsx).
  options         Json          @default("[]")
  /// number: { min?, max?, decimals? }; text: { maxLength? }. Strict per type.
  config          Json          @default("{}")
  createdByUserId String?       @map("created_by_user_id") @db.Uuid
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  project      Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([projectId, name])
  @@index([projectId, position])
  @@map("task_field_definitions")
}
```

`Task.fieldValues Json @default("{}") @map("field_values")` — `{ "<definitionId>":
<value> }`, absent key = no value. Migration
`20260906110000_task_field_definitions/` adds the table, the column and
`CREATE INDEX tasks_field_values_gin ON tasks USING gin (field_values
jsonb_path_ops);`.

**Verdict against EAV**, in the terms asked for:

- *Query/filter/sort.* The only server-side filter is the board's
  `field` clause — `field_values @> '{"<id>": "<optionId>"}'` for `select`,
  `field_values -> '<id>' ? '<optionId>'` for `multi_select` — both served by the
  GIN index. Sorting by a custom number happens in the client over the ≤500
  cards a board renders; no route sorts by a custom field.
- *Validation.* One writer, `updateProjectTask`, validates the patch against the
  definitions before writing (§4.4). EAV would validate the same way; it does
  not buy typed columns because a `select` value is a string either way.
- *Postgres realities.* The board read is `SELECT … FROM tasks` already; JSONB
  adds no join. The merge is one atomic statement,
  `UPDATE tasks SET field_values = (field_values || $patch) - $cleared`,
  through `$executeRaw` exactly as `reindexColumn` already does. Prisma filters
  JSON by `path` + `equals` / `array_contains` on Postgres. A definition delete
  is `UPDATE tasks SET field_values = field_values - '<id>' WHERE project_id = $1`.

EAV would be a table, an `include` on every task read, and a second place to
keep in step with the definition, for no query this scale needs.

### 4.4 Validation and definition changes

`packages/team-admin/src/task-fields.ts`:

- `validateFieldValuesPatch(definitions, patch)` → typed errors
  `FIELD_UNKNOWN`, `FIELD_VALUE_INVALID { fieldId, reason }`; `user` values are
  checked as active organisation members (the `isOrganizationMember` predicate
  `createProjectTask` already uses); `url` must parse as `https:`; `select`
  ids must be non-retired options.
- **A definition's `type` is immutable.** To change a field's type, create a
  new field. Renames are free (values are keyed by id). Options may be added,
  relabelled by id, or retired; retiring never rewrites values.
- Deleting a definition runs the one `UPDATE … - '<id>'` above in the same
  transaction, and refuses while a source mapping targets it
  (`FIELD_IN_USE_BY_SOURCE`, naming the source).

`updateProjectTask` accepts `fields.fieldValues?: Record<string, unknown |
null>` (a partial merge; `null` clears), `PATCH /api/tasks/:taskId` and
`ticket_update` carry it through unchanged.

### 4.5 Rendering

- **Card** (`KanbanCard.tsx`): definitions with `showOnCard` render as `Pill`s
  in a row under the excerpt, at most three, then `+N`; `select` options use
  their `tone`; `user` renders the person's display name through the resolving
  identity primitive, never a hand-assembled tile.
- **TaskDialog**: a new `TaskFieldsSection.tsx` under Deadline in the right
  column — one `FormField` per definition in `position` order, rendered by
  `TaskFieldControl` (`Input`, `Input type=number`, `Input type=date`, `Input
  type=url`, `Select`, a multi-select built on `Popover` + checkboxes,
  `AssigneePicker` with `options` narrowed to people). Values ride in the
  existing `TaskDraft` so a dismissed dialog keeps them.
- **Board**: the filter in §3.7. **Backlog**: no field columns in v1.

### 4.6 The hook external mapping uses

A source's field mapping (§5.8) targets either a native task field
(`native:priority | native:dueDate | native:storyPoints | native:title |
native:detail`) or `field:<definitionId>`. On first connect the adapter's
`describeContainer` lists the external fields, and the attach flow creates a
definition per default mapping the adapter declares (labels → `multi_select
"Labels"`, Jira issue type → `select "Type"`, Linear estimate → `number
"Estimate"`), reusing an existing definition of the same name and type rather
than duplicating it.
