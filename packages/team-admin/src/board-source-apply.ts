import type { Prisma, PrismaClient, TaskStatus } from '@prisma/client'
import {
  type NormalisedItem,
  type NormalisedItemLabel,
  itemFingerprint,
} from '@nessie/board-sources'
import {
  type BoardSourceFieldMapping,
  BoardSourceFieldMappingSchema,
  type BoardSourceStateMapping,
  BoardSourceStateMappingsSchema,
  type ColumnCategory,
  DEFAULT_LABEL_COLOR,
  LabelColorSchema,
  TASK_LABEL_NAME_MAX_CHARS,
  normalizeLabelName,
} from '@nessie/schemas'

import { loadStoredAssetUrls, rewriteProviderUrls } from './board-source-apply-activity.js'

/**
 * Turning one external item into one Nessie task.
 *
 * Shared rather than worker-only because the API applies the vendor's echo on a
 * write-back through exactly this function — the mirror is always written from
 * what the provider actually stored, never from what was asked for.
 */

export type BoardSourceApplyContext = {
  id: string
  organizationId: string
  projectId: string
  provider: string
  stateMapping: BoardSourceStateMapping[]
  fieldMappings: BoardSourceFieldMapping[]
  /** externalUserId → the Nessie identity a person or an auto-match resolved. */
  identityByExternalUserId: Map<string, { userId: string | null; agentId: string | null }>
}

/**
 * What changed, for the board watchers. Deliberately two values: nothing
 * branches on more yet, and a wider vocabulary now would be speculative.
 */
export type ApplyChange = 'status' | 'assignee'

export type ApplyOutcome =
  | {
      applied: 'created' | 'updated'
      taskId: string
      /**
       * The inbound fingerprint this apply wrote. A sweep page and a webhook
       * can both apply one change, so whoever tells the watchers claims on it.
       */
      fingerprint: string
      changes: ApplyChange[]
    }
  | { applied: 'echo'; taskId: string }
  | { applied: 'unchanged'; taskId: string }
  | { applied: 'unmapped_state'; stateName: string }

export const parseStateMapping = (value: unknown): BoardSourceStateMapping[] => {
  const parsed = BoardSourceStateMappingsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

export const parseFieldMappings = (value: unknown): BoardSourceFieldMapping[] => {
  const parsed = BoardSourceFieldMappingSchema.array().safeParse(value)
  return parsed.success ? parsed.data : []
}

/** The external field keys a fingerprint covers: only what this source maps. */
export const mappedFieldKeys = (mappings: BoardSourceFieldMapping[]): string[] =>
  mappings.map((mapping) => mapping.externalKey)

const CATEGORY_STATUS: Record<ColumnCategory, TaskStatus> = {
  todo: 'inbox',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
}

const PRIORITY_TOKENS = new Set(['low', 'medium', 'high', 'urgent'])

/**
 * The status an item's external state lands on.
 *
 * `todo` becomes `assigned` rather than `inbox` when somebody is on it, because
 * that is what the two statuses mean here; `archived` becomes `cancelled`.
 */
const statusForItem = (
  category: ColumnCategory | 'archived',
  hasAssignee: boolean,
): TaskStatus => {
  if (category === 'archived') return 'cancelled'
  if (category === 'todo') return hasAssignee ? 'assigned' : 'inbox'
  return CATEGORY_STATUS[category]
}

/**
 * The native task columns a field mapping may write. Plain values rather than
 * `Prisma.TaskUncheckedUpdateInput`, because the same object is spread into a
 * create as well as an update, and the update type also admits the
 * `{ set: … }` operation objects a create will not take.
 */
type MappedNativeFields = {
  storyPoints?: number | null
  title?: string
  detail?: string | null
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  dueDate?: Date | null
}

type FieldTargets = {
  taskData: MappedNativeFields
  fieldValues: Record<string, unknown>
  /** The source maps the item's labels onto native project labels. */
  labels: boolean
}

const applyFieldMappings = (
  item: NormalisedItem,
  mappings: BoardSourceFieldMapping[],
): FieldTargets => {
  const taskData: MappedNativeFields = {}
  const fieldValues: Record<string, unknown> = {}
  let labels = false

  for (const mapping of mappings) {
    // Fed from `item.labels`, not `item.fields.labels`: labels are first-class
    // on the item and carry their colour, which a field value cannot.
    if (mapping.target === 'native:labels') {
      labels = true
      continue
    }
    const raw = item.fields[mapping.externalKey]
    const mapped = mapping.valueMap
      ? Array.isArray(raw)
        ? raw.map((entry) => mapping.valueMap?.[String(entry)] ?? String(entry))
        : mapping.valueMap[String(raw)] ?? raw
      : raw

    switch (mapping.target) {
      case 'native:storyPoints':
        taskData.storyPoints = typeof mapped === 'number' ? Math.round(mapped) : null
        break
      case 'native:title':
        if (typeof mapped === 'string') taskData.title = mapped
        break
      case 'native:detail':
        taskData.detail = typeof mapped === 'string' ? mapped : null
        break
      case 'native:priority':
        if (typeof mapped === 'string' && PRIORITY_TOKENS.has(mapped)) {
          taskData.priority = mapped as MappedNativeFields['priority']
        }
        break
      case 'native:dueDate':
        taskData.dueDate =
          typeof mapped === 'string' ? new Date(`${mapped.slice(0, 10)}T00:00:00Z`) : null
        break
      default: {
        // `field:<definitionId>` — a custom field of this project.
        const definitionId = mapping.target.slice('field:'.length)
        if (mapped !== undefined) fieldValues[definitionId] = mapped ?? null
      }
    }
  }
  return { taskData, fieldValues, labels }
}

type Db = PrismaClient | Prisma.TransactionClient

/** The project and source a set of provider labels belongs to. */
export type SourceLabelOwner = { id: string; organizationId: string; projectId: string }

const labelColour = (colour: string | undefined): string | null => {
  const parsed = LabelColorSchema.safeParse(colour?.toLowerCase())
  return parsed.success ? parsed.data : null
}

/**
 * Make each provider label a project label owned by the source, keyed by
 * `(sourceId, externalId)`, with the provider's name and colour.
 *
 * A project label a person already made with the same name (case-folded) is
 * **adopted** rather than duplicated: whoever made *Bug* before connecting
 * Linear keeps their label, and it becomes the source's. A name another source
 * already owns is left alone — two sources cannot own one label — and that
 * provider label is not linked. A rename upstream that would collide with an
 * existing label keeps the old name and still takes the colour.
 *
 * Returns provider label id → project label id for the labels that resolved.
 */
export const upsertSourceLabels = async (
  db: Db,
  source: SourceLabelOwner,
  labels: readonly NormalisedItemLabel[],
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>()
  const unique = [...new Map(labels.filter((label) => label.id).map((l) => [l.id, l])).values()]
  if (unique.length === 0) return resolved

  const owned = await db.taskLabel.findMany({
    where: { sourceId: source.id, externalId: { in: unique.map((label) => label.id) } },
    select: { id: true, externalId: true, name: true, color: true },
  })
  const byExternalId = new Map(owned.map((row) => [row.externalId as string, row]))

  for (const label of unique) {
    const name = label.label.trim().slice(0, TASK_LABEL_NAME_MAX_CHARS).trim()
    if (!name) continue
    const normalizedName = normalizeLabelName(name)
    const colour = labelColour(label.color)
    const current = byExternalId.get(label.id)

    if (current) {
      const data: Prisma.TaskLabelUpdateInput = {}
      if (current.name !== name) {
        const clash = await db.taskLabel.findUnique({
          where: { projectId_normalizedName: { projectId: source.projectId, normalizedName } },
          select: { id: true },
        })
        if (!clash || clash.id === current.id) {
          data.name = name
          data.normalizedName = normalizedName
        }
      }
      if (colour && current.color !== colour) data.color = colour
      if (Object.keys(data).length > 0) {
        await db.taskLabel.update({ where: { id: current.id }, data })
      }
      resolved.set(label.id, current.id)
      continue
    }

    // ON CONFLICT DO NOTHING on either unique key, so a concurrent apply of
    // the same label — or a person's same-name label — never aborts the
    // surrounding transaction; the re-read below says which case it was.
    await db.taskLabel.createMany({
      data: [
        {
          organizationId: source.organizationId,
          projectId: source.projectId,
          name,
          normalizedName,
          color: colour ?? DEFAULT_LABEL_COLOR,
          sourceId: source.id,
          externalId: label.id,
        },
      ],
      skipDuplicates: true,
    })
    const mine = await db.taskLabel.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId: label.id } },
      select: { id: true },
    })
    if (mine) {
      resolved.set(label.id, mine.id)
      continue
    }
    const sameName = await db.taskLabel.findUnique({
      where: { projectId_normalizedName: { projectId: source.projectId, normalizedName } },
      select: { id: true, sourceId: true },
    })
    if (!sameName || sameName.sourceId !== null) continue
    const adopted = await db.taskLabel.updateMany({
      where: { id: sameName.id, sourceId: null },
      data: { sourceId: source.id, externalId: label.id, name, ...(colour ? { color: colour } : {}) },
    })
    if (adopted.count === 1) resolved.set(label.id, sameName.id)
  }
  return resolved
}

/**
 * Replace the task's **source-owned** labels with the item's set. A label a
 * person added in Nessie (no source) is never touched: the sync replaces only
 * the subset it knows about. Writes one `labels_changed` event when anything
 * changed on a task that already existed.
 */
export const syncTaskSourceLabels = async (
  db: Db,
  source: SourceLabelOwner,
  taskId: string,
  labels: readonly NormalisedItemLabel[],
  options: { recordEvent: boolean },
): Promise<{ added: string[]; removed: string[] }> => {
  const byExternalId = await upsertSourceLabels(db, source, labels)
  const wanted = new Set(byExternalId.values())
  const current = await db.taskLabelLink.findMany({
    where: { taskId, label: { sourceId: source.id } },
    select: { labelId: true },
  })
  const have = new Set(current.map((link) => link.labelId))
  const added = [...wanted].filter((id) => !have.has(id))
  const removed = [...have].filter((id) => !wanted.has(id))

  if (removed.length > 0) {
    await db.taskLabelLink.deleteMany({ where: { taskId, labelId: { in: removed } } })
  }
  if (added.length > 0) {
    await db.taskLabelLink.createMany({
      data: added.map((labelId) => ({ taskId, labelId })),
      skipDuplicates: true,
    })
  }
  if (options.recordEvent && (added.length > 0 || removed.length > 0)) {
    await db.taskEvent.create({
      data: {
        taskId,
        eventType: 'labels_changed',
        payload: { by: `source:${source.id}`, bySourceId: source.id, added, removed },
      },
    })
  }
  return { added, removed }
}

/** Whether a source maps labels natively — the arm `syncTaskSourceLabels` serves. */
export const mapsNativeLabels = (mappings: BoardSourceFieldMapping[]): boolean =>
  mappings.some((mapping) => mapping.target === 'native:labels')

/**
 * Apply one item. Returns what happened so the caller can decide whether to
 * publish, and so a state nobody has mapped becomes a visible misconfiguration
 * rather than a silently ignored item.
 */
export const applyInboundItem = async (
  prisma: PrismaClient,
  source: BoardSourceApplyContext,
  item: NormalisedItem,
): Promise<ApplyOutcome> => {
  const fingerprint = itemFingerprint(item, mappedFieldKeys(source.fieldMappings))

  return prisma.$transaction(async (tx): Promise<ApplyOutcome> => {
    // The whole apply is one read-then-insert: the link lookup below decides
    // whether a task is created, and `Task` carries no constraint on
    // (sourceId, externalId) to catch a second one. A provider retry that two
    // workers both pick up would otherwise create two tasks, and the loser's is
    // an orphan nobody can reach. So appliers of the same external item
    // serialise here and the second sees the first's link — the two-int
    // `pg_advisory_xact_lock` idiom `deepsignal-digest.ts` uses per thread.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${source.id}),
        hashtext(${item.externalId})
      )
    `

    const existing = await tx.taskExternalLink.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId: item.externalId } },
      select: {
        id: true,
        taskId: true,
        inboundFingerprint: true,
        outboundFingerprint: true,
      },
    })

    // Our own write coming back, or nothing we can see having changed. Either
    // way the item is current: advance the clock and write no event.
    if (
      existing
      && (fingerprint === existing.outboundFingerprint
        || fingerprint === existing.inboundFingerprint)
    ) {
      await tx.taskExternalLink.update({
        where: { id: existing.id },
        data: {
          externalUpdatedAt: new Date(item.updatedAt),
          lastInboundAt: new Date(),
          remoteStateId: item.stateId,
          remoteStateName: item.stateName,
        },
      })
      return {
        applied: fingerprint === existing.outboundFingerprint ? 'echo' : 'unchanged',
        taskId: existing.taskId,
      }
    }

    const stateRow = source.stateMapping.find(
      (entry) => entry.externalStateId === item.stateId,
    )
    const category = item.archived ? 'archived' : stateRow?.category ?? null
    if (category === null) {
      // Nothing guesses what an unmapped state means. The source says so, and a
      // person maps it — docs/standards/capability-health-alerts.md.
      return { applied: 'unmapped_state', stateName: item.stateName || item.stateId }
    }

    // A link row that names nobody — a person left them unmapped, or an email
    // match found no account — is the same as no link at all here: the card
    // must still show who the provider says is on it.
    const linked = item.assignee
      ? source.identityByExternalUserId.get(item.assignee.externalUserId) ?? null
      : null
    const identity = linked?.userId || linked?.agentId ? linked : null
    const { taskData, fieldValues, labels } = applyFieldMappings(item, source.fieldMappings)
    const status = statusForItem(category, identity !== null)

    const base = {
      title: item.title,
      detail: item.description,
      status,
      assigneeUserId: identity?.userId ?? null,
      assigneeAgentId: identity?.agentId ?? null,
      archivedAt: item.archived ? new Date() : null,
      ...taskData,
    }
    // A provider image already stored here keeps its Nessie path: without this
    // every changed item would flip the description back to the provider URL,
    // which only the connection's owner can open.
    if (existing && base.detail) {
      const stored = await loadStoredAssetUrls(tx, source.id, [existing.taskId])
      base.detail = rewriteProviderUrls(base.detail, stored.get(existing.taskId) ?? [])
    }

    const changes: ApplyChange[] = []
    let id = existing?.taskId
    if (id) {
      const previous = await tx.task.findUnique({
        where: { id },
        select: { status: true, assigneeUserId: true, assigneeAgentId: true },
      })
      await tx.task.update({ where: { id }, data: base })
      if (
        previous &&
        (previous.assigneeUserId !== base.assigneeUserId ||
          previous.assigneeAgentId !== base.assigneeAgentId)
      ) {
        changes.push('assignee')
      }
      if (previous && previous.status !== status) {
        changes.push('status')
        // The vendor is the authority for its own item, so this bypasses
        // `VALID_TRANSITIONS` — but it still records who moved it and from what.
        await tx.taskEvent.create({
          data: {
            taskId: id,
            eventType: 'status_changed',
            payload: {
              bySourceId: source.id,
              from: previous.status,
              to: status,
              remoteStateId: item.stateId,
            },
          },
        })
      }
    } else {
      const created = await tx.task.create({
        data: {
          organizationId: source.organizationId,
          projectId: source.projectId,
          priority: 'medium',
          ...base,
        },
        select: { id: true },
      })
      id = created.id
    }

    if (Object.keys(fieldValues).length > 0) {
      const merge = JSON.stringify(fieldValues)
      await tx.$executeRaw`
        UPDATE "tasks"
           SET "field_values" = "field_values" || ${merge}::jsonb
         WHERE "id" = ${id}::uuid
      `
    }

    if (labels) {
      await syncTaskSourceLabels(tx, source, id as string, item.labels, {
        recordEvent: Boolean(existing),
      })
    }

    const linkData = {
      organizationId: source.organizationId,
      sourceId: source.id,
      externalId: item.externalId,
      externalKey: item.externalKey,
      externalUrl: item.url,
      remoteStateId: item.stateId,
      remoteStateName: item.stateName,
      remoteAssigneeExternalId: item.assignee?.externalUserId ?? null,
      // What the card shows when no identity link resolves. Provider data about
      // a provider user — never promoted into a Nessie person.
      remoteAssigneeDisplay: identity ? null : item.assignee?.displayName ?? null,
      externalUpdatedAt: new Date(item.updatedAt),
      remoteDeletedAt: item.archived ? new Date() : null,
      inboundFingerprint: fingerprint,
      lastInboundAt: new Date(),
    }
    await tx.taskExternalLink.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId: item.externalId } },
      create: { taskId: id as string, ...linkData },
      update: linkData,
    })

    return {
      applied: existing ? 'updated' : 'created',
      taskId: id as string,
      fingerprint,
      changes,
    }
  })
}
