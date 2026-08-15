import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import { rememberUoaWorkspaceDirectory } from './uoa-directory-cache.js'
import type { ExternalAuthWorkspace } from './identity-display.js'
import { projectUoaRoles, resolveUoaRoleClaims } from './uoa-roles.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'

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

const requireTokenVersion = (identity: UoaSessionIdentity): number => {
  if (identity.tokenVersion === null) {
    throw new UoaLocalSessionBindingError(
      'The UnlikeOtherAI session is missing its revocation epoch.',
    )
  }
  return identity.tokenVersion
}

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
      externalWorkspaceId: input.identity.teamId,
      members: { some: { userId: input.userId } },
      project: {
        members: { some: { userId: input.userId } },
        organization: {
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
      'The UnlikeOtherAI workspace is no longer available in Nessie.',
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

/** Resolve the exact live local workspace for an immutable UOA session proof. */
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
 * Advance Nessie's stable account-link epoch after UOA has refreshed the same
 * immutable subject/org/team tuple. The signed family proof and exact Team
 * mapping remain the workspace authority. ProductAccountLink.activeOrgId /
 * activeTeamId are only last-seen UI metadata and cannot invalidate another
 * live family for the same user in a different team.
 */
const advanceUoaBindingInTransaction = async (
  transaction: Prisma.TransactionClient,
  input: {
    nextIdentity: UoaSessionIdentity
    previousIdentity: UoaSessionIdentity
    userId: string
    workspace?: ExternalAuthWorkspace
    workspaceDirectory?: UoaWorkspaceDirectoryEntry[]
  },
  allowWorkspaceRescope: boolean,
): Promise<UoaLocalSessionContext> => {
  const previousVersion = requireTokenVersion(input.previousIdentity)
  const nextVersion = requireTokenVersion(input.nextIdentity)
  if (
    input.nextIdentity.subject !== input.previousIdentity.subject
    || (
      !allowWorkspaceRescope
      && (
        input.nextIdentity.organizationId !== input.previousIdentity.organizationId
        || input.nextIdentity.teamId !== input.previousIdentity.teamId
      )
    )
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
    claims: resolveUoaRoleClaims(input.workspace, input.nextIdentity.teamId),
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    teamId: binding.teamId,
    userId: input.userId,
  })
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
        lastVerifiedAt: now,
        uoaTokenVersion: nextVersion,
        ...(allowWorkspaceRescope
          ? {
              activeOrgId: input.nextIdentity.organizationId,
              activeTeamId: input.nextIdentity.teamId,
            }
          : {}),
      },
    })
    if (updated.count !== 1) {
      throw new UoaLocalSessionBindingError(
        'A first-party account link changed while refreshing the session.',
      )
    }
  }
  // The refreshed directory is UOA-owned display data: it belongs in the
  // bounded in-memory cache, not in the link row. Written here, inside the
  // rotation transaction, because this is where the rotation's verified
  // directory arrives; a transaction that later rolls back leaves at worst a
  // fresh copy of this same user's own workspaces in a non-authoritative cache.
  rememberUoaWorkspaceDirectory(input.userId, input.workspaceDirectory)
  return context
}

export const advanceUoaLocalSessionBindingInTransaction = async (
  transaction: Prisma.TransactionClient,
  input: Parameters<typeof advanceUoaBindingInTransaction>[1],
): Promise<UoaLocalSessionContext> =>
  advanceUoaBindingInTransaction(transaction, input, false)

/**
 * Commit a UOA-authorized change to the family's workspace tuple. This is a
 * sibling of ordinary same-scope renewal: it permits only org/team rescoping,
 * retains the immutable subject and monotonic epoch checks, resolves the exact
 * materialized target membership, and updates product-link workspace fields as
 * non-authoritative last-seen metadata in the caller's transaction.
 */
export const rescopeUoaLocalSessionBindingInTransaction = async (
  transaction: Prisma.TransactionClient,
  input: Parameters<typeof advanceUoaBindingInTransaction>[1],
): Promise<UoaLocalSessionContext> =>
  advanceUoaBindingInTransaction(transaction, input, true)

export const advanceUoaLocalSessionBinding = async (
  prisma: PrismaClient,
  input: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[1],
): Promise<UoaLocalSessionContext> => prisma.$transaction((transaction) =>
  advanceUoaLocalSessionBindingInTransaction(transaction, input),
AUTH_LOCK_TRANSACTION_OPTIONS)
