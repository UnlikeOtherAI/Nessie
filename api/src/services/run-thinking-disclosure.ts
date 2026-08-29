import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis } from '@nessie/runtime'

/**
 * The disclosure gate for a run's thought log.
 *
 * A run's reasoning and tool-activity lines are derived from the very sources
 * its reply was built on, so they carry the same provenance and must answer the
 * same question: may *this* viewer read material derived from these scopes?
 * Without this the thought-process dialog was a second, durable route to
 * withheld content — `GET /api/threads/:id/thinking` and
 * `…/runs/:runId/thinking` gated on thread membership alone, so a member who is
 * correctly withheld the reply could still read the run's full thinking about
 * it, and unlike the live stream that route persists.
 *
 * `RunBasisScope` is the per-run provenance ledger written by the agent-message
 * chokepoint. It existed with no reader; this is that reader. Zero rows means
 * unrestricted, which is the common case and costs one indexed lookup.
 *
 * Grants are resolved against the run's own assistant message when it has one,
 * so lifting the restriction on a reply (share once, or a standing rule) also
 * lifts it on the reasoning behind that reply — one decision, not two.
 */
export const canReadRunThinking = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    runId: string
    userId: string
  },
): Promise<boolean> => {
  const basis = await prisma.runBasisScope.findMany({
    where: { runId: input.runId },
    select: { scopeType: true, scopeId: true },
  })
  // Unrestricted run: nothing was consumed that narrows who may read it.
  if (basis.length === 0) {
    return true
  }

  // A run has no reply column to join on — messages carry their own basis, so
  // nothing links a run to the message it produced. The run's own channel is
  // therefore what a standing (scope) grant is resolved against, and `null`
  // says there is no message: per-message grants cannot match, which is
  // correct, since sharing one reply does not publish the reasoning of every
  // run in the room.
  const run = await prisma.run.findUnique({
    where: { id: input.runId },
    select: { agentId: true, thread: { select: { channelId: true } } },
  })
  if (!run?.thread) {
    return false
  }

  return canUserReadDisclosureBasis(prisma, {
    agentId: run.agentId,
    basis,
    channelId: run.thread.channelId,
    messageId: null,
    organizationId: input.organizationId,
    userId: input.userId,
  })
}
