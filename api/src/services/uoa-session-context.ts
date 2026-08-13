import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
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

  const { linkId, ...context } = await loadBinding(
    transaction as unknown as UoaSessionContextPrisma,
    {
      identity: input.nextIdentity,
      tokenVersions: previousVersion === nextVersion
        ? [previousVersion]
        : [previousVersion, nextVersion],
      userId: input.userId,
    },
  )
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
      metadata: true,
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
    const metadata = link.metadata
      && typeof link.metadata === 'object'
      && !Array.isArray(link.metadata)
      ? link.metadata as Prisma.JsonObject
      : {}
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
        ...(input.workspaceDirectory
          ? {
              metadata: {
                ...metadata,
                workspaceDirectory: input.workspaceDirectory,
              },
            }
          : {}),
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
