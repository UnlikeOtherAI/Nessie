export type Team = {
  externalOrgId: string | null
  externalWorkspaceId: string | null
  id: string
  name: string
  projectId: string
  systemManaged: boolean
  organizationId: string
}

export type Agent = {
  id: string
  organizationId: string
  name: string
  systemManaged: boolean
  executionMode: string
  agentKind: string
  surfacePolicy: string
  delegationMode: string
}

export type Channel = {
  id: string
  dmKey: string
  label: string
  systemChannelType: string
  archivedAt: Date | null
}

export type ChannelUpdateManyArgs = {
  where: {
    archivedAt?: null
    dmKey?: string
    id?: { in: string[] }
  }
  data: { archivedAt: Date }
}

export const matchesChannelUpdateMany = (
  channel: Channel,
  where: ChannelUpdateManyArgs['where'],
): boolean =>
  (where.id === undefined || where.id.in.includes(channel.id))
  && (where.dmKey === undefined || channel.dmKey === where.dmKey)
  && (where.archivedAt !== null || channel.archivedAt === null)

export type ChannelMember = {
  channelId: string
  userId: string
  role: string
}

export type Thread = { id: string; channelId: string; createdAt: number }
export type AgentBinding = { agentId: string; channelId: string }

export type CatalogEntry = {
  id: string
  name: string
  visibility: string
  status: string
  authMethod: string
  integratedProductSlugs?: string[]
  defaultTransportConfig?: unknown
  organizationId?: string | null
}

export type Instance = {
  id: string
  organizationId: string
  catalogEntryId: string
  scopeType: string
  scopeId: string
  lifecycleState: string
  credentialRef?: string | null
  transportConfig?: unknown
}

export type AccountLink = {
  organizationId: string
  userId: string
  productSlug: string
  status: string
  uoaSub: string | null
  activeOrgId: string | null
  activeTeamId: string | null
}

export type ExternalAgentFakeSeed = {
  externalOrgId?: string
  externalWorkspaceId?: string
  organizationId: string
  projectId: string
  teamId: string
  catalogEntries?: CatalogEntry[]
  instances?: Instance[]
  accountLinks?: AccountLink[]
  teamEnablements?: Array<{
    teamId: string
    productSlug: string
    enabled: boolean
    externalOrgId?: string | null
    externalTeamId?: string | null
  }>
}

export const makeTeamEnablementMap = (
  seed: ExternalAgentFakeSeed,
): Map<
  string,
  { enabled: boolean; externalOrgId: string | null; externalTeamId: string | null }
> =>
  new Map(
    (seed.teamEnablements ?? []).map((enablement) => [
      `${enablement.teamId}:${enablement.productSlug}`,
      {
        enabled: enablement.enabled,
        externalOrgId:
          enablement.externalOrgId === undefined
            ? seed.externalOrgId ?? 'uoa-org'
            : enablement.externalOrgId,
        externalTeamId:
          enablement.externalTeamId === undefined
            ? seed.externalWorkspaceId ?? 'uoa-team'
            : enablement.externalTeamId,
      },
    ]),
  )
