import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob, writeAuditEntry } from '@nessie/db'
import {
  DEMONSTRATION_GENERALIZE_TOPIC,
  DemonstrationDetailRecordSchema,
  DemonstrationRecordSchema,
  DemonstrationStepRecordSchema,
  type AuthorizedActionContext,
  type DemonstrationDetailRecord,
  type DemonstrationRecord,
} from '@nessie/schemas'

import { getChannelIfMember } from './access-checks.js'

export class DemonstrationError extends Error {
  constructor(
    readonly code:
      | 'AGENT_NOT_BOUND'
      | 'CHANNEL_NOT_FOUND'
      | 'NOT_RECORDING'
      | 'RECORDING_ALREADY_ACTIVE'
      | 'THREAD_NOT_FOUND',
  ) {
    super(code)
    this.name = 'DemonstrationError'
  }
}

type DemonstrationRow = {
  agentId: string
  capturedAt: Date | null
  channelId: string
  expiresAt: Date
  generalizationError?: string | null
  id: string
  organizationId: string
  startedAt: Date
  startedByUserId: string
  status: 'captured' | 'discarded' | 'generalized' | 'recording'
  stepCount: number
  threadId: string
  workflowTemplate?: { id: string } | null
}

type DemonstrationStepRow = {
  agentId: string
  argumentsJson: unknown
  demonstrationId: string
  durationMs: number
  endedAt: Date
  id: string
  runId: string | null
  sequence: number
  startedAt: Date
  success: boolean
  toolName: string
}

const mapDemonstration = (row: DemonstrationRow): DemonstrationRecord =>
  DemonstrationRecordSchema.parse({
    ...row,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    workflowTemplateId: row.workflowTemplate?.id ?? null,
  })

const DEFAULT_DEMONSTRATION_TTL_MS = 4 * 60 * 60 * 1000

const demonstrationTtlMs = (): number => {
  const configured = Number(process.env['NESSIE_DEMONSTRATION_TTL_MS'])
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DEMONSTRATION_TTL_MS
}

const expireDemonstrations = async (
  prisma: PrismaClient,
  where: Prisma.DemonstrationWhereInput,
): Promise<void> => {
  await prisma.demonstration.updateMany({
    data: { capturedAt: new Date(), status: 'captured' },
    where: { ...where, expiresAt: { lte: new Date() }, status: 'recording' },
  })
}

const mapStep = (row: DemonstrationStepRow) => DemonstrationStepRecordSchema.parse({
  ...row,
  endedAt: row.endedAt.toISOString(),
  startedAt: row.startedAt.toISOString(),
})

const emitDemonstrationAudit = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  demonstration: DemonstrationRecord,
  action: 'demonstration.started' | 'demonstration.stopped' | 'demonstration.generalized',
): Promise<void> => {
  try {
    await writeAuditEntry(prisma, {
      action,
      actorId: actorContext.actor.actorId,
      actorType: 'user',
      channelId: demonstration.channelId,
      metadata: {
        agentId: demonstration.agentId,
        threadId: demonstration.threadId,
      },
      organizationId: demonstration.organizationId,
      outcome: 'success',
      projectId: actorContext.tenant.projectId ?? null,
      requestId: actorContext.actionContext.requestId,
      resourceId: demonstration.id,
      resourceType: 'demonstration',
      teamId: actorContext.tenant.teamId ?? null,
    })
  } catch {
    // Audit must never undo explicit recording consent already persisted.
    console.error(`[demonstration] Failed to emit audit event: ${action}`)
  }
}

const enqueueGeneralization = async (
  prisma: PrismaClient,
  demonstrationId: string,
): Promise<void> => {
  await enqueueQueueJob(prisma, {
    idempotencyKey: `demonstration:generalize:${demonstrationId}`,
    payload: { demonstrationId },
    topic: DEMONSTRATION_GENERALIZE_TOPIC,
  })
}

const verifyTarget = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId: string
    organizationId: string
    threadId: string
    userId: string
  },
): Promise<void> => {
  const channel = await getChannelIfMember(
    prisma,
    input.userId,
    input.organizationId,
    input.channelId,
  )
  if (!channel) throw new DemonstrationError('CHANNEL_NOT_FOUND')

  const [thread, binding, agent] = await Promise.all([
    prisma.thread.findFirst({
      where: { channelId: input.channelId, id: input.threadId },
      select: { id: true },
    }),
    prisma.agentBinding.findFirst({
      where: { agentId: input.agentId, channelId: input.channelId },
      select: { id: true },
    }),
    prisma.agent.findFirst({
      where: {
        id: input.agentId,
        OR: [
          { organizationId: input.organizationId },
          { organizationId: null, systemManaged: true },
        ],
      },
      select: { id: true },
    }),
  ])
  if (!thread) throw new DemonstrationError('THREAD_NOT_FOUND')
  if (!binding || !agent) throw new DemonstrationError('AGENT_NOT_BOUND')
}

const readableForUser = async (
  prisma: PrismaClient,
  input: { channelId: string; organizationId: string; userId: string },
): Promise<boolean> => Boolean(await getChannelIfMember(
  prisma,
  input.userId,
  input.organizationId,
  input.channelId,
))

/**
 * Starts the one recording allowed for an agent/thread pair. This is a shared
 * UI/PA operation: all target ids are checked against the caller's live reach.
 */
export const startDemonstration = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    agentId: string
    channelId: string
    threadId: string
  },
): Promise<{ created: boolean; demonstration: DemonstrationRecord }> => {
  const organizationId = input.actorContext.tenant.organizationId
  const userId = input.actorContext.actor.actorId
  await expireDemonstrations(prisma, {
    agentId: input.agentId,
    organizationId,
    threadId: input.threadId,
  })
  await verifyTarget(prisma, {
    agentId: input.agentId,
    channelId: input.channelId,
    organizationId,
    threadId: input.threadId,
    userId,
  })

  try {
    const row = await prisma.demonstration.create({
      data: {
        agentId: input.agentId,
        channelId: input.channelId,
        expiresAt: new Date(Date.now() + demonstrationTtlMs()),
        organizationId,
        startedByUserId: userId,
        threadId: input.threadId,
      },
    })
    const demonstration = mapDemonstration(row)
    await emitDemonstrationAudit(prisma, input.actorContext, demonstration, 'demonstration.started')
    return { created: true, demonstration }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
    const existing = await prisma.demonstration.findFirst({
      where: {
        agentId: input.agentId,
        organizationId,
        status: 'recording',
        threadId: input.threadId,
      },
    })
    if (!existing) throw error
    if (existing.startedByUserId !== userId) {
      throw new DemonstrationError('RECORDING_ALREADY_ACTIVE')
    }
    return { created: false, demonstration: mapDemonstration(existing) }
  }
}

/** Stops a recording only for the person who explicitly armed it. */
export const stopDemonstration = async (
  prisma: PrismaClient,
  input: { actorContext: AuthorizedActionContext; demonstrationId: string },
): Promise<DemonstrationRecord | null> => {
  const organizationId = input.actorContext.tenant.organizationId
  const userId = input.actorContext.actor.actorId
  await expireDemonstrations(prisma, {
    id: input.demonstrationId,
    organizationId,
    startedByUserId: userId,
  })
  const existing = await prisma.demonstration.findFirst({
    where: {
      id: input.demonstrationId,
      organizationId,
      startedByUserId: userId,
    },
  })
  if (!existing) return null
  if (!await readableForUser(prisma, {
    channelId: existing.channelId,
    organizationId,
    userId,
  })) return null
  if (existing.status !== 'recording') {
    if (existing.status === 'captured') {
      await enqueueGeneralization(prisma, existing.id)
      return mapDemonstration(existing)
    }
    throw new DemonstrationError('NOT_RECORDING')
  }

  const changed = await prisma.demonstration.updateMany({
    data: { capturedAt: new Date(), status: 'captured' },
    where: { id: existing.id, status: 'recording' },
  })
  if (changed.count === 0) {
    const current = await prisma.demonstration.findFirst({
      where: { id: existing.id, organizationId, startedByUserId: userId },
    })
    if (!current) return null
    if (current.status === 'captured') return mapDemonstration(current)
    throw new DemonstrationError('NOT_RECORDING')
  }
  const stopped = await prisma.demonstration.findUniqueOrThrow({ where: { id: existing.id } })
  const demonstration = mapDemonstration(stopped)
  await emitDemonstrationAudit(prisma, input.actorContext, demonstration, 'demonstration.stopped')
  await enqueueGeneralization(prisma, demonstration.id)
  return demonstration
}

/** Stops the caller's active recording on the current agent/thread pair. */
export const stopActiveDemonstration = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    agentId: string
    threadId: string
  },
): Promise<DemonstrationRecord | null> => {
  const demonstration = await prisma.demonstration.findFirst({
    where: {
      agentId: input.agentId,
      organizationId: input.actorContext.tenant.organizationId,
      startedByUserId: input.actorContext.actor.actorId,
      status: 'recording',
      threadId: input.threadId,
    },
  })
  if (!demonstration) return null
  return stopDemonstration(prisma, {
    actorContext: input.actorContext,
    demonstrationId: demonstration.id,
  })
}

/** Lists only the caller's own recordings that remain reachable in the channel. */
export const listDemonstrationsForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<DemonstrationRecord[]> => {
  await expireDemonstrations(prisma, {
    organizationId: input.organizationId,
    startedByUserId: input.userId,
  })
  const rows = await prisma.demonstration.findMany({
    include: { workflowTemplate: { select: { id: true } } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    where: { organizationId: input.organizationId, startedByUserId: input.userId },
  })
  const reachable = await Promise.all(rows.map(async (row) => (
    await readableForUser(prisma, {
      channelId: row.channelId,
      organizationId: input.organizationId,
      userId: input.userId,
    }) ? mapDemonstration(row) : null
  )))
  return reachable.filter((row): row is DemonstrationRecord => row !== null)
}

/** A channel-visible consent signal, deliberately without trace details. */
export const listActiveDemonstrationsForChannel = async (
  prisma: PrismaClient,
  input: { channelId: string; organizationId: string; userId: string },
): Promise<DemonstrationRecord[]> => {
  if (!await readableForUser(prisma, input)) return []
  const rows = await prisma.demonstration.findMany({
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    where: {
      channelId: input.channelId,
      organizationId: input.organizationId,
      status: 'recording',
    },
  })
  return rows.map(mapDemonstration)
}

/** Re-enqueues an already captured draft without widening access to its trace. */
export const requestDemonstrationGeneralization = async (
  prisma: PrismaClient,
  input: { demonstrationId: string; organizationId: string; userId: string },
): Promise<DemonstrationRecord | null> => {
  const demonstration = await prisma.demonstration.findFirst({
    where: {
      id: input.demonstrationId,
      organizationId: input.organizationId,
      startedByUserId: input.userId,
    },
  })
  if (!demonstration || !await readableForUser(prisma, {
    channelId: demonstration.channelId,
    organizationId: input.organizationId,
    userId: input.userId,
  })) return null
  if (demonstration.status === 'captured') await enqueueGeneralization(prisma, demonstration.id)
  return mapDemonstration(demonstration)
}

/** Returns a draft view of one reachable recording, with its redacted steps. */
export const getDemonstrationForUser = async (
  prisma: PrismaClient,
  input: { demonstrationId: string; organizationId: string; userId: string },
): Promise<DemonstrationDetailRecord | null> => {
  await expireDemonstrations(prisma, {
    id: input.demonstrationId,
    organizationId: input.organizationId,
    startedByUserId: input.userId,
  })
  const row = await prisma.demonstration.findFirst({
    include: {
      steps: { orderBy: { sequence: 'asc' } },
      workflowTemplate: { select: { id: true } },
    },
    where: {
      id: input.demonstrationId,
      organizationId: input.organizationId,
      startedByUserId: input.userId,
    },
  })
  if (!row) return null
  if (!await readableForUser(prisma, {
    channelId: row.channelId,
    organizationId: input.organizationId,
    userId: input.userId,
  })) return null

  return DemonstrationDetailRecordSchema.parse({
    ...mapDemonstration(row),
    steps: row.steps.map(mapStep),
  })
}
