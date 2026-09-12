import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  activatePersonalBrowserAccessGrant,
  isCloudBrowserError,
  revokePersonalBrowserAccessGrant,
} from '@nessie/browser-cloud'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { z } from 'zod'

import { ActivatePersonalBrowserAccessGrantBodySchema } from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { requestRunCancellation } from '../services/runs.js'
import { withLiveBrowserSession } from './browser-cloud-live-session.js'
import type { RouteDeps } from './types.js'

const GrantParamsSchema = z.object({ grantId: z.string().uuid() }).strict()

const sendGrantError = (reply: FastifyReply, error: unknown): boolean => {
  if (!isCloudBrowserError(error)) return false
  const status = error.code === 'CLOUD_BROWSER_EXPIRED' ? 409
    : error.code === 'CLOUD_BROWSER_NO_CONNECTION' ? 409
      : error.code === 'CLOUD_BROWSER_UNREACHABLE' ? 502 : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}

/** A cancelled login offer must not strand its exact run at a card forever. */
const cancelWaitingGrantRun = async (
  deps: RouteDeps,
  input: { organizationId: string; runId: string; userId: string },
): Promise<void> => {
  await requestRunCancellation(deps.prisma, {
    cancelledByUserId: input.userId,
    organizationId: input.organizationId,
    runId: input.runId,
  })
}

/** Private, task-scoped browser access for a waiting login card. */
export const registerBrowserPersonalAccessRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const resolver = createMcpSecretResolver(deps.prisma, deps.encryptionKeyRing)
  const browserDeps = {
    encryptionSecret: deps.encryptionKeyRing,
    prisma: deps.prisma,
    resolveSecret: (ref: string) => resolver.resolve(ref),
  }

  app.post('/api/browser-personal-access-grants/:grantId/activate', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const parsed = GrantParamsSchema.safeParse(request.params)
    if (!parsed.success) {
      sendApiError(reply, 404, 'BROWSER_ACCESS_NOT_FOUND', 'Private browser access is unavailable.')
      return reply
    }
    const body = parseInput(ActivatePersonalBrowserAccessGrantBodySchema, request.body, reply)
    if (!body) return reply
    const grant = await deps.prisma.browserPersonalAccessGrant.findFirst({
      where: {
        id: parsed.data.grantId,
        organizationId: actor.tenant.organizationId,
        userId: actor.actor.actorId,
      },
      select: { id: true, runId: true },
    })
    if (!grant) {
      sendApiError(reply, 404, 'BROWSER_ACCESS_NOT_FOUND', 'Private browser access is unavailable.')
      return reply
    }
    try {
      const activated = await activatePersonalBrowserAccessGrant(browserDeps, {
        grantId: grant.id,
        userId: actor.actor.actorId,
        ...(body.viewport ? { viewport: body.viewport } : {}),
      })
      // A temporary login session starts from no context. Land it on the
      // immutable first approved origin before its controller sees a frame;
      // a blank tab makes Start look successful without a safe destination.
      const navigated = await withLiveBrowserSession(deps.prisma, {
        encryptionSecret: deps.encryptionKeyRing,
        sessionId: activated.sessionId,
      }, async (cdp) => {
        await cdp.call('Page.navigate', { url: activated.initialOrigin })
        return true
      })
      if (!navigated) {
        await revokePersonalBrowserAccessGrant(browserDeps, {
          grantId: grant.id,
          releasedBy: 'initial_origin_unreachable',
        })
        await cancelWaitingGrantRun(deps, {
          organizationId: actor.tenant.organizationId,
          runId: grant.runId,
          userId: actor.actor.actorId,
        })
        sendApiError(
          reply,
          502,
          'CLOUD_BROWSER_UNREACHABLE',
          'The private browser could not open its approved sign-in site. Ask the agent to request access again.',
        )
        return reply
      }
      return createApiResponse({
        expiresAt: activated.expiresAt.toISOString(),
        sessionId: activated.sessionId,
      })
    } catch (error) {
      if (sendGrantError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/browser-personal-access-grants/:grantId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const parsed = GrantParamsSchema.safeParse(request.params)
    if (!parsed.success) return reply.code(204).send()
    // The lifecycle revokes locally before it attempts the provider release.
    // It still checks the immutable grant owner before that write.
    const grant = await deps.prisma.browserPersonalAccessGrant.findFirst({
      where: {
        id: parsed.data.grantId,
        organizationId: actor.tenant.organizationId,
        userId: actor.actor.actorId,
      },
      select: { id: true, runId: true },
    })
    if (!grant) return reply.code(204).send()
    try {
      const revoked = await revokePersonalBrowserAccessGrant(browserDeps, {
        grantId: grant.id,
        releasedBy: 'person_cancelled_login',
      })
      if (revoked) {
        await cancelWaitingGrantRun(deps, {
          organizationId: actor.tenant.organizationId,
          runId: grant.runId,
          userId: actor.actor.actorId,
        })
      }
      return reply.code(204).send()
    } catch (error) {
      // The lifecycle makes the grant unusable before it tries the provider.
      // A provider-close failure therefore cannot leave its card/run waiting
      // for a browser the person explicitly withdrew.
      const terminal = await deps.prisma.browserPersonalAccessGrant.findFirst({
        where: {
          id: grant.id,
          organizationId: actor.tenant.organizationId,
          status: { in: ['revoked', 'expired'] },
          userId: actor.actor.actorId,
        },
        select: { runId: true },
      })
      if (terminal) {
        await cancelWaitingGrantRun(deps, {
          organizationId: actor.tenant.organizationId,
          runId: terminal.runId,
          userId: actor.actor.actorId,
        })
      }
      if (sendGrantError(reply, error)) return reply
      throw error
    }
  })
}
