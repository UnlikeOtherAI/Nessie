import { loadConfig } from '@nessie/config'
import type { PrismaClient } from '@prisma/client'
import type {
  ConsolidationCandidateExtractor,
  ConsolidationExtractionInput,
} from '@nessie/memory'
import {
  recordInferenceUsage,
  type LedgerIdentityService,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
  type MemoryConsolidationInferenceOrigin,
} from '@nessie/schemas'

import { runInferenceGraph } from './inference.js'
import { createProviderRequestHeadersResolver } from './inference-identity.js'
import { resolveUtilityModel } from './execute/utility-model.js'

const modelConfig = loadConfig().model
export const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 1_000

type ExtractionModel = {
  model: string | null
  provider: string | null
}

type ExtractionDeps = {
  ledgerIdentity?: LedgerIdentityService | null
  prisma: PrismaClient
  recordUsage?: typeof recordInferenceUsage
  resolveUtility?: typeof resolveUtilityModel
  runInference?: typeof runInferenceGraph
}

const actorContextFor = (
  origin: MemoryConsolidationInferenceOrigin,
): AuthorizedActionContext => ({
  actor: {
    actorId: origin.agentId,
    actorType: 'agent',
    roles: ['system'],
  },
  actionContext: {
    agentId: parseAgentId(origin.agentId),
    channelId: parseChannelId(origin.channelId),
    correlationId: origin.requestId,
    effectiveUserId: parseUserId(origin.userId),
    purpose: 'memory.consolidation.extract',
    requestId: origin.requestId,
    taskId: parseTaskId(origin.taskId),
    teamId: parseTeamId(origin.teamId),
    threadId: parseThreadId(origin.threadId),
  },
  tenant: {
    channelId: parseChannelId(origin.channelId),
    organizationId: parseOrganizationId(origin.organizationId),
    ...(origin.projectId ? { projectId: parseProjectId(origin.projectId) } : {}),
    teamId: parseTeamId(origin.teamId),
  },
})

const extractionPrompt = (input: ConsolidationExtractionInput): string => JSON.stringify({
  instruction: [
    'Return JSON only.',
    'Extract durable facts, preferences, constraints, reasons, and intentions worth remembering.',
    'Judge meaning in the language used. Do not translate or romanize content.',
    'Every candidate must cite only message ids from the supplied messages.',
    'Return no candidate when the conversation contains nothing durable.',
  ].join(' '),
  limits: {
    candidates: 4,
    contentCharacters: 320,
    sourceMessageIdsPerCandidate: 12,
  },
  outputSchema: {
    candidates: [{
      content: 'string',
      importance: 'number from 0 to 1',
      memoryCategory: 'intent | reason | constraint | preference | fact',
      sourceMessageIds: ['message uuid'],
    }],
  },
  messages: input.messages,
})

const loadExtractionModel = async (
  deps: ExtractionDeps,
  organizationId: string,
): Promise<ExtractionModel> => {
  // All memory work is deployment-billed, including memory derived from a run
  // that used a personal subscription. Resolve the utility model against the
  // deployment route; mutable agent selection and the source run's personal
  // pin never participate in this call.
  const fallback = {
    model: modelConfig.modelName ?? null,
    provider: modelConfig.serviceId ?? modelConfig.provider,
  }
  const utilityProvider = fallback.provider
  const utility = await (deps.resolveUtility ?? resolveUtilityModel)(deps.prisma, {
    organizationId,
    providerKey: utilityProvider,
  })
  return utility ?? fallback
}

export const createMemoryCandidateExtractor = (
  deps: ExtractionDeps,
  input: { origin: MemoryConsolidationInferenceOrigin },
): ConsolidationCandidateExtractor => async (extraction) => {
  const context = actorContextFor(input.origin)
  const target = await loadExtractionModel(deps, input.origin.organizationId)
  const result = await (deps.runInference ?? runInferenceGraph)(deps.prisma, {
    actorContext: context,
    agent: {
      id: input.origin.agentId,
      model: target.model,
      provider: target.provider,
      routingProfileId: null,
    },
    baseMessages: [{ content: extractionPrompt(extraction), role: 'user' }],
    maxOutputTokensOverride: MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
    modelConfig,
    organizationId: input.origin.organizationId,
    reasoningEffort: 'low',
    requestHeadersForProvider: createProviderRequestHeadersResolver({
      attribution: input.origin,
      ledgerIdentity: deps.ledgerIdentity,
    }),
  })

  // Meter the provider result before parsing it. A malformed response is still
  // real spend and the queue retry may make a later, separately-metered call.
  await (deps.recordUsage ?? recordInferenceUsage)(deps.prisma, {
    attribution: input.origin,
    invocations: result.invocations,
  })
  if (result.status !== 'completed' || typeof result.finalAnswer !== 'string') {
    throw new Error('Memory extraction inference did not complete')
  }
  return JSON.parse(result.finalAnswer)
}
