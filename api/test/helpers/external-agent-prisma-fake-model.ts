export type Team = {
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
  }>
}
