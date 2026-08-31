import type { PrismaClient } from '@prisma/client'
import {
  partitionByDisclosure,
  viewerSatisfiesBasis,
  type DisclosureViewer,
} from '@nessie/runtime'

import { resolveGrantedScopeKeys } from './disclosure-grants.js'

type DisclosureMessage = {
  agentId: string | null
  basisScopes: Array<{ scopeId: string; scopeType: string }>
  id: string
}

export type MessageReadAccess = {
  readable: boolean
  readableWithoutGrant: boolean
}

/**
 * The one disclosure decision for compact message projections. A caller who
 * reaches a message by a grant may read it, but may not pass it on as their
 * own source material.
 */
export const evaluateMessageReadAccess = async (
  prisma: PrismaClient,
  input: {
    channelId: string
    message: DisclosureMessage
    organizationId: string
    viewer: DisclosureViewer
  },
): Promise<MessageReadAccess> => {
  if (
    input.message.basisScopes.length === 0
    || partitionByDisclosure([input.message], input.viewer).withheld.length === 0
  ) {
    return { readable: true, readableWithoutGrant: true }
  }

  const grants = input.viewer.kind === 'user'
    ? await resolveGrantedScopeKeys(prisma, {
      agentId: input.message.agentId,
      basis: input.message.basisScopes,
      channelId: input.channelId,
      messageId: input.message.id,
      organizationId: input.organizationId,
      viewerChannelIds: input.viewer.scopes
        .filter((scope) => scope.scopeType === 'channel')
        .map((scope) => scope.scopeId),
      viewerUserId: input.viewer.userId,
    })
    : new Set<string>()

  return {
    readable: viewerSatisfiesBasis(input.message.basisScopes, input.viewer, grants),
    readableWithoutGrant: false,
  }
}
