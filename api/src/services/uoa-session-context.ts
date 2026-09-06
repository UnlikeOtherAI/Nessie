import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import { rememberUoaTeamDirectory } from './uoa-directory-cache.js'
import type { ExternalAuthTeam } from './identity-display.js'
import {
  buildUoaAssertedTeams,
  projectUoaRoles,
  reconcileUoaMembershipProjection,
  resolveUoaRoleClaims,
} from './uoa-roles.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import type { UoaTeamDirectory } from './uoa-team-directory.js'
import { syncTeamInviteAlerts } from './team-invite-alerts.js'

type UoaSessionContextPrisma = Pick<PrismaClient, 'productAccountLink' | 'team'>

export type UoaLocalSessionContext = {
  organizationId: string
  projectId: string
  role: string
  teamId: string
}

export class UoaLocalSessionBindingError extends Error {
  readonly definitive = true

  constructor(message: string) {
    super(message)
    this.name = 'UoaLocalSessionBindingError'
  }
}

const requireValidTokenVersion = (
  tokenVersion: number | null | undefined,
  message: string,
): number => {
  if (
    tokenVersion === null
    || tokenVersion === undefined
    || !Number.isSafeInteger(tokenVersion)
    || tokenVersion < 0
  ) {
    throw new UoaLocalSessionBindingError(message)
  }
  return tokenVersion
}

const requireTokenVersion = (identity: UoaSessionIdentity): number =>
  requireValidTokenVersion(
    identity.tokenVersion,
    'The UnlikeOtherAI session is missing its revocation epoch.',
  )

const FIRST_PARTY_UOA_AUTH_MODES = [
  'uoa_sso',
  'oauth_mcp',
  'local_mcp',
] as const

const loadBinding = async (
  prisma: UoaSessionContextPrisma,
  input: {
    identity: UoaSessionIdentity
    tokenVersions: number[]
    userId: string
  },
): Promise<UoaLocalSessionContext & { linkId: string }> => {
  const team = await prisma.team.findFirst({
    where: {
      externalOrgId: input.identity.organizationId,
      externalTeamId: input.identity.teamId,
      members: { some: { userId: input.userId } },
      project: {
        members: { some: { userId: input.userId } },
        organization: {
          // Organizations map 1:1 to UOA organisations: the team must live in
          // the Organization carrying this session's external org id. A team
          // reachable only through a foreign org — or a legacy team left in a
          // null-externalOrgId org — fails closed here rather than scoping the
          // session to an organization the UOA proof does not name.
          externalOrgId: input.identity.organizationId,
          members: {
            some: { deactivatedAt: null, userId: input.userId },
          },
        },
      },
    },
    select: {
      id: true,
      projectId: true,
      project: {
        select: {
          organizationId: true,
          organization: {
            select: {
              members: {
                where: { deactivatedAt: null, userId: input.userId },
                select: { role: true },
                take: 1,
              },
            },
          },
        },
      },
    },
  })
  const role = team?.project.organization.members[0]?.role
  if (!team || !role) {
    throw new UoaLocalSessionBindingError(
      'The UnlikeOtherAI team is no longer available in Nessie.',
    )
  }

  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: team.project.organizationId,
        productSlug: 'nessie',
        userId: input.userId,
      },
    },
    select: {
      id: true,
      status: true,
      uoaSub: true,
      uoaTokenVersion: true,
    },
  })
  if (
    link?.status !== 'linked'
    || link.uoaSub !== input.identity.subject
    || link.uoaTokenVersion === null
    || !input.tokenVersions.includes(link.uoaTokenVersion)
  ) {
    throw new UoaLocalSessionBindingError(
      'The Nessie account link no longer matches this UnlikeOtherAI session.',
    )
  }

  return {
    linkId: link.id,
    organizationId: team.project.organizationId,
    projectId: team.projectId,
    role,
    teamId: team.id,
  }
}

/** Resolve the exact live local team for an immutable UOA session proof. */
export const resolveUoaLocalSessionContext = async (
  prisma: UoaSessionContextPrisma,
  input: { identity: UoaSessionIdentity; userId: string },
): Promise<UoaLocalSessionContext> => {
  const tokenVersion = requireTokenVersion(input.identity)
  const binding = await loadBinding(prisma, {
    ...input,
    tokenVersions: [tokenVersion],
  })
  return {
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    role: binding.role,
    teamId: binding.teamId,
  }
}

/**
 * Advance Nessie's stable account-link epoch onto the team UOA has just
 * proven for this session — the same immutable subject, an epoch that has not
 * regressed, and whatever org/team the successor carries.
 *
 * **Identity is the subject and the epoch; the team is not an identity
 * claim.** Those two checks are what prove the successor belongs to the same
 * person, and they stay strictly enforced. The team is deliberately
 * allowed to differ: UOA can commit a team change on its own side, and
 * with the silent switch in the product a drifted team is the ordinary
 * way a committed switch surfaces on the next refresh. Refusing it made a
 * *successful* switch look like a logout, and Nessie was the last product in
 * the estate still doing so. Substitution is not what a drift means, and would
 * still be caught: adopting re-derives the local binding from the successor's
 * own team through the exact `Team.externalOrgId`/`externalTeamId`
 * mapping below, which fails closed when the team does not resolve to a
 * local org/project/team this user is a member of.
 *
 * ProductAccountLink.activeOrgId / activeTeamId are only last-seen UI metadata
 * and cannot invalidate another live family for the same user in another team.
 */
export const advanceUoaLocalSessionBindingInTransaction = async (
  transaction: Prisma.TransactionClient,
  input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
    team?: ExternalAuthTeam
    teamDirectory?: UoaTeamDirectory
  },
): Promise<UoaLocalSessionContext> => {
  const previousVersion = requireTokenVersion(input.previousIdentity)
  const nextVersion = requireTokenVersion(input.nextIdentity)
  if (
    input.nextIdentity.subject !== input.previousIdentity.subject
    || nextVersion < previousVersion
  ) {
    throw new UoaLocalSessionBindingError(
      'UnlikeOtherAI returned a different session binding.',
    )
  }

  const { linkId, ...binding } = await loadBinding(
    transaction as unknown as UoaSessionContextPrisma,
    {
      identity: input.nextIdentity,
      tokenVersions: previousVersion === nextVersion
        ? [previousVersion]
        : [previousVersion, nextVersion],
      userId: input.userId,
    },
  )
  // The refreshed access token carries the same verified `org_role` /
  // `team_roles` claims the login exchange did, so a renewal re-projects them
  // onto the local membership: a UOA demotion lands within one token rotation
  // instead of waiting for the next interactive sign-in. Claims UOA did not
  // send project nothing (`uoa-roles.ts`).
  const projected = await projectUoaRoles(transaction, {
    claims: resolveUoaRoleClaims(input.team, input.nextIdentity.teamId),
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    teamId: binding.teamId,
    userId: input.userId,
  })
  // The other half of the same projection: roles UOA still claims are
  // re-applied above, memberships UOA no longer claims are withdrawn here. The
  // rotation directory is the only place a verified, *complete* statement of
  // this person's teams arrives, so this is where the local rows stop being
  // append-only (2026-09-05 API review, FO2-1). A rotation whose directory read
  // failed carries no statement and reconciles nothing.
  if (input.teamDirectory) {
    const reconciled = await reconcileUoaMembershipProjection(transaction, {
      asserted: buildUoaAssertedTeams({
        activeExternalOrgId: input.nextIdentity.organizationId,
        claimedTeamIds: input.team?.teamIds,
        entries: input.teamDirectory.entries,
      }),
      userId: input.userId,
    })
    if (reconciled.revokedTeamIds.includes(binding.teamId)) {
      throw new UoaLocalSessionBindingError(
        'UnlikeOtherAI no longer places this account in the team this session is bound to.',
      )
    }
  }

  const context: UoaLocalSessionContext = {
    ...binding,
    role: projected.orgRole ?? binding.role,
  }
  const exactFirstPartyLinks = await transaction.productAccountLink.findMany({
    where: {
      organizationId: context.organizationId,
      product: {
        authMode: { in: [...FIRST_PARTY_UOA_AUTH_MODES] },
        pluginManifestRef: { startsWith: 'first-party/' },
      },
      status: 'linked',
      uoaSub: input.nextIdentity.subject,
      userId: input.userId,
    },
    select: {
      id: true,
      productSlug: true,
      uoaTokenVersion: true,
    },
  })
  if (
    !exactFirstPartyLinks.some(
      (link) => link.id === linkId && link.productSlug === 'nessie',
    )
    || exactFirstPartyLinks.some(
      (link) => link.uoaTokenVersion !== null
        && link.uoaTokenVersion > nextVersion,
    )
  ) {
    throw new UoaLocalSessionBindingError(
      'A first-party account link no longer matches this session epoch.',
    )
  }

  const now = new Date()
  for (const link of exactFirstPartyLinks) {
    const updated = await transaction.productAccountLink.updateMany({
      where: {
        id: link.id,
        organizationId: context.organizationId,
        status: 'linked',
        uoaSub: input.nextIdentity.subject,
        userId: input.userId,
        OR: [
          { uoaTokenVersion: null },
          { uoaTokenVersion: { lte: nextVersion } },
        ],
      },
      data: {
        activeOrgId: input.nextIdentity.organizationId,
        activeTeamId: input.nextIdentity.teamId,
        lastVerifiedAt: now,
        uoaTokenVersion: nextVersion,
      },
    })
    if (updated.count !== 1) {
      throw new UoaLocalSessionBindingError(
        'A first-party account link changed while refreshing the session.',
      )
    }
  }
  return context
}

/**
 * Publish a verified rotation directory only after its binding transaction
 * commits. The cache is non-authoritative; the durable alert reconciliation is
 * best-effort and can retry at the next login or token rotation.
 */
export const syncUoaDirectoryAfterSessionCommit = async (
  prisma: PrismaClient,
  input: {
    nextIdentity: UoaSessionIdentity
    userId: string
    teamDirectory?: UoaTeamDirectory
  },
): Promise<void> => {
  if (!input.teamDirectory) return
  rememberUoaTeamDirectory(input.userId, input.teamDirectory)
  try {
    const organization = await prisma.organization.findUnique({
      where: { externalOrgId: input.nextIdentity.organizationId },
      select: { id: true },
    })
    if (!organization) {
      console.warn('[uoa] team invitation alert sync skipped: local organization missing')
      return
    }
    await syncTeamInviteAlerts(prisma, {
      organizationId: organization.id,
      pendingInvites: input.teamDirectory.pendingInvites,
      userId: input.userId,
    })
  } catch (error) {
    console.warn('[uoa] team invitation alert sync failed after rotation', error)
  }
}

export const advanceUoaLocalSessionBinding = async (
  prisma: PrismaClient,
  input: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[1],
): Promise<UoaLocalSessionContext> => {
  const context = await prisma.$transaction(
    (transaction) => advanceUoaLocalSessionBindingInTransaction(transaction, input),
    AUTH_LOCK_TRANSACTION_OPTIONS,
  )
  await syncUoaDirectoryAfterSessionCommit(prisma, {
    nextIdentity: input.nextIdentity,
    userId: input.userId,
    teamDirectory: input.teamDirectory,
  })
  return context
}
