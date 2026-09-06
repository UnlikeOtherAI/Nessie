import { createHash } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC, BoardSourceProviderSchema } from '@nessie/schemas'
import { type BoardSourceProvider, resolveBoardSourceAdapter } from '@nessie/board-sources'
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
 *
 * The one thing it does read is the delivery id, because the queue is where a
 * provider retry has to collapse: `applyInboundItem` serialises two appliers of
 * one item, but two jobs still cost two full re-reads of the provider's API
 * (audit 9.1, docs/standards/horizontal-scaling.md § 3).
 */

/**
 * The idempotency key for one delivery.
 *
 * The provider's own delivery id when it has one, and otherwise a hash of the
 * body — a retry repeats the bytes, so the hash collapses it. Both are scoped
 * by the callback token, because Trello sends *one* action id to every webhook
 * watching that board: keying on the id alone would drop the delivery meant for
 * the second source, whose token is the only thing that verifies it.
 */
const deliveryIdempotencyKey = (
  provider: BoardSourceProvider,
  token: string | undefined,
  headers: Record<string, string>,
  rawBody: string,
): string => {
  const scope = `board-source-webhook:${provider}:${token ?? '-'}`
  let deliveryId: string | null = null
  try {
    deliveryId = resolveBoardSourceAdapter(provider).parseWebhook({
      provider,
      headers,
      rawBody,
      ...(token ? { token } : {}),
    }).deliveryId
  } catch {
    // An unregistered provider or a body that is not the JSON this adapter
    // expects. Neither is worth a 4xx from a route that answers 202 to
    // everything; the body hash still dedupes the retry.
  }
  if (deliveryId) return `${scope}:${deliveryId}`
  return `${scope}:body:${createHash('sha256').update(rawBody).digest('hex')}`
}

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

    // The raw body, byte for byte: every provider signs bytes, and a
    // re-serialised object would not verify.
    const rawBody =
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {})

    await enqueueQueueJob(prisma, {
      idempotencyKey: deliveryIdempotencyKey(parsed.data, params.token, headers, rawBody),
      payload: {
        provider: parsed.data,
        headers,
        rawBody,
        ...(params.token ? { token: params.token } : {}),
      },
      topic: BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
    })
    return reply.code(202).send()
  }

  app.post('/api/board-sources/webhooks/:provider/:token', handle)
  app.post('/api/board-sources/webhooks/:provider', handle)
}
