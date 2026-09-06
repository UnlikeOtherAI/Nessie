import type { AuthorizedActionContext } from '@nessie/schemas'
import { RouteGraphSchema } from '../contracts/inference-core.js'
import type {
  CreateInferenceRoutingProfileBody,
  InferenceRoutingProfileRecord,
  UpdateInferenceRoutingProfileBody,
} from '../contracts/inference-control-plane.js'
import type { InferenceRoutingMode, RouteGraph } from '../contracts/inference-core.js'
import { toJsonRecord } from './contract-helpers.js'
import {
  approveInferenceEntity,
  asJsonValue,
  mapRoutingProfileRecord,
  resetApproval,
  sameJson,
  toDbStreamPolicy,
  type PrismaClient,
} from './inference-control-plane-core.js'

const validateRouteGraph = (
  input: {
    mode: InferenceRoutingMode
    routeGraph: RouteGraph
  },
): void => {
  const graph = RouteGraphSchema.parse(input.routeGraph)
  const stageIds = new Set<string>()
  let visibleStages = 0
  let shadowStages = 0
  let advisorRoots = 0

  for (const stage of graph.stages) {
    if (stageIds.has(stage.id)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_DUPLICATE_STAGE_ID')
    }
    stageIds.add(stage.id)

    if (stage.userVisible === true) {
      visibleStages += 1
    }
    if (stage.role === 'shadow') {
      shadowStages += 1
    }
    if (stage.role === 'advisor' && !stage.inputFrom) {
      advisorRoots += 1
    }
  }

  if (visibleStages !== 1) {
    throw new Error('INFERENCE_ROUTING_PROFILE_REQUIRES_ONE_VISIBLE_STAGE')
  }

  if (input.mode === 'single' || input.mode === 'fallback') {
    if (graph.stages.some((stage) => stage.role !== 'executor')) {
      throw new Error('INFERENCE_ROUTING_PROFILE_INVALID_EXECUTOR_ONLY_GRAPH')
    }
    if (graph.stages.some((stage) => stage.inputFrom && stage.inputFrom.length > 0)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_INPUT_FROM_NOT_ALLOWED')
    }
  }

  if (input.mode === 'committee') {
    if (graph.stages.filter((stage) => stage.role === 'advisor').length < 2) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_NEEDS_ADVISORS')
    }
    if (advisorRoots !== graph.stages.filter((stage) => stage.role === 'advisor').length) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_ADVISORS_MUST_BE_ROOTS')
    }
    const terminal = graph.stages.find((stage) => stage.userVisible === true)
    if (!terminal || !['executor', 'synthesizer'].includes(terminal.role)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_TERMINAL_INVALID')
    }
  }

  if (input.mode === 'shadow') {
    const nonShadowVisible = graph.stages.filter(
      (stage) => stage.userVisible === true && stage.role !== 'shadow',
    )
    if (nonShadowVisible.length !== 1 || shadowStages < 1) {
      throw new Error('INFERENCE_ROUTING_PROFILE_SHADOW_INVALID')
    }
  }

  const adjacency = new Map<string, string[]>()
  for (const stage of graph.stages) {
    adjacency.set(stage.id, stage.inputFrom ?? [])
  }

  for (const stage of graph.stages) {
    for (const parentId of adjacency.get(stage.id) ?? []) {
      if (!stageIds.has(parentId)) {
        throw new Error('INFERENCE_ROUTING_PROFILE_MISSING_STAGE_REFERENCE')
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stageId: string) => {
    if (visited.has(stageId)) {
      return
    }
    if (visiting.has(stageId)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_CYCLE_DETECTED')
    }
    visiting.add(stageId)
    for (const parentId of adjacency.get(stageId) ?? []) {
      visit(parentId)
    }
    visiting.delete(stageId)
    visited.add(stageId)
  }
  for (const stage of graph.stages) {
    visit(stage.id)
  }
}

export const listInferenceRoutingProfiles = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<InferenceRoutingProfileRecord[]> => {
  const profiles = await prisma.inferenceRoutingProfile.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })
  return profiles.map(mapRoutingProfileRecord)
}

export const getInferenceRoutingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  routingProfileId: string,
): Promise<InferenceRoutingProfileRecord | null> => {
  const profile = await prisma.inferenceRoutingProfile.findFirst({
    where: { id: routingProfileId, organizationId },
  })
  return profile ? mapRoutingProfileRecord(profile) : null
}

export const createInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInferenceRoutingProfileBody,
): Promise<InferenceRoutingProfileRecord> => {
  validateRouteGraph({
    mode: input.mode,
    routeGraph: input.routeGraph,
  })

  const profile = await prisma.inferenceRoutingProfile.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      label: input.label,
      enabled: input.enabled ?? false,
      exposure:
        input.exposure === 'admin-only' ? 'admin_only' : input.exposure ?? 'standard',
      lifecycleStatus: 'draft',
      mode: input.mode,
      streamPolicy: toDbStreamPolicy(input.streamPolicy),
      toolMediatorProfileId: input.toolMediatorProfileId ?? null,
      routeGraph: asJsonValue(input.routeGraph),
      createdByActorId: actorContext.actor.actorId,
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapRoutingProfileRecord(profile)
}

export const updateInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  routingProfileId: string,
  input: UpdateInferenceRoutingProfileBody,
): Promise<InferenceRoutingProfileRecord | null> => {
  const profile = await prisma.inferenceRoutingProfile.findFirst({
    where: {
      id: routingProfileId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!profile) {
    return null
  }

  const nextRouteGraph = input.routeGraph
    ? RouteGraphSchema.parse(input.routeGraph)
    : undefined

  if (nextRouteGraph || input.mode || input.toolMediatorProfileId !== undefined) {
    validateRouteGraph({
      mode: input.mode ?? profile.mode,
      routeGraph: nextRouteGraph ?? RouteGraphSchema.parse(toJsonRecord(profile.routeGraph)),
    })
  }

  const currentStreamPolicy =
    profile.streamPolicy === 'buffered_judge' ? 'buffered-judge' : 'primary-only'

  const materialChanged =
    (nextRouteGraph !== undefined && !sameJson(nextRouteGraph, profile.routeGraph)) ||
    (input.mode !== undefined && input.mode !== profile.mode) ||
    (input.toolMediatorProfileId !== undefined &&
      input.toolMediatorProfileId !== profile.toolMediatorProfileId) ||
    (input.exposure !== undefined &&
      input.exposure !== (profile.exposure === 'admin_only' ? 'admin-only' : 'standard')) ||
    (input.streamPolicy !== undefined && input.streamPolicy !== currentStreamPolicy)

  const updated = await prisma.inferenceRoutingProfile.update({
    where: { id: profile.id },
    data: {
      label: input.label ?? profile.label,
      enabled: input.enabled ?? profile.enabled,
      exposure:
        input.exposure === 'admin-only'
          ? 'admin_only'
          : input.exposure ?? profile.exposure,
      mode: input.mode ?? profile.mode,
      streamPolicy:
        input.streamPolicy === undefined
          ? profile.streamPolicy
          : toDbStreamPolicy(input.streamPolicy),
      toolMediatorProfileId:
        input.toolMediatorProfileId === undefined
          ? profile.toolMediatorProfileId
          : input.toolMediatorProfileId,
      routeGraph:
        nextRouteGraph !== undefined
          ? asJsonValue(nextRouteGraph)
          : asJsonValue(profile.routeGraph),
      ...(materialChanged ? resetApproval(actorContext.actor.actorId) : {}),
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapRoutingProfileRecord(updated)
}

export const approveInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  routingProfileId: string,
): Promise<InferenceRoutingProfileRecord | null> =>
  approveInferenceEntity(
    prisma.inferenceRoutingProfile,
    actorContext.tenant.organizationId,
    routingProfileId,
    actorContext.actor.actorId,
    mapRoutingProfileRecord,
  )
