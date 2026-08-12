import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
  type WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'
import { resolveInstallationPinnedGraph } from '@nessie/workspace-admin'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import {
  type DispatchTriggerResult,
  isTriggerDeliveryDedupeConflict,
  loadExistingDeliveryRun,
  mapTriggerDeliveryRecord,
  mapTriggerRecord,
  normalizePayload,
} from './trigger-shared.js'

export const dispatchWorkflowTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext?: AuthorizedActionContext
    dedupeKey?: string
    loadTrigger: () => Promise<
      Awaited<ReturnType<PrismaClient['agentTrigger']['findUnique']>>
    >
    payload?: unknown
    prompt?: string
    source: string
    trigger: {
      id: string
      type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
      workflowInstallation: {
        active: boolean
        channelId: string | null
        id: string
        organizationId: string
        projectId: string | null
        status: 'active' | 'disabled' | 'draft' | 'paused'
        teamId: string | null
      } | null
    } & Parameters<typeof mapTriggerRecord>[0]
  },
): Promise<DispatchTriggerResult> => {
  const installation = input.trigger.workflowInstallation
  // W8: `paused` must actually pause. Anything but an unambiguous active
  // installation refuses to fire — one lifecycle read, shared with the API
  // (`isWorkflowInstallationRunnable` in services/workflows.ts).
  if (
    !installation ||
    installation.status !== 'active' ||
    !installation.active
  ) {
    return { kind: 'rejected', reason: 'workflow_installation_not_ready' }
  }

  if (input.dedupeKey) {
    const existing = await loadExistingDeliveryRun(prisma, {
      dedupeKey: input.dedupeKey,
      triggerId: input.trigger.id,
    })
    if (existing?.workflowRunId) {
      return {
        kind: 'queued',
        delivery: mapTriggerDeliveryRecord({
          ...existing.delivery,
          run: existing.delivery.run,
        }),
        existing: true,
        trigger: mapTriggerRecord(input.trigger),
        workflowRunId: existing.workflowRunId,
      }
    }
  }

  const actorContext =
    input.actorContext ??
    ({
      actor: {
        actorId: installation.id,
        actorType: 'service',
        roles: ['system'],
      },
      actionContext: {
        ...(installation.channelId
          ? { channelId: parseChannelId(installation.channelId) }
          : {}),
        purpose: `trigger:${input.trigger.type}`,
        requestId: randomUUID(),
        sessionId: undefined,
      },
      tenant: {
        organizationId: parseOrganizationId(installation.organizationId),
        projectId: installation.projectId ? parseProjectId(installation.projectId) : undefined,
        teamId: installation.teamId ? parseTeamId(installation.teamId) : undefined,
      },
    })

  const normalizedPayload = normalizePayload(input.payload)

  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.agentTriggerDelivery.create({
        data: {
          payload: normalizedPayload,
          dedupeKey: input.dedupeKey,
          source: input.source,
          status: 'pending',
          triggerId: input.trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      const pinnedGraph = await resolveInstallationPinnedGraph(tx, installation.id)

      const workflowRun = await tx.workflowRun.create({
        data: {
          installationId: installation.id,
          organizationId: installation.organizationId,
          // W4: freeze the installed graph this run executes from.
          graphSnapshot: pinnedGraph,
          triggerId: input.trigger.id,
          triggerDeliveryId: delivery.id,
          input: (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : { payload: input.payload ?? null }) as Prisma.InputJsonValue,
          startedByActorType: actorContext.actor.actorType,
          startedByActorId: actorContext.actor.actorId,
        },
      })

      const jobPayload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: workflowRun.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${workflowRun.id}`,
        payload: jobPayload,
        topic: 'workflow.run.execute',
      })

      const completedDelivery = await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })

      return { completedDelivery, workflowRun }
    })

    return {
      kind: 'queued',
      delivery: mapTriggerDeliveryRecord(result.completedDelivery),
      existing: false,
      trigger: mapTriggerRecord(input.trigger),
      workflowRunId: result.workflowRun.id,
    }
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isTriggerDeliveryDedupeConflict(error)
    ) {
      const existing = await loadExistingDeliveryRun(prisma, {
        dedupeKey: input.dedupeKey,
        triggerId: input.trigger.id,
      })
      if (existing?.workflowRunId) {
        const latestTrigger = await input.loadTrigger()
        if (!latestTrigger) {
          return { kind: 'rejected', reason: 'trigger_not_found' }
        }
        return {
          kind: 'queued',
          delivery: mapTriggerDeliveryRecord({
            ...existing.delivery,
            run: existing.delivery.run,
          }),
          existing: true,
          trigger: mapTriggerRecord(latestTrigger),
          workflowRunId: existing.workflowRunId,
        }
      }
    }

    throw error
  }
}
