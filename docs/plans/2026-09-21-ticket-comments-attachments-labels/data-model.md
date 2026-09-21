# Data model

Part of [ticket comments, attachments and labels](overview.md).

## 1. Data model

### 1.1 Identity rule, stated once

People are referenced by `User.id` (the row UOA's `uoaSub` binds), agents by
`Agent.id`. **No table below holds a person's name, email or avatar.** The one
display string that is allowed is provider data about a provider user who has
no Nessie account (`externalAuthorDisplay`), the exact precedent of
`TaskExternalLink.remoteAssigneeDisplay`. The client resolves a `userId`
through the users directory (`ActorName`, `UserAvatar`) and an `agentId`
through `AgentIdentityProvider`.

### 1.2 Prisma models

Add to `api/prisma/schema.prisma` beside `TaskExternalLink` (~line 2172).

```prisma
enum TaskExternalAssetKind   { file inline_image link }
enum TaskExternalAssetStatus { pending stored failed link }

/// A project's label. `sourceId`/`externalId` are set when a board source
/// owns it (Linear team label, GitHub label, …); a label a person made in
/// Nessie has both null and is "Nessie-only" on a mirrored ticket (§2.2).
model TaskLabel {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  projectId       String   @map("project_id") @db.Uuid
  name            String
  /// lower(trim(name)); the uniqueness key, so "Bug" and "bug" are one label.
  normalizedName  String   @map("normalized_name")
  /// `#rrggbb`, lower-case. Data, not a theme token (design-system carve-out).
  color           String   @default("#6b7280")
  sourceId        String?  @map("source_id") @db.Uuid
  externalId      String?  @map("external_id")
  createdByUserId String?  @map("created_by_user_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  source       BoardSource?  @relation(fields: [sourceId], references: [id], onDelete: SetNull)
  links        TaskLabelLink[]

  @@unique([projectId, normalizedName])
  @@unique([sourceId, externalId])
  @@index([projectId, name])
  @@map("task_labels")
}

model TaskLabelLink {
  taskId    String   @map("task_id") @db.Uuid
  labelId   String   @map("label_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")

  task  Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  label TaskLabel @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@id([taskId, labelId])
  @@index([labelId])
  @@map("task_label_links")
}

/// One comment on a ticket. Exactly one of `authorUserId` / `authorAgentId`
/// is set for a comment written in Nessie; both are null for an imported
/// comment whose author no identity link resolves, which then carries the
/// provider's own display data. Soft-deleted: `deletedAt` set, `body` blanked.
model TaskComment {
  id                       String    @id @default(uuid()) @db.Uuid
  organizationId           String    @map("organization_id") @db.Uuid
  taskId                   String    @map("task_id") @db.Uuid
  authorUserId             String?   @map("author_user_id") @db.Uuid
  authorAgentId            String?   @map("author_agent_id") @db.Uuid
  externalAuthorExternalId String?   @map("external_author_external_id")
  externalAuthorDisplay    String?   @map("external_author_display")
  /// Markdown. Images are `![alt](/api/attachments/<id>)` (§1.5).
  body                     String    @db.Text
  sourceId                 String?   @map("source_id") @db.Uuid
  externalId               String?   @map("external_id")
  externalUrl              String?   @map("external_url")
  parentExternalId         String?   @map("parent_external_id")
  externalUpdatedAt        DateTime? @map("external_updated_at")
  editedAt                 DateTime? @map("edited_at")
  deletedAt                DateTime? @map("deleted_at")
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  task         Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  authorUser   User?        @relation("TaskCommentAuthor", fields: [authorUserId], references: [id], onDelete: SetNull)
  authorAgent  Agent?       @relation("TaskCommentAgentAuthor", fields: [authorAgentId], references: [id], onDelete: SetNull)
  source       BoardSource? @relation(fields: [sourceId], references: [id], onDelete: SetNull)

  @@unique([sourceId, externalId])
  @@index([taskId, createdAt])
  @@map("task_comments")
}

/// A provider file or link the sync saw on an issue or in its text. The
/// idempotency key for re-sync and the place a failed fetch is remembered.
/// `attachmentId` is the stored copy (app-enforced pointer, like every other
/// Attachment link); null while `pending`/`failed`, always null for `link`.
model TaskExternalAsset {
  id             String                  @id @default(uuid()) @db.Uuid
  organizationId String                  @map("organization_id") @db.Uuid
  taskId         String                  @map("task_id") @db.Uuid
  taskCommentId  String?                 @map("task_comment_id") @db.Uuid
  sourceId       String                  @map("source_id") @db.Uuid
  externalUrl    String                  @map("external_url")
  externalId     String?                 @map("external_id")
  kind           TaskExternalAssetKind
  status         TaskExternalAssetStatus @default(pending)
  title          String?
  attachmentId   String?                 @map("attachment_id") @db.Uuid
  attempts       Int                     @default(0)
  lastError      String?                 @map("last_error")
  createdAt      DateTime                @default(now()) @map("created_at")
  updatedAt      DateTime                @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  task         Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  source       BoardSource  @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@unique([sourceId, externalUrl])
  @@index([taskId])
  @@index([status, updatedAt])
  @@map("task_external_assets")
}
```

Changes to existing models:

```prisma
model Attachment {
  // … existing columns …
  /// App-enforced pointers, exactly like `messageId`: a file on a ticket, and
  /// optionally the comment it was posted with. Never both null once linked to
  /// a comment (a comment attachment is also a task attachment).
  taskId        String? @map("task_id") @db.Uuid
  taskCommentId String? @map("task_comment_id") @db.Uuid
  @@index([taskId])
  @@index([taskCommentId])
}

model Task {
  labels         TaskLabelLink[]
  comments       TaskComment[]
  externalAssets TaskExternalAsset[]
}

model BoardSource {
  labels   TaskLabel[]
  comments TaskComment[]
  assets   TaskExternalAsset[]
}

model Project      { taskLabels TaskLabel[] }
model Organization { taskLabels TaskLabel[]  taskComments TaskComment[]  taskExternalAssets TaskExternalAsset[] }
model User         { taskCommentsAuthored TaskComment[] @relation("TaskCommentAuthor") }
model Agent        { taskCommentsAuthored TaskComment[] @relation("TaskCommentAgentAuthor") }
```

`Task.detail` is unchanged: it is, and always was, Markdown-or-plain text.
Nothing adds a format column — plain text is valid Markdown, and Linear
already hands over Markdown.

### 1.3 Migration `20260921120000_task_labels_comments_attachments`

Hand-written SQL, immutable once committed (build-and-release standard). In
order:

1. `CREATE TYPE` the two enums; `CREATE TABLE task_labels`, `task_label_links`,
   `task_comments`, `task_external_assets` with the indexes above.
2. `ALTER TABLE attachments ADD COLUMN task_id uuid, ADD COLUMN task_comment_id uuid;`
   plus the two indexes. No FK (app-enforced, the `message_id` precedent).
3. `ALTER TABLE task_comments ADD CONSTRAINT task_comments_one_author CHECK
   (NOT (author_user_id IS NOT NULL AND author_agent_id IS NOT NULL));`
4. **Convert the label field that sources created.** For every
   `board_sources` row whose `field_mappings` contains an entry with
   `externalKey = 'labels'` and `target LIKE 'field:%'`, a `DO $$ … $$` block:
   - for each option of that definition, `INSERT INTO task_labels (…, name,
     normalized_name, color, source_id, external_id) VALUES (…, option.label,
     lower(trim(option.label)), '#6b7280', source.id, option.id)
     ON CONFLICT (project_id, normalized_name) DO UPDATE SET source_id =
     EXCLUDED.source_id, external_id = EXCLUDED.external_id`;
   - for every task of the project with `field_values ? definition_id`,
     insert one `task_label_links` row per option id in that array,
     resolved through `task_labels(source_id, external_id)`;
   - rewrite that mapping entry's `target` to `'native:labels'` (a jsonb
     array rewrite, keeping order);
   - `UPDATE tasks SET field_values = field_values - definition_id WHERE
     project_id = …`; `DELETE FROM task_field_definitions WHERE id = …`.
   Production is greenfield, so this converts rather than preserves, but it
   converts completely — a person's earlier label choices survive as links.
5. Nothing on `task_events` (the lint warns on index creation there; none is
   added).

Verify on a throwaway pgvector database from a clean container **and** on the
upgrade baseline (`upgrade-path` CI job); the DO block must be a no-op on a
database with no sources.

### 1.4 Wire shapes — `packages/schemas`

New files, each `export * from` in `packages/schemas/src/index.ts`. Naming
follows the package: `XxxRecordSchema`, `Create/UpdateXxxBodySchema`,
`type Xxx = z.infer<…>`.

```ts
// packages/schemas/src/task-labels.ts
export const LabelColorSchema = z.string().regex(/^#[0-9a-f]{6}$/)
export const LABEL_PALETTE = [
  '#6b7280', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#a16207',
] as const
export const TaskLabelNameSchema = NonEmptyStringSchema.max(60)

export const TaskLabelSummarySchema = z.object({
  id: z.string().uuid(),
  name: TaskLabelNameSchema,
  color: LabelColorSchema,
  /** True when a board source owns it; the dialog and the tools say so. */
  external: z.boolean(),
})
export const TaskLabelRecordSchema = TaskLabelSummarySchema.extend({
  projectId: ProjectIdSchema,
  source: z.object({
    sourceId: z.string().uuid(),
    provider: BoardSourceProviderSchema,
    externalId: z.string(),
  }).nullable(),
  /** Present on the settings read only. */
  taskCount: z.number().int().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export const CreateTaskLabelBodySchema = z.object({
  name: TaskLabelNameSchema,
  color: LabelColorSchema.optional(),
}).strict()
export const UpdateTaskLabelBodySchema = z.object({
  name: TaskLabelNameSchema.optional(),
  color: LabelColorSchema.optional(),
}).strict()
/** Replace-set semantics on a task; order is irrelevant, duplicates refused. */
export const TaskLabelIdsSchema = z.array(z.string().uuid()).max(50)
export const normalizeLabelName = (name: string): string => name.trim().toLowerCase()
```

```ts
// packages/schemas/src/task-comments.ts
export const TaskCommentAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }),
  z.object({ kind: z.literal('agent'), agentId: AgentIdSchema }),
  z.object({
    kind: z.literal('external'),
    provider: BoardSourceProviderSchema,
    externalUserId: z.string(),
    displayName: z.string(),
  }),
])
export const TASK_COMMENT_MAX_CHARS = 20_000
export const TaskCommentRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: TaskIdSchema,
  author: TaskCommentAuthorSchema,
  /** Markdown; empty once deleted (deleted rows are not listed). */
  body: z.string(),
  attachments: z.array(TaskAttachmentRecordSchema),
  external: z.object({
    sourceId: z.string().uuid(),
    provider: BoardSourceProviderSchema,
    externalId: z.string(),
    url: z.string().nullable(),
  }).nullable(),
  /** Decided server-side from the author rule and the source's write mode. */
  viewerCanEdit: z.boolean(),
  viewerCanDelete: z.boolean(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
})
export const TaskCommentListSchema = z.object({
  comments: z.array(TaskCommentRecordSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
})
export const CreateTaskCommentBodySchema = z.object({
  body: z.string().min(1).max(TASK_COMMENT_MAX_CHARS),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
}).strict()
export const UpdateTaskCommentBodySchema = z.object({
  body: z.string().min(1).max(TASK_COMMENT_MAX_CHARS),
}).strict()
```

```ts
// packages/schemas/src/task-attachments.ts
export const TaskAttachmentRecordSchema = z.object({
  id: z.string().uuid(),                       // the Attachment id
  taskId: TaskIdSchema,
  commentId: z.string().uuid().nullable(),
  filename: z.string(),
  mime: z.string(),
  kind: z.string(),                            // FileService kind
  sizeBytes: z.string(),                       // BigInt at the boundary
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasThumbnail: z.boolean(),
  uploaderUserId: UserIdSchema.nullable(),
  downloadPath: z.string(),                    // `/api/attachments/<id>`
  thumbnailPath: z.string().nullable(),
  /** Referenced from the description or a comment body (`![…](downloadPath)`). */
  inline: z.boolean(),
  external: z.object({
    sourceId: z.string().uuid(),
    provider: BoardSourceProviderSchema,
    externalUrl: z.string(),
    title: z.string().nullable(),
    status: z.enum(['stored', 'failed', 'link']),
  }).nullable(),
  createdAt: TimestampSchema,
})
export const TaskAttachmentListSchema = z.object({
  attachments: z.array(TaskAttachmentRecordSchema),
})
export const LinkTaskAttachmentsBodySchema = z.object({
  attachmentIds: z.array(z.string().uuid()).min(1).max(10),
}).strict()
/** The one URL form inline images take; the renderer and editor match it. */
export const INLINE_ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f-]{36})$/
export const inlineAttachmentIds = (markdown: string): string[] => { /* every ![…](path) or [](path) whose path matches */ }
```

A `link`-status external attachment (`attachmentId` null, e.g. a Jira URL
attachment, or a Linear file the fetch gave up on) is listed with `id` set to
the `TaskExternalAsset` id, `downloadPath` set to the `externalUrl`, and
`external.status` telling the client to render an outbound link row rather
than a download chip. The schema is one shape on purpose — one list, one row
component (§5.5).

Changes to existing shapes:

- `TaskRecordSchema` (`packages/schemas/src/task-records.ts`) gains
  `labels: z.array(TaskLabelSummarySchema)`, `commentCount: z.number().int()`,
  `attachmentCount: z.number().int()` and `viewerCanEdit: z.boolean()`.
  `mapProjectTask` / `projectTaskInclude`
  (`packages/team-admin/src/project-task-records.ts`) are the one place that
  fills them (`_count` on comments where `deletedAt: null`, on attachments
  where `taskId` = task; `viewerCanEdit` from the viewer the record is mapped
  for — the same `listAccessibleProjectIds` rule the task routes apply, so
  the dialog never guesses from a role).
- `UpdateTaskBodySchema` and `CreateTaskBodySchema`
  (`api/src/contracts/tasks-board.ts`) gain `labelIds: TaskLabelIdsSchema.optional()`
  and `attachmentIds: z.array(uuid).max(10).optional()`.
- `BoardSourceFieldTargetSchema` (`packages/schemas/src/board-sources.ts`)
  gains the literal `'native:labels'`.
- `WsEventNameSchema` (`realtime-ws.ts`) gains `'task.activity'` with
  `TaskActivityEventSchema = z.object({ taskId: TaskIdSchema, projectId: z.string().uuid() })`
  — content-free, like `board.updated`.

### 1.5 The inline-image contract

One URL form, everywhere: `![alt](/api/attachments/<attachmentId>)`.

- The **editor** inserts exactly this after an upload; the **renderer**
  (`MessageMarkdown`) and the editor's image node view match
  `INLINE_ATTACHMENT_PATH` and resolve the bytes through
  `useAuthedObjectUrlFromPath` — the `<img>` never carries the API path as its
  `src`. Any other image URL renders as it does in chat today
  (`allowRemoteImages` decides).
- **Access** is the task's: the `taskId` arm in `canAccessAttachment` (§2.3).
  Copying a Markdown image reference into another ticket does not carry the
  file's access with it; the second ticket's readers who cannot read the
  first see the missing-image placeholder. No cross-linking in v1.
- **Deleting** an attachment that is still referenced (`inline: true`) is
  allowed after a confirm that says so; the reference then renders the
  placeholder *Image removed*. Nothing rewrites body text on delete.
- **Import** rewrites a provider image URL in a description or comment to this
  form once the asset is `stored`, and leaves the provider URL in place while
  `pending`/`failed` (§4.4).
