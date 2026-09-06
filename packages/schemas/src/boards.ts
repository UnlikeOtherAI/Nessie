import { z } from 'zod'

import { ColumnCategorySchema } from './board-lifecycle.js'
import { BoardColumnIdSchema, BoardIdSchema, ProjectIdSchema } from './ids.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

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

/**
 * A board's own glyph in the Projects sidebar. Emoji only, and `null` for the
 * shared board icon every board wears by default — a board is a saved way of
 * looking at a project's work, so it decorates itself without the upload,
 * crop and attachment lifecycle a project avatar carries.
 */
export const BoardIconEmojiSchema = z.string().trim().min(1).max(32)

export const BoardRecordSchema = z.object({
  id: BoardIdSchema,
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  iconEmoji: BoardIconEmojiSchema.nullable(),
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
    /** Absent or `null` leaves the board on the shared board icon. */
    iconEmoji: BoardIconEmojiSchema.nullable().optional(),
    style: BoardStyleSchema.optional(),
    /** Start from this board's columns instead of the four defaults. */
    copyColumnsFromBoardId: z.string().uuid().optional(),
  })
  .strict()

export const UpdateBoardBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(120).optional(),
    /** `null` clears it, back to the shared board icon. */
    iconEmoji: BoardIconEmojiSchema.nullable().optional(),
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
