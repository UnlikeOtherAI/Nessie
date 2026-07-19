export type IntegrationQueryScope = {
  isOwner: boolean
  organizationId: string
  teamId: string
  userId: string
}

const scopeParts = (scope: IntegrationQueryScope) => [
  scope.organizationId,
  scope.teamId,
  scope.userId,
  scope.isOwner ? 'owner' : 'member',
] as const

export const integratedProductsKeyPrefix =
  ['integrations', 'products', 'catalog'] as const

export const integratedProductsKey = (scope: IntegrationQueryScope) => [
  ...integratedProductsKeyPrefix,
  ...scopeParts(scope),
] as const

export const deepWaterResearchRunsKeyPrefix =
  ['integrations', 'products', 'deep-water', 'research-runs'] as const

export const deepWaterResearchRunsKey = (scope: IntegrationQueryScope) => [
  ...deepWaterResearchRunsKeyPrefix,
  ...scopeParts(scope),
] as const

export const deepWaterAgentAccessKeyPrefix =
  ['integrations', 'products', 'deep-water', 'agent-access'] as const

export const deepWaterAgentAccessKey = (scope: IntegrationQueryScope) => [
  ...deepWaterAgentAccessKeyPrefix,
  ...scopeParts(scope),
] as const

export const deepSignalSignalsKeyPrefix =
  ['integrations', 'products', 'deepsignal', 'signals'] as const

export const deepSignalSignalsKey = (
  scope: IntegrationQueryScope,
  include: 'active' | 'all',
) => [
  ...deepSignalSignalsKeyPrefix,
  ...scopeParts(scope),
  include,
] as const

export const mcpToolRegistryKeyPrefix = ['mcp-tools'] as const

export const mcpToolRegistryKey = (
  scope: IntegrationQueryScope,
  enabled: boolean,
  filters: {
    scopeKey?: string
    source?: string
    status?: string
  },
) => [
  ...mcpToolRegistryKeyPrefix,
  ...scopeParts(scope),
  enabled ? 'enabled' : 'disabled',
  filters.status ?? null,
  filters.source ?? null,
  filters.scopeKey ?? null,
] as const

export const toolPolicyTargetsKeyPrefix =
  ['mcp-tools', 'policy-targets'] as const

export const toolPolicyTargetsKey = (scope: {
  isOwner: boolean
  organizationId: string
  userId: string
}) => [
  ...toolPolicyTargetsKeyPrefix,
  scope.organizationId,
  scope.userId,
  scope.isOwner ? 'owner' : 'member',
] as const
