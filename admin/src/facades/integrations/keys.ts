// Integration cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const mcpKeys = {
  tools: ['mcp-tools'] as const,
}

/**
 * Integration reads are entitlement-switched surfaces: the caller's org, team,
 * user, and owner verdict decide what comes back, so all four are part of cache
 * identity. Each family keeps a bare prefix beside its scoped key so a mutation
 * can invalidate every scope at once.
 */
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

export const integrationManifestKey = (productSlug?: string) =>
  ['integrations', 'manifest', productSlug ?? 'none'] as const

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

export const mcpToolRegistryKey = (
  scope: IntegrationQueryScope,
  enabled: boolean,
  filters: {
    scopeKey?: string
    source?: string
    status?: string
  },
) => [
  ...mcpKeys.tools,
  ...scopeParts(scope),
  enabled ? 'enabled' : 'disabled',
  filters.status ?? null,
  filters.source ?? null,
  filters.scopeKey ?? null,
] as const

export const toolPolicyTargetsKeyPrefix =
  [...mcpKeys.tools, 'policy-targets'] as const

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
