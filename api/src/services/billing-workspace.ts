import type { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  loadLedgerUoaIdentity,
  type LedgerAttribution,
  type LedgerUoaIdentity,
} from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

export type BillingWorkspacePrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

export type BillingWorkspace = {
  attribution: LedgerAttribution
  identity: LedgerUoaIdentity & {
    organizationId: string
    teamId: string
  }
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
  const internalTeamId =
    actorContext.tenant.teamId ?? actorContext.actionContext.teamId
  if (!internalTeamId) {
    throw new BillingWorkspaceError(
      'BILLING_SSO_REQUIRED',
      'Select a team before viewing billing.',
    )
  }

  const [identity, team] = await Promise.all([
    loadLedgerUoaIdentity(prisma, attribution),
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
    !identity?.organizationId
    || !identity.teamId
    || !team?.externalOrgId
    || !team.externalWorkspaceId
  ) {
    throw new BillingWorkspaceError(
      'BILLING_SSO_REQUIRED',
      'Sign in with UnlikeOtherAI SSO and select an active organization and team to view billing.',
    )
  }
  if (
    identity.organizationId !== team.externalOrgId
    || identity.teamId !== team.externalWorkspaceId
  ) {
    throw new BillingWorkspaceError(
      'BILLING_CONTEXT_MISMATCH',
      'Your signed SSO workspace does not match the active Nessie team. Sign in again for this team.',
    )
  }

  return {
    attribution,
    identity: {
      ...identity,
      organizationId: identity.organizationId,
      teamId: identity.teamId,
    },
    internalOrganizationId: actorContext.tenant.organizationId,
    internalTeamId,
    organizationName: team.project.organization.name,
    teamName: team.name,
    externalOrgId: team.externalOrgId,
    externalTeamId: team.externalWorkspaceId,
  }
}
