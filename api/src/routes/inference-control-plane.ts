import type { PrismaClient as PrismaDbClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CreateInferenceCredentialBindingBodySchema,
  CreateInferenceModelBodySchema,
  CreateInferenceProviderBodySchema,
  CreateInferenceRoutingProfileBodySchema,
  InferenceCredentialBindingRecordSchema,
  InferenceModelRecordSchema,
  InferenceProviderRecordSchema,
  InferenceRoutingProfileRecordSchema,
  SetInferenceProviderHealthBodySchema,
  UpdateInferenceModelBodySchema,
  UpdateInferenceProviderBodySchema,
  UpdateInferenceRoutingProfileBodySchema,
} from '../contracts/inference-control-plane.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createInferenceCredentialBinding,
  listInferenceCredentialBindings,
  revokeInferenceCredentialBinding,
} from '../services/inference-credential-bindings.js'
import {
  approveInferenceModel,
  createInferenceModel,
  getInferenceModel,
  listInferenceModels,
  updateInferenceModel,
} from '../services/inference-models.js'
import {
  approveInferenceProvider,
  createInferenceProvider,
  getInferenceProvider,
  listInferenceProviders,
  setInferenceProviderHealth,
  updateInferenceProvider,
} from '../services/inference-providers.js'
import {
  approveInferenceRoutingProfile,
  createInferenceRoutingProfile,
  getInferenceRoutingProfile,
  listInferenceRoutingProfiles,
  updateInferenceRoutingProfile,
} from '../services/inference-routing-profiles.js'

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
  INFERENCE_PROVIDER_BASE_URL_UNSAFE: {
    status: 400,
    code: 'INFERENCE_PROVIDER_BASE_URL_UNSAFE',
    message: 'The provider baseUrl must be a public http(s) address',
  },
  INFERENCE_ENV_REF_FORBIDDEN: {
    status: 400,
    code: 'INFERENCE_ENV_REF_FORBIDDEN',
    message:
      'New caller-chosen authSecretRef env references are not accepted. Configure inference credentials at the deployment level.',
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
}
