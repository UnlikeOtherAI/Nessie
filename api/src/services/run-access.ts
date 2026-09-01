import type { PrismaClient, RunReplyPlacement } from '@prisma/client'
import type { RunStatus } from '@nessie/schemas'

// Statuses a run can be in while it is still live — the set the status surface
// lists and the only set from which a run can be cancelled.
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['pending', 'running', 'waiting_approval']

// A run is restartable only from a genuinely finished, non-successful terminal
// state. A `completed` run (including a budget-stop that delivered a partial
// answer) is not re-run; a budget-stop that produced nothing ends `failed`, so
// it is covered here.
export const RESTARTABLE_RUN_STATUSES: RunStatus[] = ['failed', 'cancelled']

// A run scoped to the caller's organization, with the trigger message's metadata
// hydrated so the handoff-guard can inspect it without a second query.
export type OrgRun = {
  id: string
  agentId: string
  // Present only for a PA shared-channel presence. Lifecycle actions must
  // preserve this owner rather than turn a restart into the clicker's PA run.
  principalUserId: string | null
  status: RunStatus
  channelId: string
  threadId: string
  triggerMessageId: string | null
  triggerMessageMetadata: unknown
  // Pre-run reply-placement judgement, replayed onto restarted and continued
  // runs so the re-run lands where the original one was judged to belong.
  replyPlacement: RunReplyPlacement | null
}

export const loadRunForOrg = async (
  prisma: PrismaClient,
  runId: string,
  organizationId: string,
): Promise<OrgRun | null> => {
  const run = await prisma.run.findFirst({
    where: { id: runId, thread: { channel: { organizationId } } },
    select: {
      id: true,
      agentId: true,
      principalUserId: true,
      status: true,
      threadId: true,
      triggerMessageId: true,
      replyPlacement: true,
      thread: { select: { channelId: true } },
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
