import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { resolvePageLimit } from '@nessie/schemas'
import type { LedgerIdentityService } from '@nessie/runtime'
import {
  ledgerAgentModelCatalogRequestHeaders,
  LedgerAgentModelCatalogError,
} from '@nessie/team-admin'

import {
  DeploymentModelCatalogQuerySchema,
  DeploymentModelRecordSchema,
  InferenceModelTestResultSchema,
  SetDeploymentModelEnabledBodySchema,
  TestInferenceModelBodySchema,
} from '../contracts/inference-model-catalog.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  DeploymentModelError,
  listDeploymentModelCatalog,
  setDeploymentModelEnabled,
} from '../services/inference-model-catalog.js'
import { runInferenceModelTest } from '../services/inference-model-test.js'
import type { PrismaClient as WidenedPrismaClient } from '../services/inference-control-plane-core.js'

/**
 * The owner-facing model catalogue: what this deployment can run, what is
 * switched on, and whether a given pair actually answers.
 *
 * Separate from `inference-control-plane.ts` because it answers a different
 * question with a different source. That module administers the organisation's
 * own authored rows; this one reads **Ledger's live catalogue** and folds those
 * rows in. Every route here carries `requireActorContext` + `requireOwner`, the
 * same gate the control plane uses.
 */

export type InferenceModelCatalogRouteHelpers = {
  config: ModelConfig
  ledgerIdentity: LedgerIdentityService | null
  prisma: PrismaClient
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireOwner: (actorContext: AuthorizedActionContext, reply: FastifyReply) => boolean
}

/**
 * A catalogue that cannot be read is said plainly rather than guessed at: the
 * page renders the refusal instead of a list that might no longer be true.
 */
const sendCatalogueError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof LedgerAgentModelCatalogError) {
    sendApiError(reply, 503, error.code, error.message)
    return true
  }
  if (error instanceof DeploymentModelError) {
    sendApiError(reply, 400, error.code, error.message)
    return true
  }
  return false
}

export const registerInferenceModelCatalogRoutes = (
  app: FastifyInstance,
  helpers: InferenceModelCatalogRouteHelpers,
): void => {
  const { config, ledgerIdentity, prisma, requireActorContext, requireOwner } = helpers
  const widenedPrisma = prisma as WidenedPrismaClient

  const catalogueInput = async (actorContext: AuthorizedActionContext) => ({
    config,
    ...(process.env.LEDGER_PUBLIC_URL
      ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
      : {}),
    organizationId: actorContext.tenant.organizationId,
    requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
      actorContext,
      ledgerIdentity,
    }),
  })

  app.get('/api/inference/model-catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = parseInput(DeploymentModelCatalogQuerySchema, request.query, reply)
    if (!query) return reply

    try {
      const page = await listDeploymentModelCatalog(widenedPrisma, {
        ...(await catalogueInput(actorContext)),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.direction ? { direction: query.direction } : {}),
        limit: resolvePageLimit(query.limit),
      })
      return createApiResponse(
        DeploymentModelRecordSchema.array().parse(page.data),
        page.meta,
      )
    } catch (error) {
      if (sendCatalogueError(reply, error)) return reply
      throw error
    }
  })

  app.patch('/api/inference/model-catalog', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(SetDeploymentModelEnabledBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const record = await setDeploymentModelEnabled(widenedPrisma, actorContext, {
        ...(await catalogueInput(actorContext)),
        enabled: body.enabled,
        model: body.model,
        provider: body.provider,
      })
      return createApiResponse(DeploymentModelRecordSchema.parse(record))
    } catch (error) {
      if (sendCatalogueError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/inference/models/test', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(TestInferenceModelBodySchema, request.body, reply)
    if (!body) return reply

    // A refusal by the provider is a *result*, not an error status: the page
    // renders the provider's own words beside the pair that produced them, so
    // an owner can tell a bad key from a retired model from a timeout.
    const result = await runInferenceModelTest({
      actorContext,
      config,
      ledgerIdentity,
      logger: app.log,
      model: body.model,
      prisma,
      provider: body.provider,
    })
    return createApiResponse(InferenceModelTestResultSchema.parse(result))
  })
}
