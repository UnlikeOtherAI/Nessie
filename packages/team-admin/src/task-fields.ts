import { Prisma, type PrismaClient } from '@prisma/client'
import {
  type TaskFieldConfig,
  type TaskFieldDefinitionRecord,
  type TaskFieldOption,
  TaskFieldOptionSchema,
  type TaskFieldType,
  TEXT_FIELD_MAX_LENGTH,
  isOptionFieldType,
  parseProjectId,
} from '@nessie/schemas'

/**
 * Custom task fields: the project's definitions, and validation of the values
 * a task carries for them.
 *
 * One writer validates: `updateProjectTask` checks a patch against the
 * definitions before writing, so the JSONB column cannot accumulate values no
 * definition explains.
 */

export type TaskFieldError =
  | { error: 'FIELD_NOT_FOUND' }
  | { error: 'FIELD_UNKNOWN'; fieldId: string }
  | { error: 'FIELD_VALUE_INVALID'; fieldId: string; reason: string }
  | { error: 'FIELD_NAME_TAKEN'; name: string }

export const isTaskFieldError = <T>(value: T | TaskFieldError): value is TaskFieldError =>
  typeof value === 'object' && value !== null && 'error' in value

const parseOptions = (value: unknown): TaskFieldOption[] => {
  const parsed = TaskFieldOptionSchema.array().safeParse(value)
  return parsed.success ? parsed.data : []
}

const parseConfig = (value: unknown): TaskFieldConfig =>
  typeof value === 'object' && value !== null ? (value as TaskFieldConfig) : {}

const mapDefinition = (definition: {
  id: string
  projectId: string
  name: string
  type: TaskFieldType
  position: number
  showOnCard: boolean
  options: unknown
  config: unknown
}): TaskFieldDefinitionRecord => ({
  id: definition.id,
  projectId: parseProjectId(definition.projectId),
  name: definition.name,
  type: definition.type,
  position: definition.position,
  showOnCard: definition.showOnCard,
  options: parseOptions(definition.options),
  config: parseConfig(definition.config),
})

export const listTaskFieldDefinitions = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<TaskFieldDefinitionRecord[]> => {
  const definitions = await prisma.taskFieldDefinition.findMany({
    where: { projectId },
    orderBy: { position: 'asc' },
  })
  return definitions.map(mapDefinition)
}

export const createTaskFieldDefinition = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  input: {
    name: string
    type: TaskFieldType
    options?: TaskFieldOption[]
    config?: TaskFieldConfig
    showOnCard?: boolean
    createdByUserId?: string
  },
): Promise<TaskFieldDefinitionRecord | TaskFieldError> => {
  const taken = await prisma.taskFieldDefinition.count({
    where: { projectId: project.id, name: input.name },
  })
  if (taken > 0) return { error: 'FIELD_NAME_TAKEN', name: input.name }

  const position =
    ((
      await prisma.taskFieldDefinition.aggregate({
        where: { projectId: project.id },
        _max: { position: true },
      })
    )._max.position ?? -1) + 1
  const definition = await prisma.taskFieldDefinition.create({
    data: {
      projectId: project.id,
      organizationId: project.organizationId,
      name: input.name,
      type: input.type,
      position,
      showOnCard: input.showOnCard ?? false,
      options: (input.options ?? []) as unknown as Prisma.InputJsonValue,
      config: (input.config ?? {}) as unknown as Prisma.InputJsonValue,
      createdByUserId: input.createdByUserId ?? null,
    },
  })
  return mapDefinition(definition)
}

export const updateTaskFieldDefinition = async (
  prisma: PrismaClient,
  projectId: string,
  fieldId: string,
  input: {
    name?: string
    options?: TaskFieldOption[]
    config?: TaskFieldConfig
    showOnCard?: boolean
    position?: number
  },
): Promise<TaskFieldDefinitionRecord | TaskFieldError> => {
  const existing = await prisma.taskFieldDefinition.findFirst({
    where: { id: fieldId, projectId },
    select: { id: true },
  })
  if (!existing) return { error: 'FIELD_NOT_FOUND' }
  if (input.name !== undefined) {
    const taken = await prisma.taskFieldDefinition.count({
      where: { projectId, name: input.name, NOT: { id: fieldId } },
    })
    if (taken > 0) return { error: 'FIELD_NAME_TAKEN', name: input.name }
  }
  const definition = await prisma.taskFieldDefinition.update({
    where: { id: fieldId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.options !== undefined
        ? { options: input.options as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.config !== undefined
        ? { config: input.config as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.showOnCard !== undefined ? { showOnCard: input.showOnCard } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    },
  })
  return mapDefinition(definition)
}

/**
 * Delete a definition and, in the same transaction, the values every task in
 * the project carries for it — one statement, so no task is left holding a
 * key no definition explains.
 */
export const deleteTaskFieldDefinition = async (
  prisma: PrismaClient,
  projectId: string,
  fieldId: string,
): Promise<{ ok: true } | TaskFieldError> => {
  const existing = await prisma.taskFieldDefinition.findFirst({
    where: { id: fieldId, projectId },
    select: { id: true },
  })
  if (!existing) return { error: 'FIELD_NOT_FOUND' }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "tasks"
         SET "field_values" = "field_values" - ${fieldId}
       WHERE "project_id" = ${projectId}::uuid
         AND "field_values" ? ${fieldId}
    `
    await tx.taskFieldDefinition.delete({ where: { id: fieldId } })
  })
  return { ok: true }
}

// ─── Validation ───────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const invalid = (fieldId: string, reason: string): TaskFieldError => ({
  error: 'FIELD_VALUE_INVALID',
  fieldId,
  reason,
})

const liveOptionIds = (definition: TaskFieldDefinitionRecord): Set<string> =>
  new Set(
    definition.options.filter((option) => !option.retiredAt).map((option) => option.id),
  )

const validateOne = (
  definition: TaskFieldDefinitionRecord,
  value: unknown,
  isActiveMember: (userId: string) => boolean,
): TaskFieldError | null => {
  switch (definition.type) {
    case 'text': {
      if (typeof value !== 'string') return invalid(definition.id, 'expected text')
      const max = definition.config.maxLength ?? TEXT_FIELD_MAX_LENGTH
      if ([...value].length > max) {
        return invalid(definition.id, `longer than ${max} characters`)
      }
      return null
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return invalid(definition.id, 'expected a number')
      }
      if (definition.config.min !== undefined && value < definition.config.min) {
        return invalid(definition.id, `below the minimum of ${definition.config.min}`)
      }
      if (definition.config.max !== undefined && value > definition.config.max) {
        return invalid(definition.id, `above the maximum of ${definition.config.max}`)
      }
      return null
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
        return invalid(definition.id, 'expected a YYYY-MM-DD date')
      }
      return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
        ? invalid(definition.id, 'not a real date')
        : null
    }
    case 'url': {
      if (typeof value !== 'string') return invalid(definition.id, 'expected a URL')
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        return invalid(definition.id, 'not a URL')
      }
      // `https:` only. A field rendered as a link that anyone in the project
      // can set is not a place to accept `javascript:` or `data:`.
      return parsed.protocol === 'https:'
        ? null
        : invalid(definition.id, 'must be an https:// URL')
    }
    case 'select': {
      if (typeof value !== 'string') return invalid(definition.id, 'expected one option')
      return liveOptionIds(definition).has(value)
        ? null
        : invalid(definition.id, 'not an available option')
    }
    case 'multi_select': {
      if (!Array.isArray(value)) return invalid(definition.id, 'expected a list of options')
      const live = liveOptionIds(definition)
      for (const entry of value) {
        if (typeof entry !== 'string' || !live.has(entry)) {
          return invalid(definition.id, 'not an available option')
        }
      }
      return null
    }
    case 'user': {
      if (typeof value !== 'string') return invalid(definition.id, 'expected a person')
      return isActiveMember(value)
        ? null
        : invalid(definition.id, 'not an active member of this organisation')
    }
    default:
      return invalid(definition.id, 'unknown field type')
  }
}

/**
 * Check a patch against the project's definitions. `null` clears a field and is
 * always allowed; anything else must match its definition's type.
 */
export const validateFieldValuesPatch = (
  definitions: TaskFieldDefinitionRecord[],
  patch: Record<string, unknown>,
  isActiveMember: (userId: string) => boolean = () => true,
): TaskFieldError | null => {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  for (const [fieldId, value] of Object.entries(patch)) {
    const definition = byId.get(fieldId)
    if (!definition) return { error: 'FIELD_UNKNOWN', fieldId }
    if (value === null) continue
    const failure = validateOne(definition, value, isActiveMember)
    if (failure) return failure
  }
  return null
}

/**
 * Merge a validated patch into a task's values in one atomic statement:
 * concatenate the set keys, then subtract the cleared ones. A read-modify-write
 * would lose a concurrent edit to a different field of the same task.
 */
export const applyFieldValuesPatch = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> => {
  const setEntries = Object.entries(patch).filter(([, value]) => value !== null)
  const clearedKeys = Object.entries(patch)
    .filter(([, value]) => value === null)
    .map(([key]) => key)
  if (setEntries.length === 0 && clearedKeys.length === 0) return

  const merge = JSON.stringify(Object.fromEntries(setEntries))
  await tx.$executeRaw`
    UPDATE "tasks"
       SET "field_values" = ("field_values" || ${merge}::jsonb) - ${clearedKeys}::text[]
     WHERE "id" = ${taskId}::uuid
  `
}

export { isOptionFieldType }
