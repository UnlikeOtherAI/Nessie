/**
 * Shared route plumbing for automatic team access.
 *
 * The organisation and team surfaces are registered from separate files —
 * they answer to different gates and their route sets grew past one readable
 * file — but they share a feature gate, an error mapping and a rule-change
 * audit, and those must stay identical. This is that shared piece; it is a
 * seam, not a `-helpers` dump.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DOMAIN_REJECTION_MESSAGES, type AuthorizedActionContext } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { AutomaticMembershipDomainError } from '../services/automatic-membership/domains.js'
import type { RuleChange } from '../services/automatic-membership/rules.js'
import type { RouteDeps } from './types.js'

export const IdParamSchema = z.object({ id: z.string().uuid() })

export const sendDomainError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof AutomaticMembershipDomainError)) return false
  sendApiError(
    reply,
    error.statusCode,
    error.code,
    error.rejection ? DOMAIN_REJECTION_MESSAGES[error.rejection] : error.message,
    undefined,
    error.rejection ? { reason: error.rejection } : undefined,
  )
  return true
}

export const actorUserId = (actorContext: AuthorizedActionContext): string | null =>
  actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null

/**
 * The instance rollout gate, and the one that is fail-closed: with the flag off
 * every route 404s and the admin never renders the tab. The per-organisation
 * emergency stop is a separate, softer switch.
 */
export const guardFeature = (
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): AuthorizedActionContext | null => {
  if (deps.config.automaticMembership.enabled !== true) {
    sendApiError(
      reply,
      404,
      'AUTOMATIC_MEMBERSHIP_DISABLED',
      'Automatic team access is not enabled on this instance.',
    )
    return null
  }
  return deps.requireActorContext(request, reply)
}

export const auditRuleChange = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  domainId: string,
  change: RuleChange,
): Promise<void> => {
  if (change.added.length === 0 && change.removed.length === 0) return
  await emitAuditEvent(deps.prisma, {
    action: 'organization.automatic_membership.rule_changed',
    actorContext,
    metadata: {
      addedTeamIds: change.added.map((rule) => rule.teamId),
      removedTeamIds: change.removed.map((rule) => rule.teamId),
    },
    outcome: 'success',
    resourceId: domainId,
    resourceType: 'automatic_membership_domain',
  })
}
