import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'

/**
 * Org/project/team membership and roles are owned by the identity provider
 * outside `local` mode (UOA SSO gap analysis, phase 4): the local rows are a
 * projection of the verified session claims (`services/uoa-roles.ts`), and a
 * local write would be silently reverted at the next login or token rotation.
 * Refuse it instead of pretending it took.
 *
 * Returns `true` when the caller may manage membership locally. Placed after
 * the owner check and before any body parse or database read, matching the
 * phase-1 password/user-creation gates.
 *
 * `ChannelMember` is deliberately NOT covered — a channel is a Nessie product
 * concept, not a UOA roster.
 */
export const requireLocalMembershipManagement = (
  mode: string,
  reply: FastifyReply,
): boolean => {
  if (mode === 'local') {
    return true
  }
  sendApiError(
    reply,
    403,
    'LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED',
    'Membership and roles are managed in your identity provider.',
  )
  return false
}
