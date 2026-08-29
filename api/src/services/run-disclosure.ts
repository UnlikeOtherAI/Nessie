import type { PrismaClient } from '@prisma/client'
import { canUserReadDisclosureBasis } from '@nessie/runtime'

/**
 * May this viewer read material derived from a given run?
 *
 * One question with several askers, so it lives in one place. A run's reasoning
 * and its checkpoint are both derived from the very sources its reply was built
 * on, so they carry the same provenance and get the same answer.
 *
 * - The thought log: `GET /api/threads/:id/thinking` and `…/runs/:runId/thinking`
 *   gated on thread membership alone, so a member correctly withheld the reply
 *   could still read the run's full thinking about it — and unlike the live
 *   stream, that route persists.
 * - Continuing a run: pressing Continue claims the checkpoint. Someone who
 *   cannot reach the stopped run's sources consumes it, and the resumed run
 *   (which withholds the note from them anyway) then redoes the work — the
 *   entitled person's resume is spent by someone who could never use it.
 *
 * `RunBasisScope` is the per-run provenance ledger written by the agent-message
 * chokepoint. It existed with no reader; this is that reader. Zero rows means
 * unrestricted, which is the common case and costs one indexed lookup.
 *
 * Grants are resolved against the run's own assistant message when it has one,
 * so lifting the restriction on a reply (share once, or a standing rule) also
 * lifts it on the reasoning behind that reply — one decision, not two.
 */
export const canUserReadRunBasis = async (
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
