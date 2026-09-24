import type { AuthorizedActionContext } from '@nessie/schemas'
import { agentTriggerScopeWhere, canMemberEditProjectBoards } from '@nessie/team-admin'
import { z } from 'zod'

import { mapTriggerRecord, TRIGGER_ADMIN_AUDIENCE } from '../services/trigger-shared.js'
import type { RouteDeps } from './types.js'

const TriggerIdSchema = z.string().uuid()

/** Who set a ticket trigger up (`config.authorUserId`, server-owned and never answered), and its board. */
const ticketTriggerAuthorOf = (
  trigger: { config: unknown; type: string },
): { boardId: string; userId: string } | null => {
  if (trigger.type !== 'ticket_changed' || !trigger.config || typeof trigger.config !== 'object') return null
  const { authorUserId, boardId } = trigger.config as { authorUserId?: unknown; boardId?: unknown }
  return typeof authorUserId === 'string' && typeof boardId === 'string' ? { boardId, userId: authorUserId } : null
}

/**
 * A trigger its own page may show this person
 * (docs/standards/ticket-work-machine-access.md → "Where it is set up"): an
 * owner, through the gates every Triggers read uses and with the owner
 * audience; or, for a ticket trigger, the person who set it up while they can
 * still edit its board — the one person who can set up its Machine access,
 * which lives on that page. Anyone else, an author who has since lost the
 * board, and any id that is not a trigger here, is not found.
 */
export const createTriggerReader = (deps: Pick<RouteDeps, 'isTriggerAccessibleToActor' | 'prisma'>) =>
  async (actorContext: AuthorizedActionContext, triggerId: string) => {
    if (!TriggerIdSchema.safeParse(triggerId).success) return null
    const scope = { organizationId: actorContext.tenant.organizationId, triggerId }
    const row = await deps.prisma.agentTrigger.findFirst({ where: agentTriggerScopeWhere(scope) })
    if (!row) return null
    if (actorContext.actor.roles?.includes('owner')) {
      const record = mapTriggerRecord(row, TRIGGER_ADMIN_AUDIENCE)
      return (await deps.isTriggerAccessibleToActor(actorContext, record)) ? { record, scope } : null
    }
    const author = ticketTriggerAuthorOf(row)
    if (actorContext.actor.actorType !== 'user' || author?.userId !== actorContext.actor.actorId) return null
    const board = await deps.prisma.board.findFirst({
      where: { id: author.boardId, organizationId: scope.organizationId }, select: { projectId: true },
    })
    if (!board?.projectId || !await canMemberEditProjectBoards(deps.prisma, {
      organizationId: scope.organizationId, projectId: board.projectId, userId: author.userId,
    })) return null
    return { record: mapTriggerRecord(row), scope }
  }
