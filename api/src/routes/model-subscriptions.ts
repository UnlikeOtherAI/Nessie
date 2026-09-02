import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  disconnectSubscription,
  linkSubscription,
  listSubscriptionAdapters,
  listUserSubscriptions,
  ModelSubscriptionError,
  requireSubscriptionAdapter,
  SUBSCRIPTION_ERROR_CODES,
  type SubscriptionCoordinatorDeps,
} from '@nessie/model-subscriptions'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

/**
 * Personal model subscriptions — a person's own consumer AI plans.
 *
 * Everything here is scoped to the acting user: there is no owner-level list,
 * no cross-user read, and no route that returns credential material. A
 * subscription is a person's own property, and an organization owner has no
 * more claim on their linked account than on their password manager.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.7.
 */

const LinkSubscriptionBodySchema = z.object({
  provider: z.string().min(1),
  /** Pasted console key for an `api_key` adapter. Never echoed back. */
  apiKey: z.string().min(8).max(4096),
  /** Set to re-link an existing row; refuses a different provider account. */
  subscriptionId: z.string().uuid().optional(),
})

const HTTP_STATUS_BY_CODE: Record<string, number> = {
  [SUBSCRIPTION_ERROR_CODES.ACCOUNT_MISMATCH]: 409,
  [SUBSCRIPTION_ERROR_CODES.ADAPTER_UNKNOWN]: 400,
  [SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING]: 409,
  [SUBSCRIPTION_ERROR_CODES.NOT_ACTIVE]: 409,
  [SUBSCRIPTION_ERROR_CODES.NOT_FOUND]: 404,
  [SUBSCRIPTION_ERROR_CODES.OWNER_INACTIVE]: 403,
  [SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE]: 503,
  [SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED]: 400,
}

const sendSubscriptionError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (!(error instanceof ModelSubscriptionError)) return false
  sendApiError(
    reply,
    HTTP_STATUS_BY_CODE[error.code] ?? 400,
    error.code,
    error.message,
  )
  return true
}

/**
 * The list shape. Deliberately carries no vault reference, no token, no
 * expiry-derived secret metadata — only what the settings card renders and what
 * the picker needs to tell two accounts apart.
 */
const serializeSubscription = (row: {
  accountLabel: string | null
  createdAt: Date
  healthDetail: string | null
  healthReason: string
  id: string
  lastUsedAt: Date | null
  provider: string
  status: string
}) => {
  const adapter = requireSubscriptionAdapter(row.provider)
  return {
    accountLabel: row.accountLabel,
    createdAt: row.createdAt.toISOString(),
    displayName: adapter.displayName,
    healthDetail: row.healthDetail,
    healthReason: row.healthReason,
    id: row.id,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    models: adapter.models,
    provider: row.provider,
    status: row.status,
  }
}

export const registerModelSubscriptionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  const coordinator = (): SubscriptionCoordinatorDeps => ({
    prisma,
    secretStore: deps.subscriptionSecrets ?? null,
  })

  /** What this deployment can link, and whether linking works at all. */
  app.get('/api/model-subscriptions/providers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    return createApiResponse({
      // Stated plainly rather than discovered through a failed link: without a
      // configured vault there is nowhere safe to keep the credential, and the
      // settings page says so instead of offering a button that cannot work.
      available: deps.subscriptionSecrets != null,
      providers: listSubscriptionAdapters().map((adapter) => ({
        authStrategy: adapter.authStrategy,
        displayName: adapter.displayName,
        key: adapter.key,
        models: adapter.models,
        termsNote: adapter.termsNote,
      })),
    })
  })

  app.get('/api/model-subscriptions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const rows = await listUserSubscriptions(coordinator(), {
      activeOnly: false,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(rows.map(serializeSubscription))
  })

  app.post('/api/model-subscriptions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(LinkSubscriptionBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const { created, subscription } = await linkSubscription(coordinator(), {
        bundle: { accessToken: body.apiKey },
        organizationId: actorContext.tenant.organizationId,
        providerKey: body.provider,
        ...(body.subscriptionId ? { subscriptionId: body.subscriptionId } : {}),
        userId: actorContext.actor.actorId,
      })
      // Metadata only: the audit trail records that a link happened and to
      // which account, never the credential or its vault location.
      await emitAuditEvent(prisma, {
        action: created ? 'model_subscription.linked' : 'model_subscription.relinked',
        actorContext,
        metadata: {
          provider: subscription.provider,
          providerAccountId: subscription.providerAccountId,
        },
        outcome: 'success',
        resourceId: subscription.id,
        resourceType: 'model_subscription',
      })
      return reply.code(created ? 201 : 200).send(
        createApiResponse(serializeSubscription(subscription)),
      )
    } catch (error) {
      if (sendSubscriptionError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/model-subscriptions/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(
      z.object({ id: z.string().uuid() }),
      request.params,
      reply,
    )
    if (!params) return reply

    try {
      await disconnectSubscription(coordinator(), {
        organizationId: actorContext.tenant.organizationId,
        subscriptionId: params.id,
        // Scoped to the acting user, so one member can never disconnect
        // another's link — the 404 is indistinguishable from "does not exist".
        userId: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        action: 'model_subscription.disconnected',
        actorContext,
        outcome: 'success',
        resourceId: params.id,
        resourceType: 'model_subscription',
      })
      return reply.code(204).send()
    } catch (error) {
      if (sendSubscriptionError(reply, error)) return reply
      throw error
    }
  })
}
