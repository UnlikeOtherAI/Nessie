import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { LandingTeamsResponseSchema } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readRefreshCookie } from '../lib/refresh-cookie.js'
import { readLandingTeams, type LandingTeamsDeps } from '../services/landing-teams.js'
import {
  resolveUoaTeamAddress,
  UoaRosterUnavailableError,
} from '../services/uoa-org-roster.js'

export const LANDING_TEAMS_PATH = '/api/auth/landing-teams'

export type LandingTeamsRouteDeps = {
  prisma: PrismaClient
  /** `NESSIE_LANDING_ORIGIN`: the one origin this route answers. */
  landingOrigin: string | undefined
  teamHostBaseDomain: string | undefined
  adminOrigin: string | null
  /** Test seam; production resolves through UOA exactly as `/api/hosts/address` does. */
  resolveTeamAddress?: LandingTeamsDeps['resolveTeamAddress']
  uoaDirectoryRefreshDeps?: LandingTeamsDeps['uoaDirectoryRefreshDeps']
}

const resolveTeamAddressOrNull: LandingTeamsDeps['resolveTeamAddress'] = async (teamId) => {
  try {
    return await resolveUoaTeamAddress({ teamId })
  } catch (error) {
    if (error instanceof UoaRosterUnavailableError) return null
    throw error
  }
}

/**
 * The public landing's "Your teams" read (docs/standards/team-hosts.md,
 * "The landing lists the teams you are signed into").
 *
 * It lives under `/api/auth` because that is the refresh cookie's path, and it
 * answers with its own CORS headers for exactly one origin. The landing is
 * deliberately not in the API-wide allowlist: admitting it there would let
 * that page call every credentialed route, when it needs this one answer.
 * `@fastify/cors` sets nothing for an origin it refuses, so the headers here
 * are the only ones such a response carries.
 *
 * Signed out is `200 { teams: [] }`, not a 401, so the landing's console stays
 * quiet for the anonymous visitors who are almost all of its traffic.
 */
export const registerAuthLandingTeamsRoute = (
  app: FastifyInstance,
  deps: LandingTeamsRouteDeps,
): void => {
  app.get(LANDING_TEAMS_PATH, { config: { public: true } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('Vary', 'Origin, Cookie')

    if (!deps.landingOrigin || request.headers.origin !== deps.landingOrigin) {
      sendApiError(reply, 403, 'ORIGIN_NOT_ALLOWED', 'This read is only for the public landing page.')
      return reply
    }
    reply.header('Access-Control-Allow-Origin', deps.landingOrigin)
    reply.header('Access-Control-Allow-Credentials', 'true')

    const rawToken = readRefreshCookie(request)
    const teams = rawToken
      ? await readLandingTeams(deps.prisma, rawToken, {
          adminOrigin: deps.adminOrigin,
          teamHostBaseDomain: deps.teamHostBaseDomain,
          resolveTeamAddress: deps.resolveTeamAddress ?? resolveTeamAddressOrNull,
          ...(deps.uoaDirectoryRefreshDeps
            ? { uoaDirectoryRefreshDeps: deps.uoaDirectoryRefreshDeps }
            : {}),
        })
      : []
    return createApiResponse(LandingTeamsResponseSchema.parse({ teams }))
  })
}
