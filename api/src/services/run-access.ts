import type { PrismaClient, RunReplyPlacement } from '@prisma/client'
import type { RunStatus } from '@nessie/schemas'
import { buildAgentVisibilityWhere } from '@nessie/team-admin'

// Statuses a run can be in while it is still live — the set the status surface
// lists and the only set from which a run can be cancelled.
export const ACTIVE_RUN_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_input',
]

// A run is restartable only from a genuinely finished, non-successful terminal
// state. A `completed` run (including a budget-stop that delivered a partial
// answer) is not re-run; a budget-stop that produced nothing ends `failed`, so
// it is covered here.
export const RESTARTABLE_RUN_STATUSES: RunStatus[] = ['failed', 'cancelled']

// A run the caller is entitled to reach, with the trigger message's metadata
// hydrated so the handoff-guard can inspect it without a second query.
export type AccessibleRun = {
  id: string
  agentId: string
  // Present only for a PA shared-channel presence. Lifecycle actions must
  // preserve this owner rather than turn a restart into the clicker's PA run.
  principalUserId: string | null
  status: RunStatus
  channelId: string
  // The destination's system-DM kind. A restart or a continue re-enqueues a run
  // into this channel, so it owes the same delegated-identity stamp the wake
  // paths make — without it, continuing an Agent Designer run loses every
  // identity-delegated tool the original had.
  channelSystemChannelType: string | null
  threadId: string
  triggerMessageId: string | null
  triggerMessageMetadata: unknown
  // Pre-run reply-placement judgement, replayed onto restarted and continued
  // runs so the re-run lands where the original one was judged to belong.
  replyPlacement: RunReplyPlacement | null
}

/**
 * The one entitlement every run lifecycle action asks.
 *
 * Cancel, restart and continue are stronger acts than reading a run, so they
 * take at least the gate the run *list* takes: `buildAgentVisibilityWhere`
 * (`listActiveRuns`) plus the channel predicate every channel read composes
 * (public in this organisation, or a channel this person joined). Scoping by
 * organisation alone let any member who obtained a run's bare UUID stop, replay
 * or resume a private agent's work inside a channel they cannot open.
 */
export const loadRunForActor = async (
  prisma: PrismaClient,
  runId: string,
  actor: { organizationId: string; userId: string },
): Promise<AccessibleRun | null> => {
  const run = await prisma.run.findFirst({
    where: {
      id: runId,
      agent: buildAgentVisibilityWhere(actor),
      thread: {
        channel: {
          organizationId: actor.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: actor.userId } } },
          ],
        },
      },
    },
    select: {
      id: true,
      agentId: true,
      principalUserId: true,
      status: true,
      threadId: true,
      triggerMessageId: true,
      replyPlacement: true,
      thread: {
        select: {
          channelId: true,
          channel: { select: { systemChannelType: true } },
        },
      },
      triggerMessage: { select: { metadata: true } },
    },
  })
  if (!run) return null
  return {
    id: run.id,
    agentId: run.agentId,
    principalUserId: run.principalUserId,
    status: run.status,
    channelId: run.thread.channelId,
    channelSystemChannelType: run.thread.channel.systemChannelType,
    threadId: run.threadId,
    triggerMessageId: run.triggerMessageId,
    triggerMessageMetadata: run.triggerMessage?.metadata ?? null,
    replyPlacement: run.replyPlacement,
  }
}

// A run driven by an integration handoff (e.g. a DeepWater research launch)
// carries strict cross-service invariants that a generic cancel/restart/continue
// must never touch. Detection reads the launch message's server-authored
// `integrationLaunch` metadata; the caller is redirected to the product's own
// lifecycle path.
export const handoffProductSlug = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const launch = (metadata as Record<string, unknown>)['integrationLaunch']
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) return null
  const slug = (launch as Record<string, unknown>)['productSlug']
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}
