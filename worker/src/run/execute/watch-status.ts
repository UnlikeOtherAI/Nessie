import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * One rolling status message for a recurring watch.
 *
 * A sweep that finds nothing should not add a message. Posting "nothing
 * changed" every fifteen minutes buries the findings the channel exists for —
 * ninety-six messages a day, none of them news. Instead the watch keeps a
 * single status line and edits it in place: the model's own words, plus a
 * count of how many times it has run and when it last did.
 *
 * The roll resets the moment anything else is said. Any newer visible message
 * in the thread — a person, another agent, or this watch's own finding —
 * means the status line is no longer the last word, so the next quiet sweep
 * starts a fresh one at 1. That is a purely structural test (authorship and
 * recency), never a reading of what anybody wrote.
 *
 * Note what this deliberately is not: a way for a run to produce no output.
 * The model always writes its status text, exactly as before, and only the
 * *routing* of that text changes. Giving a model an "output is optional"
 * affordance is what broke every trigger run when `conclude_silently` shipped.
 */

export type WatchStatusMetadata = {
  lastRunAt: string
  lastRunId: string
  runCount: number
  triggerId: string
}

export const WATCH_STATUS_METADATA_KEY = 'watchStatus'

/** Recurring watches roll by default; an operator can switch it off per trigger. */
export const isRollingStatusEnabled = (config: unknown): boolean =>
  !(
    typeof config === 'object'
    && config !== null
    && (config as Record<string, unknown>)['rollingStatus'] === false
  )

type FoldInput = {
  agentId: string
  content: string
  lastRunId: string
  now: Date
  threadId: string
  triggerId: string
}

export type FoldResult = {
  created: boolean
  editedAt: Date
  messageId: string
  runCount: number
}

/**
 * Fold this sweep into the watch's rolling status message, or start a new one.
 *
 * The whole read-modify-write runs under a per-(thread, agent) advisory lock so
 * two sweeps can never both decide they are the first and create two status
 * rows, or both increment from the same count. The run-slot claim already
 * serialises one agent in one thread; this covers retry redelivery and the
 * same agent rolling in several threads.
 */
export const foldWatchStatus = async (
  prisma: PrismaClient,
  input: FoldInput,
): Promise<FoldResult> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${input.threadId}), hashtext(${input.agentId}))`,
    )

    const existing = await tx.message.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, id: true, metadata: true },
      where: {
        agentId: input.agentId,
        deletedAt: null,
        metadata: {
          path: [WATCH_STATUS_METADATA_KEY, 'triggerId'],
          equals: input.triggerId,
        },
        rootMessageId: null,
        threadId: input.threadId,
      },
    })

    // Anything said after the status line — by anyone, including this watch —
    // ends the roll. The status must be the last word to keep counting.
    const supersededBy = existing
      ? await tx.message.findFirst({
          select: { id: true },
          where: {
            createdAt: { gt: existing.createdAt },
            deletedAt: null,
            id: { not: existing.id },
            role: { not: 'system' },
            threadId: input.threadId,
          },
        })
      : null

    if (existing && !supersededBy) {
      const previous = readWatchStatus(existing.metadata)
      const runCount = (previous?.runCount ?? 1) + 1
      await tx.message.update({
        data: {
          content: input.content,
          editedAt: input.now,
          metadata: {
            [WATCH_STATUS_METADATA_KEY]: {
              lastRunAt: input.now.toISOString(),
              lastRunId: input.lastRunId,
              runCount,
              triggerId: input.triggerId,
            },
          } as Prisma.InputJsonValue,
        },
        where: { id: existing.id },
      })
      return { created: false, editedAt: input.now, messageId: existing.id, runCount }
    }

    const created = await tx.message.create({
      data: {
        agentId: input.agentId,
        content: input.content,
        metadata: {
          [WATCH_STATUS_METADATA_KEY]: {
            lastRunAt: input.now.toISOString(),
            lastRunId: input.lastRunId,
            runCount: 1,
            triggerId: input.triggerId,
          },
        } as Prisma.InputJsonValue,
        role: 'assistant',
        threadId: input.threadId,
      },
      select: { id: true },
    })
    return { created: true, editedAt: input.now, messageId: created.id, runCount: 1 }
  })

export const readWatchStatus = (metadata: unknown): WatchStatusMetadata | null => {
  if (typeof metadata !== 'object' || metadata === null) return null
  const raw = (metadata as Record<string, unknown>)[WATCH_STATUS_METADATA_KEY]
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value['triggerId'] !== 'string'
    || typeof value['runCount'] !== 'number'
    || typeof value['lastRunAt'] !== 'string'
  ) {
    return null
  }
  return {
    lastRunAt: value['lastRunAt'],
    lastRunId: typeof value['lastRunId'] === 'string' ? value['lastRunId'] : '',
    runCount: value['runCount'],
    triggerId: value['triggerId'],
  }
}

export type WatchDisposition = 'post' | 'status'

const CLASSIFIER_SYSTEM = [
  'You decide how a monitoring agent\'s sweep result should be delivered.',
  'Answer with JSON only: {"disposition":"post"} or {"disposition":"status"}.',
  '',
  '"post" — the sweep found something a person should see now: a new problem,',
  'a change since last time, something escalating, anything needing action.',
  '',
  '"status" — the sweep found nothing new. Same state as before, everything',
  'healthy, nothing to act on. This becomes a quiet rolling status line',
  'instead of a new message.',
  '',
  'Judge the meaning of the text, in whatever language it is written.',
].join('\n')

/**
 * Should this sweep's text be posted, or folded into the rolling status?
 *
 * A judgement about meaning, so the model makes it — deterministic code must
 * never decide "nothing changed" by looking for phrases. Fails **open**: any
 * error, timeout or unparseable answer posts normally, because a missed
 * finding is far worse than one redundant message.
 */
export const classifyWatchDisposition = async (
  runUtility: (
    messages: Array<{ content: string; role: 'system' | 'user' }>,
    tools: [],
  ) => Promise<{ outputText: string }>,
  responseText: string,
): Promise<WatchDisposition> => {
  try {
    const result = await runUtility(
      [
        { content: CLASSIFIER_SYSTEM, role: 'system' },
        { content: responseText.slice(0, 4000), role: 'user' },
      ],
      [],
    )
    const match = result.outputText.match(/\{[\s\S]*\}/)
    if (!match) return 'post'
    const parsed = JSON.parse(match[0]) as { disposition?: unknown }
    return parsed.disposition === 'status' ? 'status' : 'post'
  } catch {
    return 'post'
  }
}
