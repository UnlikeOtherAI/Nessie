import type { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  type LedgerAttribution,
} from '@nessie/runtime'
import type {
  AuthorizedActionContext,
  UoaSessionIdentity,
} from '@nessie/schemas'

export type BillingWorkspacePrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

export type BillingWorkspace = {
  attribution: LedgerAttribution
  sessionIdentity: UoaSessionIdentity & { tokenVersion: number }
  internalOrganizationId: string
  internalTeamId: string
  organizationName: string
  teamName: string
  externalOrgId: string
  externalTeamId: string
}

export class BillingWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'BILLING_CONTEXT_MISMATCH'
      | 'BILLING_SSO_REQUIRED',
    message: string,
  ) {
    super(message)
    this.name = 'BillingWorkspaceError'
  }
}

export const resolveBillingWorkspace = async (
  prisma: BillingWorkspacePrisma,
  actorContext: AuthorizedActionContext,
): Promise<BillingWorkspace> => {
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
    throw new BillingWorkspaceError(
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
        activeOrgId: true,
        activeTeamId: true,
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
        externalWorkspaceId: true,
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
    || !identityLink.activeOrgId
    || !identityLink.activeTeamId
    || !team?.externalOrgId
    || !team.externalWorkspaceId
  ) {
    throw new BillingWorkspaceError(
      'BILLING_SSO_REQUIRED',
      'Sign in with UnlikeOtherAI SSO and select an active organization and team to view billing.',
    )
  }
  if (
    identityLink.uoaSub !== sessionIdentity.subject
    || identityLink.activeOrgId !== sessionIdentity.organizationId
    || identityLink.activeTeamId !== sessionIdentity.teamId
    || (identityLink.uoaTokenVersion ?? null) !== sessionIdentity.tokenVersion
    || sessionIdentity.organizationId !== team.externalOrgId
    || sessionIdentity.teamId !== team.externalWorkspaceId
  ) {
    throw new BillingWorkspaceError(
      'BILLING_CONTEXT_MISMATCH',
      'Your signed SSO workspace does not match the active Nessie team. Sign in again for this team.',
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
    externalTeamId: team.externalWorkspaceId,
  }
}
