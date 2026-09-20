import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import {
  isLockedAbove,
  isAdminAuthoredScopedSettingKey,
  isLocalInferenceEnabledValue,
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
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
import { emitAuditEvent } from '../services/audit.js'
import { resolveOrganizationAdministrationAccess } from '../services/uoa-organization-administration.js'
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

  const authorizeAdminAuthoredKey = async (
    reply: FastifyReply,
    key: string,
    actorContext: NonNullable<ReturnType<typeof requireActorContext>>,
    organizationId: string,
    userId: string,
  ): Promise<boolean> => {
    if (!isAdminAuthoredScopedSettingKey(key)) return true
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { externalOrgId: true },
    })
    const localRole = await prisma.organizationMember.findFirst({
      where: { organizationId, userId, deactivatedAt: null },
      select: { role: true },
    })
    const access = await resolveOrganizationAdministrationAccess({
      actorContext,
      localRole: localRole?.role ?? null,
      organization: { externalOrgId: organization?.externalOrgId ?? null },
    })
    if (access.status === 'allowed') return true
    if (access.status === 'unavailable') {
      sendApiError(reply, 503, 'UOA_ORGANIZATION_ACCESS_UNAVAILABLE',
        'UnlikeOtherAI could not confirm organisation administrator access. Try again shortly.')
      return false
    }
    sendApiError(reply, 403, 'ORGANIZATION_ADMIN_REQUIRED',
      'Organisation administrator access is required for this setting.')
    return false
  }

  app.get('/api/settings/scoped', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = request.query as { keys?: string; scope?: string; teamId?: string; userId?: string }
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

    // An administrator may inspect the effective decision for one selected
    // person, but only for the registered administrator-authored local
    // inference key.  Keeping the exception here (instead of teaching the
    // generic resolver an arbitrary user selector) preserves self-only reads
    // for every other personal setting.
    const targetedLocalInferenceRead = query.userId !== undefined
    if (targetedLocalInferenceRead && (
      scope !== 'user'
      || keys.length !== 1
      || keys[0] !== LOCAL_INFERENCE_ENABLED_SETTING_KEY
    )) {
      sendApiError(reply, 400, 'VALIDATION_ERROR',
        'A selected person is only supported for the Local Ollama personal setting.')
      return reply
    }

    for (const key of keys) {
      if (!await authorizeAdminAuthoredKey(reply, key, actorContext, organizationId, userId)) {
        return reply
      }
    }

    let resolvedUserId = userId
    if (targetedLocalInferenceRead) {
      const targetUserId = z.string().uuid().safeParse(query.userId)
      if (!targetUserId.success) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'The selected member is invalid.')
        return reply
      }
      resolvedUserId = targetUserId.data
      const target = await prisma.organizationMember.findFirst({
        where: { organizationId, userId: resolvedUserId, deactivatedAt: null },
        select: { userId: true },
      })
      if (!target) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Member not found')
        return reply
      }
    }

    const personalTeamId = scope === 'user'
      ? targetedLocalInferenceRead
        ? query.teamId
          ? await prisma.team.findFirst({
            where: {
              id: query.teamId,
              members: { some: { userId: resolvedUserId } },
              project: { organizationId },
            },
            select: { id: true },
          }).then((team) => team?.id ?? null)
          : null
        : await memberTeamId(prisma, organizationId, userId, query.teamId)
      : query.teamId ?? null

    const resolved = await resolveScopedSettings(prisma, {
      organizationId,
      teamId: personalTeamId,
      userId: scope === 'user' ? resolvedUserId : null,
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
    if (isAdminAuthoredScopedSettingKey(key)) {
      if (!isLocalInferenceEnabledValue(body.value)) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'Local Ollama enablement must be a boolean.')
        return reply
      }
      if (body.scope === 'user' && !body.userId) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'Choose the person this administrative setting applies to.')
        return reply
      }
      if (!await authorizeAdminAuthoredKey(reply, key, actorContext, organizationId, userId)) {
        return reply
      }
      if (body.scope === 'team' && (!body.teamId || !await isTeamInOrganization(prisma, organizationId, body.teamId))) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
        return reply
      }
      const targetUserId = body.userId ?? userId
      const target = await prisma.organizationMember.findFirst({
        where: { organizationId, userId: targetUserId, deactivatedAt: null },
        select: { userId: true },
      })
      if (!target) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Member not found')
        return reply
      }
    }
    if (!isAdminAuthoredScopedSettingKey(key) && !(await authorizeScope(reply, {
      ...role, organizationId, scope: body.scope, teamId: body.teamId ?? undefined, userId,
    }))) {
      return reply
    }

    // A personal write sits under the caller's own team as well as the
    // organisation, and `writeScopedSetting` cannot know which team that is —
    // a person may be in several. Check it here, where the team is verified.
    if (body.scope === 'user') {
      const targetUserId = isAdminAuthoredScopedSettingKey(key) ? body.userId ?? userId : userId
      const teamId = isAdminAuthoredScopedSettingKey(key)
        ? body.teamId ?? null
        : await memberTeamId(prisma, organizationId, userId, body.teamId ?? undefined)
      const current = await resolveScopedSetting(prisma, { organizationId, teamId, userId: targetUserId }, key)
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
        userId: body.scope === 'user'
          ? (isAdminAuthoredScopedSettingKey(key) ? body.userId ?? null : userId)
          : null,
        value: (body.value ?? null) as never,
      })
      // A scoped setting is policy: which level it was written at, and whether
      // it was locked against the levels below, is the part a later audit needs.
      // The value itself rides along redacted by key like any other metadata.
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'setting.scoped.written',
        resourceType: 'scoped_setting',
        resourceId: key,
        outcome: 'success',
        metadata: {
          locked: body.locked ?? false,
          scope: body.scope,
          setAtScope: resolved.setAtScope,
          ...(body.scope === 'team' && body.teamId ? { teamId: body.teamId } : {}),
        },
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
