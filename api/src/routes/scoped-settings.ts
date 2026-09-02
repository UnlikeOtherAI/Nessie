import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  isLockedAbove,
  lockExplanation,
  resolveScopedSetting,
  resolveScopedSettings,
  SCOPED_SETTING_ERROR_CODES,
  ScopedSettingError,
  writeScopedSetting,
  type SettingScope,
} from '@nessie/runtime'

import {
  ResolvedSettingListSchema,
  WriteScopedSettingBodySchema,
} from '../contracts/scoped-settings.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * Settings resolved across organisation → team → person.
 *
 * A caller asks for the level it is editing and gets back both the value in
 * force there and, when an ancestor has locked the key, which ancestor did —
 * so the surface can grey the control and say why instead of offering an edit
 * the write below would refuse.
 */

const isTeamInOrganization = async (
  prisma: RouteDeps['prisma'],
  organizationId: string,
  teamId: string,
): Promise<boolean> => {
  // Teams carry no organization_id of their own; tenancy runs through their
  // project, so this is where the FK cannot help and the check must be made.
  const team = await prisma.team.findFirst({
    where: { id: teamId, project: { organizationId } },
    select: { id: true },
  })
  return team !== null
}

/**
 * The team level of a personal cascade, verified.
 *
 * A person's own setting still sits under whatever their team locked, so the
 * team must be part of resolving it. The id is never taken on the caller's
 * word: an unverified one would let any member ask whether an arbitrary team
 * has locked a key. Only a team the caller actually belongs to is used, and
 * anything else is dropped rather than refused — the personal answer is still
 * a real answer without it.
 */
const memberTeamId = async (
  prisma: RouteDeps['prisma'],
  organizationId: string,
  userId: string,
  teamId: string | undefined,
): Promise<string | null> => {
  if (!teamId) return null
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      members: { some: { userId } },
      project: { organizationId },
    },
    select: { id: true },
  })
  return team?.id ?? null
}

export const registerScopedSettingsRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  /**
   * Who may write which level, mirroring the routes a person's buttons already
   * call: the organisation and its teams are owner-or-admin (matching the
   * organisation PATCH and the team settings route), and a personal setting is
   * the person's own.
   */
  const authorizeScope = async (
    reply: FastifyReply,
    input: {
      organizationId: string
      userId: string
      isOwnerOrAdmin: boolean
      scope: SettingScope
      teamId?: string | undefined
    },
  ): Promise<boolean> => {
    if (input.scope === 'user') return true
    if (!input.isOwnerOrAdmin) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Only owners and admins can change this setting.')
      return false
    }
    if (input.scope === 'team') {
      if (!input.teamId) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'A team setting needs a team.')
        return false
      }
      if (!(await isTeamInOrganization(prisma, input.organizationId, input.teamId))) {
        // Indistinguishable from a team that does not exist.
        sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
        return false
      }
    }
    return true
  }

  const resolveRole = async (
    organizationId: string,
    userId: string,
  ): Promise<{ isOwnerOrAdmin: boolean } | null> => {
    // Re-read live, never the run's enqueue-time snapshot: a deactivated
    // membership must not keep writing settings.
    const membership = await prisma.organizationMember.findFirst({
      where: { organizationId, userId, deactivatedAt: null },
      select: { role: true },
    })
    if (!membership) return null
    return { isOwnerOrAdmin: membership.role === 'owner' || membership.role === 'admin' }
  }

  app.get('/api/settings/scoped', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = request.query as { keys?: string; scope?: string; teamId?: string }
    const keys = (query.keys ?? '').split(',').map((key) => key.trim()).filter(Boolean)
    const scope = (query.scope ?? 'user') as SettingScope
    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId

    const role = await resolveRole(organizationId, userId)
    if (!role) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Your access to this organisation is not active.')
      return reply
    }
    if (!(await authorizeScope(reply, { ...role, organizationId, scope, teamId: query.teamId, userId }))) {
      return reply
    }

    const resolved = await resolveScopedSettings(prisma, {
      organizationId,
      teamId: scope === 'user'
        ? await memberTeamId(prisma, organizationId, userId, query.teamId)
        : query.teamId ?? null,
      userId: scope === 'user' ? userId : null,
    }, keys)

    return createApiResponse(
      ResolvedSettingListSchema.parse({
        settings: keys.map((key) => {
          const setting = resolved.get(key) ?? {
            key, lockedAtScope: null, setAtScope: null, value: null,
          }
          return {
            ...setting,
            canEdit: !isLockedAbove(setting, scope),
            lockedHere: setting.lockedAtScope === scope,
          }
        }),
      }),
    )
  })

  app.put('/api/settings/scoped/:key', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { key } = request.params as { key: string }
    const body = parseInput(WriteScopedSettingBodySchema, request.body, reply)
    if (!body) return reply

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const role = await resolveRole(organizationId, userId)
    if (!role) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Your access to this organisation is not active.')
      return reply
    }
    if (!(await authorizeScope(reply, {
      ...role, organizationId, scope: body.scope, teamId: body.teamId, userId,
    }))) {
      return reply
    }

    // A personal write sits under the caller's own team as well as the
    // organisation, and `writeScopedSetting` cannot know which team that is —
    // a person may be in several. Check it here, where the team is verified.
    if (body.scope === 'user') {
      const teamId = await memberTeamId(prisma, organizationId, userId, body.teamId)
      const current = await resolveScopedSetting(prisma, { organizationId, teamId, userId }, key)
      if (isLockedAbove(current, 'user')) {
        sendApiError(reply, 409, SCOPED_SETTING_ERROR_CODES.LOCKED_ABOVE, lockExplanation(
          current.lockedAtScope as 'organization' | 'team',
        ))
        return reply
      }
    }

    try {
      const resolved = await writeScopedSetting(prisma, {
        key,
        locked: body.locked,
        organizationId,
        scope: body.scope,
        teamId: body.teamId ?? null,
        updatedByUserId: userId,
        userId: body.scope === 'user' ? userId : null,
        value: (body.value ?? null) as never,
      })
      return createApiResponse(
        ResolvedSettingListSchema.parse({
          settings: [{
            ...resolved,
            canEdit: !isLockedAbove(resolved, body.scope),
            lockedHere: resolved.lockedAtScope === body.scope,
          }],
        }),
      )
    } catch (error) {
      if (error instanceof ScopedSettingError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })
}
