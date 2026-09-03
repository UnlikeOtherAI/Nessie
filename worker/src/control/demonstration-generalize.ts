import { randomUUID } from 'node:crypto'
import { loadConfig } from '@nessie/config'
import { writeAuditEntry } from '@nessie/db'
import { attributionFromActorContext, type LedgerIdentityService, WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import {
  acquireAgentTodoAgentLock,
  validateWorkflowGraph,
  workflowGeneralizationVocabulary,
} from '@nessie/team-admin'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
  type DemonstrationGeneralizeJobPayload,
} from '@nessie/schemas'
import { z } from 'zod'

import { runInferenceGraph } from '../run/inference.js'
import { createProviderRequestHeadersResolver } from '../run/inference-identity.js'
import { resolveUtilityModel } from '../run/execute/utility-model.js'

const config = loadConfig()
const generalizationAttempts = (): number => {
  const configured = Number(process.env['NESSIE_DEMONSTRATION_GENERALIZE_ATTEMPTS'])
  return Number.isInteger(configured) && configured > 0 ? configured : 3
}

const ModelDraftSchema = z.object({
  description: z.string().max(1_000).optional(),
  name: z.string().min(1).max(120),
  steps: z.array(z.object({
    arguments: z.record(z.unknown()).optional(),
    body: z.string().max(8_000).optional(),
    expression: z.string().max(1_000).optional(),
    instruction: z.string().max(8_000).optional(),
    title: z.string().max(160).optional(),
    toolName: z.string().max(160).optional(),
    type: z.string().max(80),
  }).strict()).min(1).max(100),
  variableSchema: z.record(z.unknown()).optional(),
}).strict()

type DemonstrationForGeneralization = {
  agent: { model: string | null; provider: string | null }
  agentId: string
  channelId: string
  id: string
  organizationId: string
  startedByUserId: string
  steps: Array<{
    argumentsJson: unknown
    runId?: string | null
    success: boolean
    toolName: string
  }>
  threadId: string
}

const safeBinding = (value: string): string => {
  const match = /^\{\{\s*workflow\.input\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
  return match ? `{{ workflow.input.${match[1]} }}` : value.replaceAll('{{', '{ {')
}

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === 'string') return safeBinding(value)
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]))
  }
  return value
}

export const normalizeDemonstrationDraft = (
  demonstration: DemonstrationForGeneralization,
  raw: unknown,
) => {
  const draft = ModelDraftSchema.parse(raw)
  const graph = {
    steps: draft.steps.map((step, index) => {
      const id = `step_${index + 1}`
      const title = step.title?.trim() || `Step ${index + 1}`
      if ((step.type === 'tool' || step.type === 'tool_call')
        && step.toolName && WORKFLOW_TOOL_IDS.has(step.toolName)) {
        return {
          id,
          title,
          type: 'tool' as const,
          input: {
            toolName: step.toolName,
            ...(sanitizeValue(step.arguments ?? {}) as Record<string, unknown>),
          },
        }
      }
      if (step.type === 'message_send' && step.body?.trim()) {
        return { id, title, type: 'message_send' as const, input: { body: safeBinding(step.body) } }
      }
      if (step.type === 'transform' && step.expression?.trim()) {
        return { id, title, type: 'transform' as const, input: { expression: step.expression } }
      }
      // Connector, executor, knowledge-write and delegation spans are agent
      // work, not deterministic workflow capabilities. Keeping their original
      // tool id out of this graph makes a raw recording impossible to replay.
      return {
        id,
        title,
        type: 'agent_task' as const,
        input: {
          agentId: demonstration.agentId,
          channelId: demonstration.channelId,
          threadId: demonstration.threadId,
          prompt: safeBinding(step.instruction?.trim() || `Complete the demonstrated ${title}.`),
        },
      }
    }),
  }
  return {
    description: draft.description?.trim() || 'Learned from a demonstrated routine.',
    graph,
    name: draft.name.trim(),
    variableSchema: sanitizeValue(draft.variableSchema ?? {}),
  }
}

const readJson = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  return JSON.parse((fenced ?? text).trim())
}

const promptFor = (demonstration: DemonstrationForGeneralization, feedback?: string): string => JSON.stringify({
  instruction: 'Return JSON only. Generalize this structural trace into a review-only Workflow draft. Never emit raw replay operations.',
  workflowVocabulary: workflowGeneralizationVocabulary,
  mapping: {
    deterministic: 'Only an allowed workflow tool may become type tool. Use its exact toolName and structured arguments.',
    fold: 'Fold executor, connector, knowledge-write, delegate, unknown tools, and unsupported types into agent_task with an instruction.',
    parameterize: 'Replace reusable literals with {{ workflow.input.name }} and describe them in variableSchema.',
  },
  trace: demonstration.steps.filter((step) => step.success).map((step) => ({
    arguments: step.argumentsJson,
    toolName: step.toolName,
  })),
  ...(feedback ? { validationFeedback: feedback } : {}),
})

const actorContextFor = (demonstration: DemonstrationForGeneralization): AuthorizedActionContext => ({
  actor: { actorId: parseUserId(demonstration.startedByUserId), actorType: 'user' },
  actionContext: {
    channelId: parseChannelId(demonstration.channelId),
    correlationId: demonstration.id,
    effectiveUserId: parseUserId(demonstration.startedByUserId),
    purpose: 'demonstration.generalize',
    requestId: `demonstration-generalize:${demonstration.id}`,
    threadId: parseThreadId(demonstration.threadId),
  },
  tenant: {
    channelId: parseChannelId(demonstration.channelId),
    organizationId: parseOrganizationId(demonstration.organizationId),
  },
})

export const generalizeDemonstration = async (
  prisma: PrismaClient,
  payload: DemonstrationGeneralizeJobPayload,
  runModel?: (
    prompt: string,
    context: AuthorizedActionContext,
    model: { id: string; model: string | null; provider: string | null },
  ) => Promise<string>,
  ledgerIdentity?: LedgerIdentityService | null,
): Promise<void> => {
  const demonstration = await prisma.demonstration.findFirst({
    include: {
      agent: { select: { model: true, provider: true } },
      steps: {
        orderBy: { sequence: 'asc' },
        select: { argumentsJson: true, runId: true, success: true, toolName: true },
      },
    },
    where: { id: payload.demonstrationId, status: 'captured' },
  })
  if (!demonstration || demonstration.steps.filter((step) => step.success).length === 0) return

  const member = await prisma.organizationMember.findFirst({
    select: { id: true },
    where: {
      organizationId: demonstration.organizationId,
      userId: demonstration.startedByUserId,
      deactivatedAt: null,
    },
  })
  if (!member) return

  const runIds = demonstration.steps.flatMap((step) => step.runId ? [step.runId] : [])
  const restrictedSource = runIds.length > 0
    ? await prisma.runBasisScope.findFirst({
      select: { runId: true },
      where: { organizationId: demonstration.organizationId, runId: { in: runIds } },
    })
    : null
  if (restrictedSource) {
    await prisma.demonstration.updateMany({
      data: {
        generalizationError: 'This recording used restricted material. Re-demonstrate it without private sources.',
      },
      where: { id: demonstration.id, status: 'captured' },
    })
    return
  }

  const context = actorContextFor(demonstration)
  const utility = await resolveUtilityModel(prisma, {
    organizationId: demonstration.organizationId,
    providerKey: demonstration.agent.provider,
  })
  const model = {
    id: demonstration.agentId,
    model: utility?.model ?? demonstration.agent.model,
    provider: utility?.provider ?? demonstration.agent.provider,
  }
  const requestHeadersForProvider = createProviderRequestHeadersResolver({
    attribution: attributionFromActorContext(context, { agentId: demonstration.agentId }),
    ledgerIdentity,
  })
  let feedback: string | undefined

  const maxAttempts = generalizationAttempts()
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const output = runModel
        ? await runModel(promptFor(demonstration, feedback), context, model)
        : (await runInferenceGraph(prisma, {
          actorContext: context,
          agent: { ...model, routingProfileId: null },
          baseMessages: [{ content: promptFor(demonstration, feedback), role: 'user' }],
          modelConfig: config.model,
          organizationId: demonstration.organizationId,
          requestHeadersForProvider,
        })).finalAnswer
      const draft = normalizeDemonstrationDraft(demonstration, readJson(output ?? ''))
      const validationIssues = await validateWorkflowGraph(prisma, context, draft.graph)
      if (validationIssues.length > 0) throw new Error(validationIssues.join(' '))
      const template = await prisma.$transaction(async (tx) => {
        const changed = await tx.demonstration.updateMany({
          data: { generalizationError: null, status: 'generalized' },
          where: { id: demonstration.id, status: 'captured' },
        })
        if (changed.count === 0) return null
        const created = await tx.workflowTemplate.create({
          data: {
            ...(payload.agentProposed ? {} : { adoptedAt: new Date() }),
            bindingSchema: {},
            createdByActorId: payload.agentProposed
              ? demonstration.agentId
              : demonstration.startedByUserId,
            createdByActorType: payload.agentProposed ? 'agent' : 'user',
            demonstrationId: demonstration.id,
            description: draft.description,
            graphJson: draft.graph as unknown as Prisma.InputJsonValue,
            name: draft.name,
            organizationId: demonstration.organizationId,
            source: 'demonstration',
            variableSchema: draft.variableSchema as Prisma.InputJsonValue,
          },
        })
        if (payload.agentProposed) {
          await acquireAgentTodoAgentLock(tx, demonstration.agentId)
          const pending = await tx.approvalRequest.count({
            where: {
              action: 'workflow.template.adopt',
              agentId: demonstration.agentId,
              organizationId: demonstration.organizationId,
              status: 'pending',
            },
          })
          if (pending >= 10) {
            throw new Error('This agent already has 10 learned workflow proposals awaiting review.')
          }
          await tx.approvalRequest.create({
            data: {
              action: 'workflow.template.adopt',
              agentId: demonstration.agentId,
              channelId: demonstration.channelId,
              context: { workflowTemplateId: created.id },
              continuationToken: randomUUID(),
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              organizationId: demonstration.organizationId,
              reason: `Agent-proposed learned workflow: ${created.name}`,
              requesterId: demonstration.agentId,
              requiredApproverRole: 'owner',
              status: 'pending',
            },
          })
        }
        return created
      })
      if (!template) return
      await writeAuditEntry(prisma, {
        action: 'demonstration.generalized', actorId: demonstration.startedByUserId, actorType: 'user',
        channelId: demonstration.channelId, metadata: { workflowTemplateId: template.id },
        organizationId: demonstration.organizationId, outcome: 'success', projectId: null,
        requestId: context.actionContext.requestId, resourceId: demonstration.id,
        resourceType: 'demonstration', teamId: null,
      })
      return
    } catch (error) {
      feedback = error instanceof Error ? error.message : 'The last draft was invalid.'
    }
  }
  await prisma.demonstration.updateMany({
    data: {
      generalizationError: 'Could not produce a safe Workflow draft. Try generalising again or re-record the routine.',
    },
    where: { id: payload.demonstrationId, status: 'captured' },
  })
}
