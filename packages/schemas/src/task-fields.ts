import { z } from 'zod'

import { ProjectIdSchema } from './ids.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

/**
 * Custom task fields: project-scoped definitions and the values a task carries
 * for them.
 *
 * Seven types, each one a validator and a renderer. `checkbox` is a two-option
 * `select` until a real case appears, `agent` is speculative (the assignee
 * already takes an agent), `rich_text` duplicates the task's `detail`, and
 * `relation` is a query language in disguise — so none of them are here.
 */

export const TaskFieldTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'url',
  'select',
  'multi_select',
  'user',
])
export type TaskFieldType = z.infer<typeof TaskFieldTypeSchema>

/** The closed tone set the `Pill` primitive renders. */
export const TaskFieldOptionToneSchema = z.enum([
  'accent',
  'danger',
  'info',
  'muted',
  'outline',
  'success',
  'warning',
])
export type TaskFieldOptionTone = z.infer<typeof TaskFieldOptionToneSchema>

/**
 * An option of a `select` / `multi_select`. The id is stable and the label is
 * mutable, so renaming an option never rewrites a value; retiring one keeps it
 * readable on the tasks that carry it while removing it from every picker.
 */
export const TaskFieldOptionSchema = z
  .object({
    id: NonEmptyStringSchema.max(64),
    label: NonEmptyStringSchema.max(120),
    tone: TaskFieldOptionToneSchema.optional(),
    retiredAt: z.string().nullable().optional(),
  })
  .strict()
export type TaskFieldOption = z.infer<typeof TaskFieldOptionSchema>

export const TaskFieldConfigSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    maxLength: z.number().int().positive().max(2000).optional(),
  })
  .strict()
export type TaskFieldConfig = z.infer<typeof TaskFieldConfigSchema>

export const TaskFieldDefinitionRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  type: TaskFieldTypeSchema,
  position: z.number().int(),
  showOnCard: z.boolean(),
  options: TaskFieldOptionSchema.array(),
  config: TaskFieldConfigSchema,
})
export type TaskFieldDefinitionRecord = z.infer<typeof TaskFieldDefinitionRecordSchema>

/** `{ "<definitionId>": <value> }`; an absent key is no value. */
export const TaskFieldValuesSchema = z.record(z.string().uuid(), z.unknown())
export type TaskFieldValues = z.infer<typeof TaskFieldValuesSchema>

/** A partial merge: a key set to `null` clears that field. */
export const TaskFieldValuesPatchSchema = z.record(z.string().uuid(), z.unknown())

export const TEXT_FIELD_MAX_LENGTH = 2000

// ─── Bodies ───────────────────────────────────────────────────────────────

export const CreateTaskFieldBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(80),
    type: TaskFieldTypeSchema,
    options: TaskFieldOptionSchema.array().optional(),
    config: TaskFieldConfigSchema.optional(),
    showOnCard: z.boolean().optional(),
  })
  .strict()

/**
 * `type` is deliberately absent: a definition's type is immutable, because
 * changing it would have to rewrite or discard every existing value. To change
 * a field's type, create a new field.
 */
export const UpdateTaskFieldBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(80).optional(),
    options: TaskFieldOptionSchema.array().optional(),
    config: TaskFieldConfigSchema.optional(),
    showOnCard: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .strict()

/** Types whose value is an option id (or ids) rather than a literal. */
export const OPTION_FIELD_TYPES: readonly TaskFieldType[] = ['select', 'multi_select']

export const isOptionFieldType = (type: TaskFieldType): boolean =>
  OPTION_FIELD_TYPES.includes(type)

/** How many field chips a card shows before collapsing the rest into `+N`. */
export const CARD_FIELD_CHIP_LIMIT = 3
