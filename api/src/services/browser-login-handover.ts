import type { PrismaClient } from '@prisma/client'
import { releaseSessionControl } from '@nessie/browser-cloud'

/**
 * Release the human claim which a login handover gave to a person, then write
 * the durable provenance the worker requires before it can adopt the live
 * session. Both the card and viewer doors use this one conditional operation;
 * retrying after another door already won is harmless.
 */
export const completeBrowserLoginHandover = async (
  prisma: Pick<PrismaClient, 'agentBrowser' | 'cloudBrowserSession' | 'agentBrowserLogin'>,
  input: {
    agentBrowserId: string
    organizationId: string
    requestedByUserId: string
    sessionId?: string
    threadId: string
    userId: string
  },
): Promise<{ released: boolean; sessionId: string | null }> => {
  const session = await prisma.cloudBrowserSession.findFirst({
    where: {
      ...(input.sessionId ? { id: input.sessionId } : {}),
      agentBrowserId: input.agentBrowserId,
      controlledByUserId: input.userId,
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      runId: null,
      status: { in: ['allocating', 'active', 'releasing'] },
      threadId: input.threadId,
    },
    select: { id: true },
  })
  if (!session) return { released: false, sessionId: null }
  const released = await releaseSessionControl(prisma, {
    sessionId: session.id,
    userId: input.userId,
  })
  if (!released) return { released: false, sessionId: session.id }
  await prisma.agentBrowser.updateMany({
    data: { handedBackAt: new Date(), handedBackByUserId: input.userId },
    where: { id: input.agentBrowserId, organizationId: input.organizationId },
  })
  return { released: true, sessionId: session.id }
}
