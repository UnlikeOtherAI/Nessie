import { Prisma, type PrismaClient } from '@prisma/client'
import {
  DEFAULT_LABEL_COLOR,
  normalizeLabelName,
  parseProjectId,
  type TaskEventOrigin,
  type TaskLabelRecord,
} from '@nessie/schemas'

import { resolveTaskHomeBoard } from './board-placement.js'
import type { BoardSourceWriteBack, BoardSourceWriteBackError } from './board-source-writeback.js'
import {
  findAccessibleTask,
  isUuid,
  SYSTEM_TASK_EVENT_ORIGIN,
  taskEventAuthorship,
  type TaskActor,
} from './task-access.js'
import { recordTaskEvent } from './task-event-dispatch.js'

/**
 * A board's labels, and the labels on a ticket.
 *
 * A label belongs to one board; its name is unique on that board by
 * `normalizeLabelName`, so "Bug" and "bug " are one label there and "Bug" on
 * two boards is two labels with two colours. A ticket's labels are the labels
 * of the board it is on (`resolveTaskHomeBoard`), and a ticket that changes
 * board keeps them by name (`rehomeTaskLabels`). A label a board source owns
 * carries `sourceId`/`externalId` — per board; one a person made in Nessie has
 * neither and is "Nessie-only" on a mirrored ticket, surviving every sync.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** A board as the label doors address it. */
export type BoardRef = { id: string; projectId: string; organizationId: string }

const labelSelect = {
  id: true,
  projectId: true,
  boardId: true,
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
  boardId: row.boardId,
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

/** Every label of one board, ordered by name, each with how many tickets carry it. */
export const listBoardLabels = async (
  prisma: PrismaClient,
  boardId: string,
): Promise<TaskLabelRecord[]> => {
  if (!isUuid(boardId)) return []
  const rows = await prisma.taskLabel.findMany({
    where: { boardId },
    select: { ...labelSelect, _count: { select: { links: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => mapLabel(row, row._count.links))
}

/**
 * Every board's labels in a project — the backlog, the search page and the
 * personal assistant's project-wide read. Board order (the sidebar's), then
 * name; each record names its `boardId`.
 */
export const listProjectLabels = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<TaskLabelRecord[]> => {
  const rows = await prisma.taskLabel.findMany({
    where: { projectId },
    select: { ...labelSelect, _count: { select: { links: true } } },
    orderBy: [{ board: { position: 'asc' } }, { boardId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => mapLabel(row, row._count.links))
}

const findByName = async (db: Db, boardId: string, name: string) =>
  db.taskLabel.findUnique({
    where: { boardId_normalizedName: { boardId, normalizedName: normalizeLabelName(name) } },
    select: labelSelect,
  })

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Create a label on a board. A name already taken on that board (by
 * normalised name) is refused with the existing label, so a picker can
 * select it instead of failing.
 */
export const createBoardLabel = async (
  prisma: PrismaClient,
  board: BoardRef,
  input: { name: string; color?: string; createdByUserId: string | null },
): Promise<TaskLabelRecord | TaskLabelError> => {
  const name = input.name.trim()
  const taken = await findByName(prisma, board.id, name)
  if (taken) return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(taken) }
  try {
    const row = await prisma.taskLabel.create({
      data: {
        organizationId: board.organizationId,
        projectId: board.projectId,
        boardId: board.id,
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
    const winner = await findByName(prisma, board.id, name)
    if (!winner) throw error
    return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(winner) }
  }
}

/**
 * Rename or recolour one of a board's labels. Renaming a source-owned label
 * is local — the next sync restores the provider's name — and the record's
 * `external: true` lets the caller say so.
 */
export const updateBoardLabel = async (
  prisma: PrismaClient,
  board: BoardRef,
  labelId: string,
  patch: { name?: string; color?: string },
): Promise<TaskLabelRecord | TaskLabelError> => {
  if (!isUuid(labelId)) return { error: 'LABEL_NOT_FOUND' }
  const existing = await prisma.taskLabel.findFirst({
    where: { id: labelId, boardId: board.id },
    select: { id: true },
  })
  if (!existing) return { error: 'LABEL_NOT_FOUND' }
  const name = patch.name?.trim()
  if (name !== undefined) {
    const taken = await findByName(prisma, board.id, name)
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
    const winner = await findByName(prisma, board.id, name)
    if (!winner) throw error
    return { error: 'LABEL_NAME_TAKEN', existing: mapLabel(winner) }
  }
}

/** Delete one of a board's labels; its links to tickets cascade. */
export const deleteBoardLabel = async (
  prisma: PrismaClient,
  board: BoardRef,
  labelId: string,
): Promise<{ ok: true } | { error: 'LABEL_NOT_FOUND' }> => {
  if (!isUuid(labelId)) return { error: 'LABEL_NOT_FOUND' }
  const { count } = await prisma.taskLabel.deleteMany({ where: { id: labelId, boardId: board.id } })
  return count === 0 ? { error: 'LABEL_NOT_FOUND' } : { ok: true }
}

/**
 * The label a project-wide caller names by id alone (the MCP label tools,
 * whose `boardId` is optional): its board, or null when the id is not one of
 * the project's labels — or, with `boardId`, not that board's.
 */
export const findProjectLabelBoard = async (
  prisma: PrismaClient,
  projectId: string,
  labelId: string,
  boardId?: string | null,
): Promise<BoardRef | null> => {
  if (!isUuid(labelId) || (boardId && !isUuid(boardId))) return null
  const label = await prisma.taskLabel.findFirst({
    where: { id: labelId, projectId, ...(boardId ? { boardId } : {}) },
    select: { board: { select: { id: true, projectId: true, organizationId: true } } },
  })
  return label?.board ?? null
}

type MovableLabel = {
  name: string
  color: string
  sourceId: string | null
  externalId: string | null
}

/**
 * The label on `board` that already stands for `label`, or null: the same
 * `(sourceId, externalId)` for a source-owned label, else the same
 * normalised name. A same-name Nessie-only label is **adopted** by the source
 * (the sync's rule), so the next sync's replace-subset finds it.
 */
const findEquivalentOnBoard = async (
  tx: Db,
  boardId: string,
  label: MovableLabel,
): Promise<{ id: string } | null> => {
  const owned = label.sourceId !== null && label.externalId !== null
  if (owned) {
    const mine = await tx.taskLabel.findFirst({
      where: { boardId, sourceId: label.sourceId, externalId: label.externalId },
      select: { id: true },
    })
    if (mine) return mine
  }
  const sameName = await tx.taskLabel.findUnique({
    where: { boardId_normalizedName: { boardId, normalizedName: normalizeLabelName(label.name) } },
    select: { id: true, sourceId: true },
  })
  if (!sameName) return null
  if (owned && sameName.sourceId === null) {
    await tx.taskLabel.updateMany({
      where: { id: sameName.id, sourceId: null },
      data: { sourceId: label.sourceId, externalId: label.externalId },
    })
  }
  // A same-name label another source owns is still the label that name means
  // on this board: the ticket keeps the name rather than losing the label.
  return { id: sameName.id }
}

/**
 * Find, or create, the label on `board` that stands for `label`: same
 * normalised name; a source-owned label also same `(sourceId, externalId)`.
 * Create when missing — a move never drops information — keeping the name,
 * the colour and the ownership.
 */
export const findOrCreateLabelOnBoard = async (
  tx: Prisma.TransactionClient,
  board: BoardRef,
  label: MovableLabel,
): Promise<{ id: string }> => {
  const existing = await findEquivalentOnBoard(tx, board.id, label)
  if (existing) return existing
  // ON CONFLICT DO NOTHING, so a concurrent writer of the same name cannot
  // abort the caller's transaction; the re-read below takes the winner.
  await tx.taskLabel.createMany({
    data: [{
      organizationId: board.organizationId,
      projectId: board.projectId,
      boardId: board.id,
      name: label.name,
      normalizedName: normalizeLabelName(label.name),
      color: label.color,
      sourceId: label.sourceId,
      externalId: label.externalId,
    }],
    skipDuplicates: true,
  })
  const created = await findEquivalentOnBoard(tx, board.id, label)
  if (!created) throw new Error(`label "${label.name}" could not be placed on board ${board.id}`)
  return created
}

/**
 * Re-point every link of `taskId` from its old board's labels to `board`'s
 * equivalents, creating what is missing, and write one `labels_rehomed`
 * event `{ by, fromBoardId, toBoardId, mapping: [{ from, to }] }` when
 * anything moved. Runs inside the caller's transaction, after the task row
 * names its new board.
 */
export const rehomeTaskLabels = async (
  tx: Prisma.TransactionClient,
  task: { id: string },
  board: BoardRef,
  by: string,
): Promise<void> => {
  const links = await tx.taskLabelLink.findMany({
    where: { taskId: task.id, label: { NOT: { boardId: board.id } } },
    select: {
      labelId: true,
      label: { select: { boardId: true, name: true, color: true, sourceId: true, externalId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (links.length === 0) return
  const mapping: { from: string; to: string }[] = []
  for (const link of links) {
    const target = await findOrCreateLabelOnBoard(tx, board, link.label)
    mapping.push({ from: link.labelId, to: target.id })
  }
  await tx.taskLabelLink.deleteMany({
    where: { taskId: task.id, labelId: { in: links.map((link) => link.labelId) } },
  })
  await tx.taskLabelLink.createMany({
    data: mapping.map(({ to }) => ({ taskId: task.id, labelId: to })),
    skipDuplicates: true,
  })
  await tx.taskEvent.create({
    data: {
      taskId: task.id,
      eventType: 'labels_rehomed',
      payload: {
        by,
        fromBoardId: links[0]?.label.boardId ?? null,
        toBoardId: board.id,
        mapping,
      },
    },
  })
}

/**
 * Every label of `from` gets an equivalent on `to` and its links move; the
 * emptied rows are deleted. A label `to` has no equivalent for moves as the
 * same row (its id survives). Used by `deleteBoard` before the board goes, so
 * the storage cascade finds nothing.
 */
export const rehomeBoardLabels = async (
  tx: Prisma.TransactionClient,
  from: BoardRef,
  to: BoardRef,
): Promise<void> => {
  if (from.id === to.id) return
  const labels = await tx.taskLabel.findMany({
    where: { boardId: from.id },
    select: { id: true, name: true, color: true, sourceId: true, externalId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const label of labels) {
    const equivalent = await findEquivalentOnBoard(tx, to.id, label)
    if (!equivalent) {
      await tx.taskLabel.update({
        where: { id: label.id },
        data: { boardId: to.id },
      })
      continue
    }
    const links = await tx.taskLabelLink.findMany({ where: { labelId: label.id }, select: { taskId: true } })
    if (links.length > 0) {
      await tx.taskLabelLink.createMany({
        data: links.map((link) => ({ taskId: link.taskId, labelId: equivalent.id })),
        skipDuplicates: true,
      })
    }
    await tx.taskLabel.delete({ where: { id: label.id } })
  }
}

export type TaskLabelSetError = {
  error: 'LABEL_NOT_ON_BOARD' | 'LABEL_NOT_IN_TASK_SOURCE'
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

/**
 * Plan a replace-set against the ticket's home board: every requested id
 * must be a label of that board (`LABEL_NOT_ON_BOARD` — another board's
 * label, another project's, or a projectless ticket), and on a mirrored
 * ticket none may be owned by a different source (`LABEL_NOT_IN_TASK_SOURCE`).
 */
export const planTaskLabels = async (
  prisma: Db,
  task: { id: string; projectId: string | null; boardId: string | null; sourceId: string | null },
  labelIds: readonly string[],
): Promise<TaskLabelPlan | TaskLabelSetError> => {
  const wanted = [...new Set(labelIds)]
  const malformed = wanted.find((id) => !isUuid(id))
  if (malformed) return { error: 'LABEL_NOT_ON_BOARD', labelId: malformed }
  let labels: { id: string; sourceId: string | null; externalId: string | null }[] = []
  if (wanted.length > 0) {
    // A fake or older caller that never selected `boardId` means the default.
    const board = await resolveTaskHomeBoard(prisma, { projectId: task.projectId, boardId: task.boardId ?? null })
    if (!board) return { error: 'LABEL_NOT_ON_BOARD', labelId: wanted[0] }
    labels = await prisma.taskLabel.findMany({
      where: { id: { in: wanted }, boardId: board.id },
      select: { id: true, sourceId: true, externalId: true },
    })
  }
  const found = new Map(labels.map((label) => [label.id, label]))
  const missing = wanted.find((id) => !found.has(id))
  if (missing) return { error: 'LABEL_NOT_ON_BOARD', labelId: missing }
  // A label another source owns cannot mean anything upstream here, and the
  // next sync would drop it silently. On a native ticket every label is local.
  if (task.sourceId) {
    const foreign = labels.find((label) => label.sourceId !== null && label.sourceId !== task.sourceId)
    if (foreign) return { error: 'LABEL_NOT_IN_TASK_SOURCE', labelId: foreign.id }
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
  options: { by: string | null; origin?: TaskEventOrigin; ownedWrittenUpstream: boolean },
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
    await recordTaskEvent(tx, {
      taskId: plan.taskId,
      eventType: 'labels_changed',
      payload: {
        by: options.by,
        origin: options.origin ?? SYSTEM_TASK_EVENT_ORIGIN,
        added: plan.added,
        removed: plan.removed,
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
    {
      id: task.id,
      projectId: task.projectId,
      boardId: task.boardId ?? null,
      sourceId: task.externalLink?.sourceId ?? null,
    },
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
    applyTaskLabelPlan(tx, plan, { ...taskEventAuthorship(actor), ownedWrittenUpstream }))
  return { added: plan.added, removed: plan.removed }
}
