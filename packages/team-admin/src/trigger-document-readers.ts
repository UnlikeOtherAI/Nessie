import type { PrismaClient } from '@prisma/client'
import {
  canReadSpace,
  createNativeKnowledgeProvider,
  loadSpaceViewer,
  type KnowledgeSpaceRecord,
} from '@nessie/knowledge'
import { resolveLiveEntitlements } from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'

/**
 * Who may read what a `document_changed` trigger names, asked before anything
 * about it is said (docs/standards/document-triggers.md → "A document
 * trigger's configuration is resolved on the server").
 *
 * A space, a folder or a page is **named** in a refusal only once both the
 * person setting the trigger up and the trigger's agent may read it. One
 * either of them cannot read is "no such …": a refusal travels to the
 * Designer's model and the Triggers editor unrecorded by any disclosure
 * basis, so it must never be the way a person or a model learns that a
 * document exists, let alone what it is called. Even then no refusal quotes a
 * title or a space name: it points at the field, which the person filled in.
 */

export type DocumentTriggerAuthor = { userId: string; uoaIdentity?: UoaSessionIdentity }

/** Why a space or page may not be named, or null when both may read it. */
export type DocumentReadRefusal = 'missing' | 'person' | 'agent' | 'agent_page'

export type SpaceRead =
  | { record: KnowledgeSpaceRecord; agentReads: boolean }
  | { refused: Extract<DocumentReadRefusal, 'missing' | 'person'> }

export type DocumentTriggerReaders = {
  /**
   * The space's record when the person may read it, and whether the agent may
   * too; the caller decides what to say when it may not, after anything that
   * names nothing (the channel's audience rule).
   */
  space: (spaceId: string) => Promise<SpaceRead>
  /**
   * A page is read through its space, and an agent never reads a page that is
   * restricted or private to another agent, whatever its space allows.
   */
  page: (page: { spaceId: string; sensitivityTier: string; privateToAgentId: string | null }) =>
    Promise<DocumentReadRefusal | null>
}

export const loadDocumentTriggerReaders = async (
  prisma: PrismaClient,
  input: { organizationId: string; agentId: string; author: DocumentTriggerAuthor },
): Promise<DocumentTriggerReaders> => {
  const liveEntitlements = await resolveLiveEntitlements(prisma, {
    organizationId: input.organizationId,
    userId: input.author.userId,
    ...(input.author.uoaIdentity ? { uoaIdentity: input.author.uoaIdentity } : {}),
  })
  const [authorViewer, agentViewer] = await Promise.all([
    loadSpaceViewer(prisma, input.organizationId, { actorType: 'user', actorId: input.author.userId }, {
      liveEntitlements,
    }),
    loadSpaceViewer(prisma, input.organizationId, { actorType: 'agent', actorId: input.agentId }),
  ])
  const provider = createNativeKnowledgeProvider(prisma)
  const decided = new Map<string, Promise<SpaceRead>>()
  const space = (spaceId: string): Promise<SpaceRead> => {
    let result = decided.get(spaceId)
    if (!result) {
      result = (async (): Promise<SpaceRead> => {
        const record = await provider.getSpace(input.organizationId, spaceId)
        if (!record) return { refused: 'missing' }
        // The person first: what they may not read, they are not told of.
        if (!canReadSpace(record, authorViewer)) return { refused: 'person' }
        return { record, agentReads: canReadSpace(record, agentViewer) }
      })()
      decided.set(spaceId, result)
    }
    return result
  }
  return {
    space,
    page: async (page) => {
      const access = await space(page.spaceId)
      if ('refused' in access) return access.refused
      if (!access.agentReads) return 'agent'
      if (page.sensitivityTier === 'restricted') return 'agent_page'
      if (page.privateToAgentId && page.privateToAgentId !== input.agentId) return 'agent_page'
      return null
    },
  }
}
