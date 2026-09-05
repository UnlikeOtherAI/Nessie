import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PlanRecord, PlanStepRecord } from '../contracts.js'
import {
  parseOptional,
  toInputJsonObjectWithDefault,
  toJsonRecord,
} from './contract-helpers.js'

export const PLAN_ERROR_CODES = {
  STEP_SEQUENCE_CONFLICT: 'PLAN_STEP_SEQUENCE_CONFLICT',
} as const

export class PlanError extends Error {
  override readonly name = 'PlanError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

const mapPlanRecord = (plan: {
  agentId: string | null
  channelId: string | null
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  goal: string
  id: string
  organizationId: string
  projectId: string | null
  runId: string | null
  status: 'active' | 'cancelled' | 'completed' | 'draft' | 'failed' | 'waiting'
  summary: string | null
  teamId: string | null
  updatedAt: Date
}): PlanRecord => ({
  id: plan.id,
  organizationId: parseOrganizationId(plan.organizationId),
  projectId: plan.projectId ?? undefined,
  teamId: plan.teamId ?? undefined,
  channelId: parseOptional(plan.channelId, parseChannelId),
  runId: parseOptional(plan.runId, parseRunId),
  agentId: parseOptional(plan.agentId, parseAgentId),
  goal: plan.goal,
  summary: plan.summary ?? undefined,
  status: plan.status,
  createdByActorType: plan.createdByActorType,
  createdByActorId: plan.createdByActorId,
  createdAt: plan.createdAt.toISOString(),
  updatedAt: plan.updatedAt.toISOString(),
})

const mapPlanStepRecord = (step: {
  artifacts: unknown
  assignedAgentId: string | null
  createdAt: Date
  id: string
  payload: unknown
  planId: string
  sequence: number
  status: 'blocked' | 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
  title: string
  type: string
  updatedAt: Date
}): PlanStepRecord => ({
  id: step.id,
  planId: step.planId,
  assignedAgentId: parseOptional(step.assignedAgentId, parseAgentId),
  type: step.type,
  title: step.title,
  sequence: step.sequence,
  status: step.status,
  payload: toJsonRecord(step.payload),
  artifacts: toJsonRecord(step.artifacts),
  createdAt: step.createdAt.toISOString(),
  updatedAt: step.updatedAt.toISOString(),
})

export const listPlans = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    agentId?: string
    status?: PlanRecord['status']
  },
): Promise<PlanRecord[]> => {
  const plans = await prisma.plan.findMany({
    where: {
      organizationId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return plans.map(mapPlanRecord)
}

export const getPlan = async (
  prisma: PrismaClient,
  organizationId: string,
  planId: string,
): Promise<{ plan: PlanRecord; steps: PlanStepRecord[] } | null> => {
  const plan = await prisma.plan.findFirst({
    where: {
      id: planId,
      organizationId,
    },
  })
  if (!plan) {
    return null
  }

  const steps = await prisma.planStep.findMany({
    where: { planId },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  })

  return {
    plan: mapPlanRecord(plan),
    steps: steps.map(mapPlanStepRecord),
  }
}

export const createPlan = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    agentId?: string
    channelId?: string
    goal: string
    runId?: string
    summary?: string
  },
): Promise<PlanRecord> => {
  const plan = await prisma.plan.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
      channelId: input.channelId,
      runId: input.runId,
      agentId: input.agentId,
      goal: input.goal,
      summary: input.summary,
      status: 'draft',
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapPlanRecord(plan)
}

export const addPlanStep = async (
  prisma: PrismaClient,
  organizationId: string,
  planId: string,
  input: {
    artifacts?: Record<string, unknown>
    assignedAgentId?: string
    payload?: Record<string, unknown>
    sequence?: number
    title: string
    type: string
  },
): Promise<PlanStepRecord | null> => {
  const step = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${planId}),
        hashtext('plan_steps')
      )
    `

    const plan = await tx.plan.findFirst({
      where: {
        id: planId,
        organizationId,
      },
      select: { id: true },
    })
    if (!plan) {
      return null
    }

    const sequence =
      input.sequence ??
      (((await tx.planStep.aggregate({
        where: { planId },
        _max: { sequence: true },
      }))._max.sequence ?? -1) + 1)

    try {
      return await tx.planStep.create({
        data: {
          planId,
          assignedAgentId: input.assignedAgentId,
          type: input.type,
          title: input.title,
          sequence,
          payload: toInputJsonObjectWithDefault(input.payload) as Prisma.InputJsonValue,
          artifacts: toInputJsonObjectWithDefault(input.artifacts) as Prisma.InputJsonValue,
        },
      })
    }
    catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new PlanError(
          PLAN_ERROR_CODES.STEP_SEQUENCE_CONFLICT,
          'A step with this sequence already exists for the plan',
        )
      }
      throw error
    }
  })

  return step ? mapPlanStepRecord(step) : null
}
