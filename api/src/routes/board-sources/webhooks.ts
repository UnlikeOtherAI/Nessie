import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC, BoardSourceProviderSchema } from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

import type { RouteDeps } from '../types.js'

/**
 * Vendor webhook intake.
 *
 * Public and deliberately dumb: it enqueues and answers 202. Verification —
 * signature, timestamp window, per-source token — happens in the worker with
 * the deployment secret, so a forged delivery costs one queued job and never
 * reaches a provider call or a database write. Same split the communications
 * connector uses.
 */
export const registerBoardSourceWebhookRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma } = deps

  // Trello sends a HEAD to prove the callback exists before it will register.
  app.head('/api/board-sources/webhooks/:provider/:token', async (_request, reply) =>
    reply.code(200).send(),
  )
  app.head('/api/board-sources/webhooks/:provider', async (_request, reply) =>
    reply.code(200).send(),
  )

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { provider: string; token?: string }
    const parsed = BoardSourceProviderSchema.safeParse(params.provider)
    // A 202 either way: telling an unauthenticated caller which providers this
    // deployment runs is information it has no reason to have.
    if (!parsed.success) return reply.code(202).send()

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }

    await enqueueQueueJob(prisma, {
      payload: {
        provider: parsed.data,
        headers,
        // The raw body, byte for byte: every provider signs bytes, and a
        // re-serialised object would not verify.
        rawBody: typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}),
        ...(params.token ? { token: params.token } : {}),
      },
      topic: BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
    })
    return reply.code(202).send()
  }

  app.post('/api/board-sources/webhooks/:provider/:token', handle)
  app.post('/api/board-sources/webhooks/:provider', handle)
}
