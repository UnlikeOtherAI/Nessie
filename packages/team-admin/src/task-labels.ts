import { Prisma, type PrismaClient } from '@prisma/client'
import {
  DEFAULT_LABEL_COLOR,
  normalizeLabelName,
  parseProjectId,
  type TaskLabelRecord,
} from '@nessie/schemas'

import type { BoardSourceWriteBack, BoardSourceWriteBackError } from './board-source-writeback.js'
import { findAccessibleTask, isUuid, taskEventBy, type TaskActor } from './task-access.js'

/**
 * A project's labels, and the labels on a ticket.
 *
 * A label is project-scoped; its name is unique by `normalizeLabelName`, so
 * "Bug" and "bug " are one label. A label a board source owns carries
 * `sourceId`/`externalId`; one a person made in Nessie has neither and is
 * "Nessie-only" on a mirrored ticket, surviving every sync.
 */

const labelSelect = {
  id: true,
  projectId: true,
  name: true,
  color: true,
  sourceId: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
  source: { select: { provider: true } },
} satisfies Prisma.TaskLabelSelect

type LabelRow = Prisma.TaskLabelGetPayload<{ select: typeof labelSelect }>

const mapLabel = (row: LabelRow, taskCount?: number): TaskLabelRecord => ({
  id: row.id,
  projectId: parseProjectId(row.projectId),
  name: row.name,
  color: row.color,
  external: row.sourceId !== null,
  source:
    row.sourceId && row.source && row.externalId
      ? { sourceId: row.sourceId, provider: row.source.provider, externalId: row.externalId }
      : null,
  ...(taskCount !== undefined ? { taskCount } : {}),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export type TaskLabelError =
  | { error: 'LABEL_NOT_FOUND' }
  | { error: 'LABEL_NAME_TAKEN'; existing: TaskLabelRecord }

export const isTaskLabelError = (value: unknown): value is TaskLabelError =>
  typeof value === 'object' && value !== null && 'error' in value

/** Every label of a project, ordered by name, each with how many tickets carry it. */
export const listProjectLabels = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<TaskLabelRecord[]> => {
  const rows = await prisma.taskLabel.findMany({
    where: { projectId },
    select: { ...labelSelect, _count: { select: { links: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => mapLabel(row, row._count.links))
}

const findByName = async (prisma: PrismaClient, projectId: string, name: string) =>
  prisma.taskLabel.findUnique({
    where: { projectId_normalizedName: { projectId, normalizedName: normalizeLabelName(name) } },
    select: labelSelect,
  })

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Create a label. A name already taken (by normalised name) is refused with
 * the existing label, so a picker can select it instead of failing.
 */
export const createProjectLabel = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  input: { name: string; color?: string; createdByUserId: string | null },
): Promise<TaskLabelRecord | TaskLabelError> => {
  const name = input.name.trim()
  const taken = await findByName(prisma, project.id, name)
  if (taken) return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(taken) }
  try {
    const row = await prisma.taskLabel.create({
      data: {
        organizationId: project.organizationId,
        projectId: project.id,
        name,
        normalizedName: normalizeLabelName(name),
        color: (input.color ?? DEFAULT_LABEL_COLOR).toLowerCase(),
        createdByUserId: input.createdByUserId,
      },
      select: labelSelect,
    })
    return mapLabel(row, 0)
  } catch (error) {
    // Two creates raced; the loser gets the winner's row, as above.
    if (!isUniqueViolation(error)) throw error
    const winner = await findByName(prisma, project.id, name)
    if (!winner) throw error
    return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(winner) }
  }
}

/**
 * Rename or recolour. Renaming a source-owned label is local — the next sync
 * restores the provider's name — and the record's `external: true` lets the
 * caller say so.
 */
export const updateProjectLabel = async (
  prisma: PrismaClient,
  projectId: string,
  labelId: string,
  patch: { name?: string; color?: string },
): Promise<TaskLabelRecord | TaskLabelError> => {
  if (!isUuid(labelId)) return { error: 'LABEL_NOT_FOUND' }
  const existing = await prisma.taskLabel.findFirst({
    where: { id: labelId, projectId },
    select: { id: true },
  })
  if (!existing) return { error: 'LABEL_NOT_FOUND' }
  const name = patch.name?.trim()
  if (name !== undefined) {
    const taken = await findByName(prisma, projectId, name)
    if (taken && taken.id !== labelId) return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(taken) }
  }
  try {
    const row = await prisma.taskLabel.update({
      where: { id: labelId },
      data: {
        ...(name !== undefined ? { name, normalizedName: normalizeLabelName(name) } : {}),
        ...(patch.color !== undefined ? { color: patch.color.toLowerCase() } : {}),
      },
      select: { ...labelSelect, _count: { select: { links: true } } },
    })
    return mapLabel(row, row._count.links)
  } catch (error) {
    if (!isUniqueViolation(error) || name === undefined) throw error
    const winner = await findByName(prisma, projectId, name)
    if (!winner) throw error
    return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(winner) }
  }
}

/** Delete a label; its links to tickets cascade. */
export const deleteProjectLabel = async (
  prisma: PrismaClient,
  projectId: string,
  labelId: string,
): Promise<{ ok: true } | { error: 'LABEL_NOT_FOUND' }> => {
  if (!isUuid(labelId)) return { error: 'LABEL_NOT_FOUND' }
  const { count } = await prisma.taskLabel.deleteMany({ where: { id: labelId, projectId } })
  return count === 0 ? { error: 'LABEL_NOT_FOUND' } : { ok: true }
}

export type TaskLabelSetError = {
  error: 'LABEL_NOT_IN_PROJECT' | 'LABEL_NOT_IN_PROJECT_SOURCE'
  labelId?: string
}

/**
 * What replacing a ticket's label set means, decided before anything is
 * written. The requested set is partitioned by ownership: labels the task's
 * own source owns, and everything else (Nessie-only). `upstreamLabelIds` is
 * the full desired source-owned set as provider ids when — and only when —
 * that subset changed, which is the one case that asks the provider.
 */
export type TaskLabelPlan = {
  taskId: string
  added: string[]
  removed: string[]
  /** Local link changes to labels the task's source does not own. */
  localAdd: string[]
  localRemove: string[]
  /** The source-owned changes, written locally only if the provider was not asked. */
  ownedAdd: string[]
  ownedRemove: string[]
  upstreamLabelIds: string[] | null
}

export const planTaskLabels = async (
  prisma: PrismaClient,
  task: { id: string; projectId: string | null; sourceId: string | null },
  labelIds: readonly string[],
): Promise<TaskLabelPlan | TaskLabelSetError> => {
  const wanted = [...new Set(labelIds)]
  const malformed = wanted.find((id) => !isUuid(id))
  if (malformed) return { error: 'LABEL_NOT_IN_PROJECT', labelId: malformed }
  if (wanted.length > 0 && !task.projectId) return { error: 'LABEL_NOT_IN_PROJECT', labelId: wanted[0] }
  const labels = wanted.length === 0
    ? []
    : await prisma.taskLabel.findMany({
        where: { id: { in: wanted }, projectId: task.projectId ?? undefined },
        select: { id: true, sourceId: true, externalId: true },
      })
  const found = new Map(labels.map((label) => [label.id, label]))
  const missing = wanted.find((id) => !found.has(id))
  if (missing) return { error: 'LABEL_NOT_IN_PROJECT', labelId: missing }
  // A label another source owns cannot mean anything upstream here, and the
  // next sync would drop it silently. On a native ticket every label is local.
  if (task.sourceId) {
    const foreign = labels.find((label) => label.sourceId !== null && label.sourceId !== task.sourceId)
    if (foreign) return { error: 'LABEL_NOT_IN_PROJECT_SOURCE', labelId: foreign.id }
  }
  const current = await prisma.taskLabelLink.findMany({
    where: { taskId: task.id },
    select: { labelId: true, label: { select: { sourceId: true, externalId: true } } },
  })
  const owned = (sourceId: string | null) => task.sourceId !== null && sourceId === task.sourceId
  const currentIds = new Set(current.map((link) => link.labelId))
  const wantedIds = new Set(wanted)
  const added = wanted.filter((id) => !currentIds.has(id))
  const removed = current.map((link) => link.labelId).filter((id) => !wantedIds.has(id))
  const ownedById = new Map([
    ...current.map((link) => [link.labelId, owned(link.label.sourceId)] as const),
    ...labels.map((label) => [label.id, owned(label.sourceId)] as const),
  ])
  const ownedAdd = added.filter((id) => ownedById.get(id))
  const ownedRemove = removed.filter((id) => ownedById.get(id))
  const ownedChanged = ownedAdd.length > 0 || ownedRemove.length > 0
  return {
    taskId: task.id,
    added,
    removed,
    localAdd: added.filter((id) => !ownedById.get(id)),
    localRemove: removed.filter((id) => !ownedById.get(id)),
    ownedAdd,
    ownedRemove,
    upstreamLabelIds: ownedChanged
      ? labels.filter((label) => owned(label.sourceId)).flatMap((label) => (label.externalId ? [label.externalId] : []))
      : null,
  }
}

/**
 * Write a plan's links and its `labels_changed` event inside the caller's
 * transaction. When the provider already took the source-owned subset, its
 * echo rewrote those links and only the Nessie-only ones are written here.
 */
export const applyTaskLabelPlan = async (
  tx: Prisma.TransactionClient,
  plan: TaskLabelPlan,
  options: { by: string | null; ownedWrittenUpstream: boolean },
): Promise<void> => {
  const add = [...plan.localAdd, ...(options.ownedWrittenUpstream ? [] : plan.ownedAdd)]
  const remove = [...plan.localRemove, ...(options.ownedWrittenUpstream ? [] : plan.ownedRemove)]
  if (remove.length > 0) {
    await tx.taskLabelLink.deleteMany({ where: { taskId: plan.taskId, labelId: { in: remove } } })
  }
  if (add.length > 0) {
    await tx.taskLabelLink.createMany({
      data: add.map((labelId) => ({ taskId: plan.taskId, labelId })),
      skipDuplicates: true,
    })
  }
  if (plan.added.length > 0 || plan.removed.length > 0) {
    await tx.taskEvent.create({
      data: {
        taskId: plan.taskId,
        eventType: 'labels_changed',
        payload: { by: options.by, added: plan.added, removed: plan.removed },
      },
    })
  }
}

/**
 * Replace a ticket's labels (replace-set). The door the label tools call when
 * nothing else about the ticket changes; `updateProjectTask` runs the same
 * plan inside its own write. On a mirrored ticket a changed source-owned
 * subset is written upstream first through `writeBack` and the mirror follows
 * the echo; a `read_only` source refuses it with `SOURCE_READ_ONLY`.
 */
export const setTaskLabels = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; labelIds: readonly string[] },
  writeBack?: BoardSourceWriteBack,
): Promise<
  | { added: string[]; removed: string[] }
  | { error: 'NOT_FOUND' }
  | TaskLabelSetError
  | BoardSourceWriteBackError
> => {
  const task = await findAccessibleTask(prisma, actor, input.taskId)
  if (!task) return { error: 'NOT_FOUND' }
  const plan = await planTaskLabels(
    prisma,
    { id: task.id, projectId: task.projectId, sourceId: task.externalLink?.sourceId ?? null },
    input.labelIds,
  )
  if ('error' in plan) return plan
  let ownedWrittenUpstream = false
  if (plan.upstreamLabelIds && writeBack) {
    const outcome = await writeBack.apply({ taskId: task.id, change: { labelIds: plan.upstreamLabelIds } })
    if (outcome && 'error' in outcome) return outcome
    ownedWrittenUpstream = outcome !== null
  }
  await prisma.$transaction((tx) =>
    applyTaskLabelPlan(tx, plan, { by: taskEventBy(actor), ownedWrittenUpstream }))
  return { added: plan.added, removed: plan.removed }
}
