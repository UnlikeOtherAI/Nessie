import type { PrismaClient } from '@prisma/client'
import type { LandingTeam } from '@nessie/schemas'

import { isAuthSessionRevoked } from './auth-session-registry.js'
import { loadUoaTeamDirectory, loadUserMemberships } from './auth.js'
import { hashRefreshToken } from './refresh-token-crypto.js'
import { refreshTokenSelect, type RefreshTokenRecord } from './refresh-token-family.js'
import { identityFromCredential, loadBoundUoaCredential } from './refresh-token-uoa.js'
import type { UoaDirectoryRefreshDeps } from './uoa-directory-refresh.js'
import { resolveUoaLocalSessionContext } from './uoa-session-context.js'

/** Where a team is entered once the app has it; the same path every switch lands on. */
const TEAM_LANDING_PATH = '/channels'

export type LandingTeamsDeps = {
  /** The app's canonical origin (`NESSIE_ADMIN_PUBLIC_URL`); null means no fallback link. */
  adminOrigin: string | null
  /** `NESSIE_TEAM_HOST_BASE_DOMAIN`; unset means no team has its own address. */
  teamHostBaseDomain: string | undefined
  /** UOA's address labels for a team id, or null when it has none or UOA is unreachable. */
  resolveTeamAddress: (
    externalTeamId: string,
  ) => Promise<{ teamSlug: string; orgSlug: string } | null>
  uoaDirectoryRefreshDeps?: UoaDirectoryRefreshDeps
  now?: Date
}

const appHref = (adminOrigin: string | null): string | null => {
  if (!adminOrigin) return null
  try {
    return new URL(TEAM_LANDING_PATH, adminOrigin).href
  } catch {
    return null
  }
}

/**
 * The live refresh session a cookie names, read without consuming it.
 *
 * Reading must never rotate: the refresh cookie is shared with the app, and a
 * rotation here would race the app's own page-load refresh on the same family
 * — the failure `TenantHostGate` already had to avoid (`TEAM_SWITCH_CONFLICT`).
 * A rotated predecessor is revoked, so a replayed old cookie reads as signed
 * out rather than tripping reuse detection.
 */
const readLiveRefreshSession = async (
  prisma: PrismaClient,
  rawToken: string,
  now: Date,
): Promise<RefreshTokenRecord | null> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: refreshTokenSelect,
  }) as RefreshTokenRecord | null
  if (!record || record.revokedAt || record.expiresAt <= now) return null
  if (await isAuthSessionRevoked(prisma, record.sessionId)) return null
  return record
}

const uoaLandingTeams = async (
  prisma: PrismaClient,
  record: RefreshTokenRecord,
  deps: LandingTeamsDeps,
): Promise<LandingTeam[]> => {
  let identity: ReturnType<typeof identityFromCredential>
  let organizationId: string
  try {
    identity = identityFromCredential(await loadBoundUoaCredential(prisma, record))
    organizationId = (await resolveUoaLocalSessionContext(prisma, {
      identity,
      userId: record.userId,
    })).organizationId
  } catch {
    // A session the refresh route would refuse is a signed-out visitor here.
    return []
  }

  const { uoaTeams } = await loadUoaTeamDirectory(
    prisma,
    record.userId,
    { identity, organizationId, providerType: record.providerType },
    deps.uoaDirectoryRefreshDeps ?? {},
  )
  const fallbackHref = appHref(deps.adminOrigin)
  const ordered = [...(uoaTeams ?? [])].sort(
    (left, right) => Number(right.active) - Number(left.active),
  )

  const teams = await Promise.all(ordered.map(async (team): Promise<LandingTeam | null> => {
    // The address has to come from `resolveTeamAddress`, not from the labels in
    // the directory, even though UOA sends those so a product "can build the
    // address without a second lookup".
    //
    // UOA sends them for every organisation this person belongs to. This
    // deployment can only SERVE the ones on its own UOA client domain: the
    // resolver behind the hostname, the TLS gate that mints its certificate
    // and this lookup are all `/domain/*` reads scoped to `UOA_DOMAIN`. For an
    // organisation founded on another product's domain the labels are real and
    // the hostname is not — `<team>.<org>.<base>` fails the TLS handshake,
    // because the gate refuses to have a certificate issued for it. A link
    // built from the labels alone is therefore a dead link, which is worse
    // than the app-wide one it replaced.
    //
    // So the lookup is the test as well as the answer: a team this deployment
    // cannot address falls back to the app, exactly as it did before.
    const address = deps.teamHostBaseDomain
      ? await deps.resolveTeamAddress(team.teamId)
      : null
    const href = address
      ? `https://${address.teamSlug}.${address.orgSlug}.${deps.teamHostBaseDomain}${TEAM_LANDING_PATH}`
      : fallbackHref
    if (!href) return null
    return {
      label: team.label,
      ...(team.orgName ? { orgName: team.orgName } : {}),
      ...(team.avatarImageUrl ? { avatarImageUrl: team.avatarImageUrl } : {}),
      active: team.active,
      href,
    }
  }))
  return teams.filter((team): team is LandingTeam => team !== null)
}

/**
 * A no-IdP install's teams are Nessie's own rows, so they come from the
 * membership tree `/api/auth/me` reads. The active team is the one a refresh
 * of this session lands on — the first team membership, as `buildLocalSession`
 * picks it. Local teams have no address and no public avatar.
 */
const localLandingTeams = async (
  prisma: PrismaClient,
  record: RefreshTokenRecord,
  deps: LandingTeamsDeps,
): Promise<LandingTeam[]> => {
  const href = appHref(deps.adminOrigin)
  if (!href) return []
  const [memberships, firstMembership] = await Promise.all([
    loadUserMemberships(prisma, record.userId),
    prisma.teamMember.findFirst({
      where: { userId: record.userId },
      orderBy: { createdAt: 'asc' },
      select: { teamId: true },
    }),
  ])

  const seen = new Set<string>()
  const teams: LandingTeam[] = []
  for (const organisation of memberships) {
    for (const project of organisation.projects) {
      for (const team of project.teams) {
        if (seen.has(team.teamId)) continue
        seen.add(team.teamId)
        const label = team.teamName ?? project.projectName
        if (!label) continue
        teams.push({
          label,
          ...(organisation.organizationName ? { orgName: organisation.organizationName } : {}),
          active: team.teamId === firstMembership?.teamId,
          href,
        })
      }
    }
  }
  return teams.sort((left, right) => Number(right.active) - Number(left.active))
}

/**
 * Every team the holder of this refresh cookie belongs to, shaped for the
 * public landing. An absent, expired, revoked or unbindable session is an
 * empty list, never an error, so the landing simply draws nothing.
 */
export const readLandingTeams = async (
  prisma: PrismaClient,
  rawToken: string,
  deps: LandingTeamsDeps,
): Promise<LandingTeam[]> => {
  const record = await readLiveRefreshSession(prisma, rawToken, deps.now ?? new Date())
  if (!record) return []
  return record.providerType === 'uoa'
    ? uoaLandingTeams(prisma, record, deps)
    : localLandingTeams(prisma, record, deps)
}
