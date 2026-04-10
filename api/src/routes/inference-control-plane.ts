import type { PrismaClient as PrismaDbClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CreateInferenceCapabilityOverrideBodySchema,
  CreateInferenceCredentialBindingBodySchema,
  CreateInferenceEvalRunBodySchema,
  CreateInferenceEvalSuiteBodySchema,
  CreateInferenceModelBodySchema,
  CreateInferenceProviderBodySchema,
  CreateInferenceRoutingProfileBodySchema,
  CreateToolMediatorProfileBodySchema,
  InferenceCapabilityOverrideRecordSchema,
  InferenceCredentialBindingRecordSchema,
  InferenceEvalRunRecordSchema,
  InferenceEvalSuiteRecordSchema,
  InferenceModelRecordSchema,
  InferenceProviderRecordSchema,
  InferenceRoutingProfileRecordSchema,
  SetInferenceProviderHealthBodySchema,
  ToolMediatorProfileRecordSchema,
  UpdateInferenceCapabilityOverrideBodySchema,
  UpdateInferenceEvalRunBodySchema,
  UpdateInferenceEvalSuiteBodySchema,
  UpdateInferenceModelBodySchema,
  UpdateInferenceProviderBodySchema,
  UpdateInferenceRoutingProfileBodySchema,
  UpdateToolMediatorProfileBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  approveInferenceCapabilityOverride,
  approveInferenceEvalSuite,
  approveInferenceModel,
  approveInferenceProvider,
  approveInferenceRoutingProfile,
  approveToolMediatorProfile,
  clearInferenceCapabilityOverride,
  createInferenceCapabilityOverride,
  createInferenceCredentialBinding,
  createInferenceEvalRun,
  createInferenceEvalSuite,
  createInferenceModel,
  createInferenceProvider,
  createInferenceRoutingProfile,
  createToolMediatorProfile,
  getInferenceEvalRun,
  getInferenceEvalSuite,
  getInferenceModel,
  getInferenceProvider,
  getInferenceRoutingProfile,
  getToolMediatorProfile,
  listInferenceCapabilityOverrides,
  listInferenceCredentialBindings,
  listInferenceEvalRuns,
  listInferenceEvalSuites,
  listInferenceModels,
  listInferenceProviders,
  listInferenceRoutingProfiles,
  listToolMediatorProfiles,
  revokeInferenceCredentialBinding,
  setInferenceProviderHealth,
  updateInferenceCapabilityOverride,
  updateInferenceEvalRun,
  updateInferenceEvalSuite,
  updateInferenceModel,
  updateInferenceProvider,
  updateInferenceRoutingProfile,
  updateToolMediatorProfile,
} from '../services/inference-control-plane.js'

// The inference-control-plane service widens PrismaClient because the generated
// client lags the schema surface during local typechecking. Mirror that widening
// here so the routes can forward prisma to the service cleanly.
type InferenceServicePrismaClient = PrismaDbClient & Record<string, unknown>

export type InferenceRouteHelpers = {
  prisma: PrismaDbClient
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireOwner: (actorContext: AuthorizedActionContext, reply: FastifyReply) => boolean
}

const INFERENCE_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  INFERENCE_PROVIDER_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_PROVIDER_NOT_FOUND',
    message: 'Inference provider not found',
  },
  INFERENCE_PROVIDER_BASE_URL_REQUIRED: {
    status: 400,
    code: 'INFERENCE_PROVIDER_BASE_URL_REQUIRED',
    message: 'OpenAI-compatible providers require a baseUrl',
  },
  INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING: {
    status: 400,
    code: 'INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING',
    message: 'OpenAI-compatible providers must have a credential binding before being enabled',
  },
  INFERENCE_CREDENTIAL_BINDING_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_CREDENTIAL_BINDING_NOT_FOUND',
    message: 'Inference credential binding not found',
  },
  INFERENCE_MODEL_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_MODEL_NOT_FOUND',
    message: 'Inference model not found',
  },
  INFERENCE_MODEL_CAPABILITY_SNAPSHOT_MISMATCH: {
    status: 400,
    code: 'INFERENCE_MODEL_CAPABILITY_SNAPSHOT_MISMATCH',
    message: 'Capability snapshot does not match the requested provider/model',
  },
  INFERENCE_CAPABILITY_OVERRIDE_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_CAPABILITY_OVERRIDE_NOT_FOUND',
    message: 'Capability override not found',
  },
  INFERENCE_ROUTING_PROFILE_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_ROUTING_PROFILE_NOT_FOUND',
    message: 'Inference routing profile not found',
  },
  INFERENCE_ROUTING_PROFILE_INVALID: {
    status: 400,
    code: 'INFERENCE_ROUTING_PROFILE_INVALID',
    message: 'Inference routing profile failed validation',
  },
  INFERENCE_ROUTING_PROFILE_APPROVAL_REQUIRES_PASSING_EVAL: {
    status: 409,
    code: 'INFERENCE_ROUTING_PROFILE_APPROVAL_REQUIRES_PASSING_EVAL',
    message: 'Routing profile cannot be approved without a passing eval run since its last update',
  },
  INFERENCE_TOOL_MEDIATOR_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_TOOL_MEDIATOR_NOT_FOUND',
    message: 'Tool mediator profile not found',
  },
  INFERENCE_EVAL_SUITE_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_EVAL_SUITE_NOT_FOUND',
    message: 'Inference eval suite not found',
  },
  INFERENCE_EVAL_RUN_NOT_FOUND: {
    status: 404,
    code: 'INFERENCE_EVAL_RUN_NOT_FOUND',
    message: 'Inference eval run not found',
  },
}

const sendInferenceError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }
  const mapped = INFERENCE_ERROR_MAP[error.message]
  if (!mapped) {
    return false
  }
  sendApiError(reply, mapped.status, mapped.code, mapped.message)
  return true
}

export const registerInferenceControlPlaneRoutes = (
  app: FastifyInstance,
  helpers: InferenceRouteHelpers,
): void => {
  const { requireActorContext, requireOwner } = helpers
  const prisma = helpers.prisma as unknown as InferenceServicePrismaClient

  // ─── Providers ──────────────────────────────────────────────────────────
  app.get('/api/inference/providers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const providers = await listInferenceProviders(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(InferenceProviderRecordSchema.array().parse(providers))
  })

  app.post('/api/inference/providers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceProviderBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const provider = await createInferenceProvider(prisma, actorContext, body)
      return reply
        .code(201)
        .send(createApiResponse(InferenceProviderRecordSchema.parse(provider)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/inference/providers/:providerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { providerId } = request.params as { providerId: string }
    const provider = await getInferenceProvider(
      prisma,
      actorContext.tenant.organizationId,
      providerId,
    )
    if (!provider) {
      sendApiError(reply, 404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Inference provider not found')
      return reply
    }
    return createApiResponse(InferenceProviderRecordSchema.parse(provider))
  })

  app.patch('/api/inference/providers/:providerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { providerId } = request.params as { providerId: string }
    const body = parseInput(UpdateInferenceProviderBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const provider = await updateInferenceProvider(prisma, actorContext, providerId, body)
      if (!provider) {
        sendApiError(reply, 404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Inference provider not found')
        return reply
      }
      return createApiResponse(InferenceProviderRecordSchema.parse(provider))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/providers/:providerId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { providerId } = request.params as { providerId: string }
    const provider = await approveInferenceProvider(prisma, actorContext, providerId)
    if (!provider) {
      sendApiError(reply, 404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Inference provider not found')
      return reply
    }
    return createApiResponse(InferenceProviderRecordSchema.parse(provider))
  })

  app.post('/api/inference/providers/:providerId/health', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { providerId } = request.params as { providerId: string }
    const body = parseInput(SetInferenceProviderHealthBodySchema, request.body, reply)
    if (!body) return reply

    const provider = await setInferenceProviderHealth(prisma, actorContext, providerId, body)
    if (!provider) {
      sendApiError(reply, 404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Inference provider not found')
      return reply
    }
    return createApiResponse(InferenceProviderRecordSchema.parse(provider))
  })

  // ─── Credential bindings ────────────────────────────────────────────────
  app.get('/api/inference/credentials', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { providerId?: string }
    const bindings = await listInferenceCredentialBindings(
      prisma,
      actorContext.tenant.organizationId,
      query.providerId,
    )
    return createApiResponse(InferenceCredentialBindingRecordSchema.array().parse(bindings))
  })

  app.post('/api/inference/credentials', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceCredentialBindingBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const binding = await createInferenceCredentialBinding(prisma, actorContext, body)
      return reply
        .code(201)
        .send(createApiResponse(InferenceCredentialBindingRecordSchema.parse(binding)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/credentials/:bindingId/revoke', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { bindingId } = request.params as { bindingId: string }
    const binding = await revokeInferenceCredentialBinding(prisma, actorContext, bindingId)
    if (!binding) {
      sendApiError(
        reply,
        404,
        'INFERENCE_CREDENTIAL_BINDING_NOT_FOUND',
        'Inference credential binding not found',
      )
      return reply
    }
    return createApiResponse(InferenceCredentialBindingRecordSchema.parse(binding))
  })

  // ─── Models ─────────────────────────────────────────────────────────────
  app.get('/api/inference/models', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { providerId?: string }
    const models = await listInferenceModels(
      prisma,
      actorContext.tenant.organizationId,
      query.providerId,
    )
    return createApiResponse(InferenceModelRecordSchema.array().parse(models))
  })

  app.post('/api/inference/models', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceModelBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const model = await createInferenceModel(prisma, actorContext, body)
      return reply.code(201).send(createApiResponse(InferenceModelRecordSchema.parse(model)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/inference/models/:modelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { modelId } = request.params as { modelId: string }
    const model = await getInferenceModel(prisma, actorContext.tenant.organizationId, modelId)
    if (!model) {
      sendApiError(reply, 404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found')
      return reply
    }
    return createApiResponse(InferenceModelRecordSchema.parse(model))
  })

  app.patch('/api/inference/models/:modelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { modelId } = request.params as { modelId: string }
    const body = parseInput(UpdateInferenceModelBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const model = await updateInferenceModel(prisma, actorContext, modelId, body)
      if (!model) {
        sendApiError(reply, 404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found')
        return reply
      }
      return createApiResponse(InferenceModelRecordSchema.parse(model))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/models/:modelId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { modelId } = request.params as { modelId: string }
    const model = await approveInferenceModel(prisma, actorContext, modelId)
    if (!model) {
      sendApiError(reply, 404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found')
      return reply
    }
    return createApiResponse(InferenceModelRecordSchema.parse(model))
  })

  // ─── Capability overrides ───────────────────────────────────────────────
  app.get('/api/inference/capability-overrides', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { providerId?: string }
    const overrides = await listInferenceCapabilityOverrides(
      prisma,
      actorContext.tenant.organizationId,
      query.providerId,
    )
    return createApiResponse(
      InferenceCapabilityOverrideRecordSchema.array().parse(overrides),
    )
  })

  app.post('/api/inference/capability-overrides', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceCapabilityOverrideBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const override = await createInferenceCapabilityOverride(prisma, actorContext, body)
      return reply
        .code(201)
        .send(createApiResponse(InferenceCapabilityOverrideRecordSchema.parse(override)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.patch('/api/inference/capability-overrides/:overrideId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { overrideId } = request.params as { overrideId: string }
    const body = parseInput(UpdateInferenceCapabilityOverrideBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const override = await updateInferenceCapabilityOverride(
        prisma,
        actorContext,
        overrideId,
        body,
      )
      if (!override) {
        sendApiError(
          reply,
          404,
          'INFERENCE_CAPABILITY_OVERRIDE_NOT_FOUND',
          'Capability override not found',
        )
        return reply
      }
      return createApiResponse(InferenceCapabilityOverrideRecordSchema.parse(override))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post(
    '/api/inference/capability-overrides/:overrideId/approve',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireOwner(actorContext, reply)) return reply

      const { overrideId } = request.params as { overrideId: string }
      const override = await approveInferenceCapabilityOverride(prisma, actorContext, overrideId)
      if (!override) {
        sendApiError(
          reply,
          404,
          'INFERENCE_CAPABILITY_OVERRIDE_NOT_FOUND',
          'Capability override not found',
        )
        return reply
      }
      return createApiResponse(InferenceCapabilityOverrideRecordSchema.parse(override))
    },
  )

  app.post(
    '/api/inference/capability-overrides/:overrideId/clear',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!requireOwner(actorContext, reply)) return reply

      const { overrideId } = request.params as { overrideId: string }
      const override = await clearInferenceCapabilityOverride(prisma, actorContext, overrideId)
      if (!override) {
        sendApiError(
          reply,
          404,
          'INFERENCE_CAPABILITY_OVERRIDE_NOT_FOUND',
          'Capability override not found',
        )
        return reply
      }
      return createApiResponse(InferenceCapabilityOverrideRecordSchema.parse(override))
    },
  )

  // ─── Routing profiles ───────────────────────────────────────────────────
  app.get('/api/inference/routing-profiles', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const profiles = await listInferenceRoutingProfiles(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(InferenceRoutingProfileRecordSchema.array().parse(profiles))
  })

  app.post('/api/inference/routing-profiles', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceRoutingProfileBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const profile = await createInferenceRoutingProfile(prisma, actorContext, body)
      return reply
        .code(201)
        .send(createApiResponse(InferenceRoutingProfileRecordSchema.parse(profile)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/inference/routing-profiles/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    const profile = await getInferenceRoutingProfile(
      prisma,
      actorContext.tenant.organizationId,
      profileId,
    )
    if (!profile) {
      sendApiError(
        reply,
        404,
        'INFERENCE_ROUTING_PROFILE_NOT_FOUND',
        'Inference routing profile not found',
      )
      return reply
    }
    return createApiResponse(InferenceRoutingProfileRecordSchema.parse(profile))
  })

  app.patch('/api/inference/routing-profiles/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    const body = parseInput(UpdateInferenceRoutingProfileBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const profile = await updateInferenceRoutingProfile(
        prisma,
        actorContext,
        profileId,
        body,
      )
      if (!profile) {
        sendApiError(
          reply,
          404,
          'INFERENCE_ROUTING_PROFILE_NOT_FOUND',
          'Inference routing profile not found',
        )
        return reply
      }
      return createApiResponse(InferenceRoutingProfileRecordSchema.parse(profile))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/routing-profiles/:profileId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    try {
      const profile = await approveInferenceRoutingProfile(prisma, actorContext, profileId)
      if (!profile) {
        sendApiError(
          reply,
          404,
          'INFERENCE_ROUTING_PROFILE_NOT_FOUND',
          'Inference routing profile not found',
        )
        return reply
      }
      return createApiResponse(InferenceRoutingProfileRecordSchema.parse(profile))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  // ─── Tool mediator profiles ─────────────────────────────────────────────
  app.get('/api/inference/tool-mediators', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const profiles = await listToolMediatorProfiles(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(ToolMediatorProfileRecordSchema.array().parse(profiles))
  })

  app.post('/api/inference/tool-mediators', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateToolMediatorProfileBodySchema, request.body, reply)
    if (!body) return reply

    const profile = await createToolMediatorProfile(prisma, actorContext, body)
    return reply
      .code(201)
      .send(createApiResponse(ToolMediatorProfileRecordSchema.parse(profile)))
  })

  app.get('/api/inference/tool-mediators/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    const profile = await getToolMediatorProfile(
      prisma,
      actorContext.tenant.organizationId,
      profileId,
    )
    if (!profile) {
      sendApiError(
        reply,
        404,
        'INFERENCE_TOOL_MEDIATOR_NOT_FOUND',
        'Tool mediator profile not found',
      )
      return reply
    }
    return createApiResponse(ToolMediatorProfileRecordSchema.parse(profile))
  })

  app.patch('/api/inference/tool-mediators/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    const body = parseInput(UpdateToolMediatorProfileBodySchema, request.body, reply)
    if (!body) return reply

    const profile = await updateToolMediatorProfile(prisma, actorContext, profileId, body)
    if (!profile) {
      sendApiError(
        reply,
        404,
        'INFERENCE_TOOL_MEDIATOR_NOT_FOUND',
        'Tool mediator profile not found',
      )
      return reply
    }
    return createApiResponse(ToolMediatorProfileRecordSchema.parse(profile))
  })

  app.post('/api/inference/tool-mediators/:profileId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    const profile = await approveToolMediatorProfile(prisma, actorContext, profileId)
    if (!profile) {
      sendApiError(
        reply,
        404,
        'INFERENCE_TOOL_MEDIATOR_NOT_FOUND',
        'Tool mediator profile not found',
      )
      return reply
    }
    return createApiResponse(ToolMediatorProfileRecordSchema.parse(profile))
  })

  // ─── Eval suites ────────────────────────────────────────────────────────
  app.get('/api/inference/eval-suites', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const suites = await listInferenceEvalSuites(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(InferenceEvalSuiteRecordSchema.array().parse(suites))
  })

  app.post('/api/inference/eval-suites', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceEvalSuiteBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const suite = await createInferenceEvalSuite(prisma, actorContext, body)
      return reply
        .code(201)
        .send(createApiResponse(InferenceEvalSuiteRecordSchema.parse(suite)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/inference/eval-suites/:suiteId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { suiteId } = request.params as { suiteId: string }
    const suite = await getInferenceEvalSuite(
      prisma,
      actorContext.tenant.organizationId,
      suiteId,
    )
    if (!suite) {
      sendApiError(
        reply,
        404,
        'INFERENCE_EVAL_SUITE_NOT_FOUND',
        'Inference eval suite not found',
      )
      return reply
    }
    return createApiResponse(InferenceEvalSuiteRecordSchema.parse(suite))
  })

  app.patch('/api/inference/eval-suites/:suiteId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { suiteId } = request.params as { suiteId: string }
    const body = parseInput(UpdateInferenceEvalSuiteBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const suite = await updateInferenceEvalSuite(prisma, actorContext, suiteId, body)
      if (!suite) {
        sendApiError(
          reply,
          404,
          'INFERENCE_EVAL_SUITE_NOT_FOUND',
          'Inference eval suite not found',
        )
        return reply
      }
      return createApiResponse(InferenceEvalSuiteRecordSchema.parse(suite))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/eval-suites/:suiteId/approve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { suiteId } = request.params as { suiteId: string }
    const suite = await approveInferenceEvalSuite(prisma, actorContext, suiteId)
    if (!suite) {
      sendApiError(
        reply,
        404,
        'INFERENCE_EVAL_SUITE_NOT_FOUND',
        'Inference eval suite not found',
      )
      return reply
    }
    return createApiResponse(InferenceEvalSuiteRecordSchema.parse(suite))
  })

  // ─── Eval runs ──────────────────────────────────────────────────────────
  app.get('/api/inference/eval-runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { evalSuiteId?: string }
    const runs = await listInferenceEvalRuns(
      prisma,
      actorContext.tenant.organizationId,
      query.evalSuiteId,
    )
    return createApiResponse(InferenceEvalRunRecordSchema.array().parse(runs))
  })

  app.post('/api/inference/eval-runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(CreateInferenceEvalRunBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const run = await createInferenceEvalRun(prisma, actorContext, body)
      return reply
        .code(202)
        .send(createApiResponse(InferenceEvalRunRecordSchema.parse(run)))
    } catch (error) {
      if (sendInferenceError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/inference/eval-runs/:runId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { runId } = request.params as { runId: string }
    const run = await getInferenceEvalRun(
      prisma,
      actorContext.tenant.organizationId,
      runId,
    )
    if (!run) {
      sendApiError(reply, 404, 'INFERENCE_EVAL_RUN_NOT_FOUND', 'Inference eval run not found')
      return reply
    }
    return createApiResponse(InferenceEvalRunRecordSchema.parse(run))
  })

  app.patch('/api/inference/eval-runs/:runId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { runId } = request.params as { runId: string }
    const body = parseInput(UpdateInferenceEvalRunBodySchema, request.body, reply)
    if (!body) return reply

    // parseInput widens nested branded schemas; the service re-normalizes inputs
    // so passing the parsed body is safe.
    const run = await updateInferenceEvalRun(
      prisma,
      actorContext,
      runId,
      body as Parameters<typeof updateInferenceEvalRun>[3],
    )
    if (!run) {
      sendApiError(reply, 404, 'INFERENCE_EVAL_RUN_NOT_FOUND', 'Inference eval run not found')
      return reply
    }
    return createApiResponse(InferenceEvalRunRecordSchema.parse(run))
  })
}
