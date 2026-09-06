import { z } from 'zod'

import { ColumnCategorySchema } from './board-lifecycle.js'
import { AgentIdSchema, BoardColumnIdSchema, BoardIdSchema, ProjectIdSchema, UserIdSchema } from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Boards, their columns, and the filter that makes a board a *view* over its
 * project's task pool rather than a container of work. The task shape a board
 * read returns lives here too, because the server — not the client — decides
 * which column a task renders in (`resolveBoardPlacement`).
 */

export const BoardStyleSchema = z.enum(['kanban', 'scrum'])
export type BoardStyle = z.infer<typeof BoardStyleSchema>

/**
 * External states a column shows and, in `read_write`, writes back to. Empty
 * for an unbound column, which is every column until a source is attached.
 */
export const BoardColumnStateBindingSchema = z
  .object({
    sourceId: z.string().uuid(),
    externalStateId: NonEmptyStringSchema,
  })
  .strict()
export type BoardColumnStateBinding = z.infer<typeof BoardColumnStateBindingSchema>

export const BoardColumnStateBindingsSchema = BoardColumnStateBindingSchema.array()

/**
 * The whole filter vocabulary, deliberately closed. `.strict()` so an unknown
 * key is an error rather than a hook for a query builder nobody designed.
 */
export const BoardFilterSchema = z
  .object({
    // Required rather than defaulted: a filter is edited and sent as a whole
    // document, and a `.default()` here would make the schema's input and
    // output types diverge for every caller that parses a request body.
    // A stored `{}` (every board before a filter was ever set) fails this
    // parse and reads back as `DEFAULT_BOARD_FILTER`.
    sources: z.union([
      z.literal('all'),
      z.literal('native'),
      z.array(z.string().uuid()).min(1),
    ]),
    field: z
      .object({
        fieldId: z.string().uuid(),
        optionIds: z.array(NonEmptyStringSchema).min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
export type BoardFilter = z.infer<typeof BoardFilterSchema>

export const DEFAULT_BOARD_FILTER: BoardFilter = { sources: 'all' }

export const BoardColumnRecordSchema = z.object({
  id: BoardColumnIdSchema,
  boardId: BoardIdSchema,
  name: NonEmptyStringSchema,
  category: ColumnCategorySchema,
  position: z.number().int(),
  stateBindings: BoardColumnStateBindingsSchema,
})
export type BoardColumnRecord = z.infer<typeof BoardColumnRecordSchema>

export const BoardRecordSchema = z.object({
  id: BoardIdSchema,
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  style: BoardStyleSchema,
  isDefault: z.boolean(),
  position: z.number().int(),
  filter: BoardFilterSchema,
  columns: BoardColumnRecordSchema.array(),
})
export type BoardRecord = z.infer<typeof BoardRecordSchema>

// ─── Bodies ───────────────────────────────────────────────────────────────

export const CreateBoardBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(120),
    style: BoardStyleSchema.optional(),
    /** Start from this board's columns instead of the four defaults. */
    copyColumnsFromBoardId: z.string().uuid().optional(),
  })
  .strict()

export const UpdateBoardBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(120).optional(),
    style: BoardStyleSchema.optional(),
    filter: BoardFilterSchema.optional(),
    position: z.number().int().nonnegative().optional(),
    /** Only `true` is meaningful: a board is demoted by promoting another. */
    isDefault: z.literal(true).optional(),
  })
  .strict()

export const CreateBoardColumnBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(80),
    category: ColumnCategorySchema,
    position: z.number().int().nonnegative().optional(),
    stateBindings: BoardColumnStateBindingsSchema.optional(),
  })
  .strict()

export const UpdateBoardColumnBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(80).optional(),
    category: ColumnCategorySchema.optional(),
    position: z.number().int().nonnegative().optional(),
    stateBindings: BoardColumnStateBindingsSchema.optional(),
  })
  .strict()

/**
 * The board read is capped rather than paginated: a board renders cards, and a
 * person scanning one is not paging through thousands. The cap is visible in
 * the response so the surface can say so instead of quietly lying.
 */
export const BOARD_TASK_LIMIT = 500

/**
 * Project-member roles that carry administrative authority over the project's
 * shape. The server predicate is `canAdministerProject` in
 * `@nessie/team-admin`; the admin mirrors it in `useCanAdministerProject` so
 * a control is not offered to somebody whose click would be refused.
 */
export const PROJECT_ADMIN_ROLES = ['owner', 'admin'] as const

/**
 * A board watcher: exactly one of `userId` / `agentId`, mirroring the CHECK on
 * the row. A union rather than two optional fields, so a caller cannot express
 * "both" or "neither" and have the server discover it.
 */
export const BoardWatcherSchema = z.union([
  z.object({ kind: z.literal('user'), id: UserIdSchema }),
  z.object({ kind: z.literal('agent'), id: AgentIdSchema }),
])
export type BoardWatcher = z.infer<typeof BoardWatcherSchema>

export const BoardWatcherRecordSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  kind: z.enum(['user', 'agent']),
  /** The user or agent id, whichever `kind` names. */
  recipientId: z.string().uuid(),
  /** For the chip, so the list renders without a second round trip. */
  displayName: z.string(),
  addedByUserId: UserIdSchema,
  createdAt: TimestampSchema,
})
export type BoardWatcherRecord = z.infer<typeof BoardWatcherRecordSchema>

/**
 * The whole list, replaced at once. A watcher list is short and edited as a
 * document — sending a diff would mean two orderings of the same edit and a
 * merge nobody asked for.
 */
export const SetBoardWatchersBodySchema = z.object({
  watchers: BoardWatcherSchema.array().max(50),
})
export type SetBoardWatchersBody = z.infer<typeof SetBoardWatchersBodySchema>
