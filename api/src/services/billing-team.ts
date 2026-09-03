import type { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  type LedgerAttribution,
} from '@nessie/runtime'
import type {
  AuthorizedActionContext,
  UoaSessionIdentity,
} from '@nessie/schemas'

export type BillingTeamPrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

export type BillingTeam = {
  attribution: LedgerAttribution
  sessionIdentity: UoaSessionIdentity & { tokenVersion: number }
  internalOrganizationId: string
  internalTeamId: string
  organizationName: string
  teamName: string
  externalOrgId: string
  externalTeamId: string
}

export class BillingTeamError extends Error {
  constructor(
    public readonly code:
      | 'BILLING_CONTEXT_MISMATCH'
      | 'BILLING_SSO_REQUIRED',
    message: string,
  ) {
    super(message)
    this.name = 'BillingTeamError'
  }
}

export const resolveBillingTeam = async (
  prisma: BillingTeamPrisma,
  actorContext: AuthorizedActionContext,
): Promise<BillingTeam> => {
  const attribution = attributionFromActorContext(actorContext, {
    systemComponent: 'billing-dashboard',
  })
  const sessionIdentity = actorContext.actionContext.uoaIdentity
  const internalTeamId =
    actorContext.tenant.teamId ?? actorContext.actionContext.teamId
  if (
    !internalTeamId
    || actorContext.actor.actorType !== 'user'
    || !sessionIdentity
    || sessionIdentity.tokenVersion === null
  ) {
    throw new BillingTeamError(
      'BILLING_SSO_REQUIRED',
      'Sign in with UnlikeOtherAI SSO and select a team before viewing billing.',
    )
  }

  const [identityLink, team] = await Promise.all([
    prisma.productAccountLink.findUnique({
      where: {
        organizationId_userId_productSlug: {
          organizationId: actorContext.tenant.organizationId,
          productSlug: 'nessie',
          userId: actorContext.actor.actorId,
        },
      },
      select: {
        status: true,
        uoaSub: true,
        uoaTokenVersion: true,
      },
    }),
    prisma.team.findFirst({
      where: {
        id: internalTeamId,
        project: { organizationId: actorContext.tenant.organizationId },
      },
      select: {
        externalOrgId: true,
        externalTeamId: true,
        name: true,
        project: {
          select: {
            organization: { select: { name: true } },
          },
        },
      },
    }),
  ])
  if (
    identityLink?.status !== 'linked'
    || !identityLink.uoaSub
    || !team?.externalOrgId
    || !team.externalTeamId
  ) {
    throw new BillingTeamError(
      'BILLING_SSO_REQUIRED',
      'Sign in with UnlikeOtherAI SSO and select an active organization and team to view billing.',
    )
  }
  if (
    identityLink.uoaSub !== sessionIdentity.subject
    || (identityLink.uoaTokenVersion ?? null) !== sessionIdentity.tokenVersion
    || sessionIdentity.organizationId !== team.externalOrgId
    || sessionIdentity.teamId !== team.externalTeamId
  ) {
    throw new BillingTeamError(
      'BILLING_CONTEXT_MISMATCH',
      'Your signed SSO team does not match the active Nessie team. Sign in again for this team.',
    )
  }

  return {
    attribution,
    sessionIdentity: {
      ...sessionIdentity,
      tokenVersion: sessionIdentity.tokenVersion,
    },
    internalOrganizationId: actorContext.tenant.organizationId,
    internalTeamId,
    organizationName: team.project.organization.name,
    teamName: team.name,
    externalOrgId: team.externalOrgId,
    externalTeamId: team.externalTeamId,
  }
}
