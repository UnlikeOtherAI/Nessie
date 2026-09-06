import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { withDelegatedSystemDmIdentity } from '@nessie/schemas'
import type { OrchestrateDecideJobPayload, RunExecuteJobPayload } from '@nessie/schemas'

// Prisma-level queue enqueue primitives shared by the API and the worker. The
// queue is a plain Postgres table (`queue_jobs`); inserting the job row inside
// the caller's transaction is what makes run creation + enqueue atomic.
// Both apps' queue modules re-export these so existing call sites keep their
// import paths.

export const enqueueQueueJob = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  input: {
    delayMs?: number
    idempotencyKey?: string
    maxAttempts?: number
    payload: unknown
    topic: string
  },
): Promise<boolean> => {
  const encodedPayload = JSON.stringify(input.payload)
  const maxAttempts = input.maxAttempts ?? 3
  const delayMs = input.delayMs ?? 0

  if (input.idempotencyKey) {
    const inserted = await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO queue_jobs (
          topic,
          payload,
          status,
          attempt,
          max_attempts,
          enqueued_at,
          idempotency_key
        )
        VALUES (
          ${input.topic},
          ${encodedPayload}::jsonb,
          'pending',
          0,
          ${maxAttempts},
          now() + (${delayMs} * interval '1 millisecond'),
          ${input.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `,
    )

    return Number(inserted) > 0
  }

  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO queue_jobs (
        topic,
        payload,
        status,
        attempt,
        max_attempts,
        enqueued_at
      )
      VALUES (
        ${input.topic},
        ${encodedPayload}::jsonb,
        'pending',
        0,
        ${maxAttempts},
        now() + (${delayMs} * interval '1 millisecond')
      )
    `,
  )

  return true
}

export const enqueueRunExecution = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunExecuteJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'run.execute',
  })
}

/**
 * Waking an agent from a live human turn — and the one place the delegated
 * identity a single-member system DM implies is stamped.
 *
 * Four routes reach this: a typed message, an agent-card press, an invited
 * agent's mention replay, and the worker's own `send_message` tool. The stamp
 * used to live at the first of them only, so the Agent Designer — whose whole
 * interaction style is card-driven — lost every identity-delegated tool
 * exactly where it is most used, and said so truthfully. Resolving the
 * destination here, from the channel id the payload already carries, is what
 * makes a fifth wake path correct without its author having to know this rule
 * exists.
 *
 * It lives beside `enqueueQueueJob` rather than in the api because the worker
 * reaches the same topic: a rule that exists in two forks is a rule the next
 * wake path gets wrong again.
 *
 * One indexed read per agent-waking message. It is deliberately not optional:
 * a caller-supplied `systemChannelType` would be exactly the thing a new path
 * forgets to pass.
 */
export const enqueueOrchestrateDecide = async (
  prisma: Pick<PrismaClient, '$executeRaw' | 'channel'>,
  payload: OrchestrateDecideJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  const destination = await prisma.channel.findUnique({
    select: { systemChannelType: true },
    where: { id: payload.channelId },
  })
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload: {
      ...payload,
      actorContext: withDelegatedSystemDmIdentity(payload.actorContext, {
        systemChannelType: destination?.systemChannelType ?? null,
      }),
    },
    topic: 'orchestrate.decide',
  })
}
