import type { PrismaClient } from '@prisma/client'
import type { MailboxEndpoints } from '@nessie/agent-mail'

import {
  mailboxEndpointsFor,
  type MailboxConnectionRow,
} from './mailbox-connection-endpoints.js'
import { recordMailboxConnectionCredentialRejection } from './mailbox-connection-recovery.js'

/**
 * Which connected mailbox a run may touch, and as whom.
 *
 * Two gates, both of which must pass, and neither of which the other can stand
 * in for:
 *
 *  - **An access row.** `Agent.toolPolicy` is keyed by tool id, so the
 *    tool-level grant says only "this agent may use connected mailboxes at
 *    all". Which ones is a per-pair decision somebody made explicitly, or
 *    connecting a second team mailbox would silently widen every agent already
 *    holding the tool.
 *  - **The effective user, for a personal mailbox.** A user-scope connection is
 *    one person's own correspondence; it resolves only when the run is acting
 *    as that person — an interactive requester, or a schedule carrying its
 *    captured launch-origin user. This is the same discipline the Google lane
 *    applies to a personal Gmail account, and it is why a shared agent cannot
 *    read your mailbox by being mentioned in a public channel.
 *
 * A team-scope connection needs no such test: it is shared by construction, and
 * the access row is the whole decision.
 */

export type MailboxAccessErrorCode =
  | 'NO_MAILBOX'
  | 'AMBIGUOUS_MAILBOX'
  | 'MAILBOX_NOT_FOUND'
  | 'NEEDS_REAUTHORIZATION'

export class MailboxAccessError extends Error {
  constructor(
    readonly code: MailboxAccessErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MailboxAccessError'
  }
}

export type ReachableMailbox = {
  connection: MailboxConnectionRow
  scope: 'user' | 'team'
  /** The disclosure scope a read of this mailbox puts on the run. */
  basis: { scopeType: 'user' | 'team'; scopeId: string }
}

/**
 * Every connection this run could legitimately use. Listed rather than resolved
 * so the caller can name the ambiguity instead of guessing a mailbox — sending
 * from the wrong address is not recoverable.
 */
export const listReachableMailboxes = async (
  prisma: PrismaClient,
  input: { organizationId: string; agentId: string; effectiveUserId: string | null },
): Promise<ReachableMailbox[]> => {
  const rows = await prisma.mailboxConnection.findMany({
    orderBy: { createdAt: 'asc' },
    where: {
      agentAccess: { some: { agentId: input.agentId } },
      organizationId: input.organizationId,
      // A disabled or reauthorization-pending mailbox is deliberately absent
      // rather than present-and-failing: the tool says there is no mailbox, and
      // the connector card is where the remedy lives.
      status: 'active',
    },
  })

  const reachable: ReachableMailbox[] = []
  for (const connection of rows) {
    if (connection.ownerUserId) {
      if (!input.effectiveUserId || connection.ownerUserId !== input.effectiveUserId) continue
      reachable.push({
        basis: { scopeId: connection.ownerUserId, scopeType: 'user' },
        connection,
        scope: 'user',
      })
      continue
    }
    if (!connection.teamId) continue
    reachable.push({
      basis: { scopeId: connection.teamId, scopeType: 'team' },
      connection,
      scope: 'team',
    })
  }
  return reachable
}

/**
 * The one mailbox a tool call acts on.
 *
 * With several reachable it refuses rather than picking: which mailbox an agent
 * read, and which address it would send from, are not things to guess at. The
 * refusal names the connections so the model can pass an id and carry on.
 */
export const resolveMailboxForToolCall = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    agentId: string
    effectiveUserId: string | null
    connectionId?: string | null
  },
): Promise<ReachableMailbox> => {
  const reachable = await listReachableMailboxes(prisma, input)
  if (reachable.length === 0) {
    throw new MailboxAccessError(
      'NO_MAILBOX',
      'I have not been given access to any connected mailbox. An owner or admin '
      + 'grants that from Connected accounts in Settings.',
    )
  }
  if (input.connectionId) {
    const named = reachable.find((entry) => entry.connection.id === input.connectionId)
    if (!named) {
      throw new MailboxAccessError(
        'MAILBOX_NOT_FOUND',
        'That mailbox is not one I can use.',
      )
    }
    return named
  }
  if (reachable.length > 1) {
    const options = reachable
      .map((entry) => `${entry.connection.label} (${entry.connection.id})`)
      .join('; ')
    throw new MailboxAccessError(
      'AMBIGUOUS_MAILBOX',
      `I can reach more than one mailbox, so tell me which to use by passing `
      + `connectionId: ${options}.`,
    )
  }
  const only = reachable[0]
  if (!only) throw new MailboxAccessError('NO_MAILBOX', 'No mailbox is available.')
  return only
}

export const openMailboxEndpoints = async (
  prisma: PrismaClient,
  mailbox: ReachableMailbox,
  encryptionSecret: string,
): Promise<MailboxEndpoints> =>
  mailboxEndpointsFor(prisma, mailbox.connection, encryptionSecret)

/**
 * Record a provider rejection on the connection.
 *
 * Named here rather than left to each caller because the transition is the
 * thing that owns how a person finds out: a mailbox that stopped working shows
 * `needs_reauthorization` with the remedy on its card, instead of failing every
 * run forever while nobody is told.
 */
export const markMailboxNeedsReauthorization = async (
  prisma: PrismaClient,
  connectionId: string,
): Promise<void> => {
  await recordMailboxConnectionCredentialRejection(prisma, connectionId)
}
