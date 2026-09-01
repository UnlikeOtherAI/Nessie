import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_ANNOTATIONS_METADATA_KEY,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

export type McpToolGrantSeed = {
  agentId?: string | null
  config: unknown
  roleId?: string | null
  state?: string
}

export type RowSeed = {
  annotations?: Record<string, unknown>
  authConfig?: unknown
  authMethod?: 'api_key' | 'bearer' | 'basic' | 'oauth2' | 'none'
  catalogName?: string
  catalogVisibility?: string
  credentialRef?: string | null
  description?: string
  grants?: McpToolGrantSeed[]
  id: string
  inputSchema?: Record<string, unknown>
  integratedProductSlugs?: string[]
  outputSchema?: Record<string, unknown> | null
  requiresExplicitGrant?: boolean
  scopeId: string
  scopeType: string
  toolName: string
}

const metadataFor = (row: RowSeed): Record<string, unknown> =>
  ({
    ...(row.requiresExplicitGrant ? { requiresExplicitGrant: true } : {}),
    [MCP_TOOL_DESCRIPTOR_ANNOTATIONS_METADATA_KEY]: row.annotations ?? {},
  })

export const descriptorFingerprintForRow = (row: RowSeed): string =>
  fingerprintMcpToolDescriptor({
    annotations: mcpToolDescriptorAnnotationsFromMetadata(metadataFor(row)),
    description: row.description ?? '',
    inputSchema: row.inputSchema ?? { type: 'object' },
    name: row.toolName,
    outputSchema: row.outputSchema ?? null,
  })

export const currentAllowedGrantFor = (
  row: RowSeed,
  agentId = 'agent-1',
): McpToolGrantSeed => ({
  agentId,
  config: { descriptorFingerprint: descriptorFingerprintForRow(row) },
  state: 'allowed',
})

export const makeMcpPrisma = (
  rows: RowSeed[],
  options: {
    credentialOverrideRef?: string
    credentialOverrideUserId?: string
    onConnectorUsage?: () => void
    onCredentialOverrideLookup?: () => void
  } = {},
): PrismaClient => {
  return {
    toolRegistryEntry: {
      findMany: async (args: unknown) => {
        const grantWhere = (args as {
          select?: { grants?: { where?: { agentId?: string; roleId?: null; state?: string } } }
        }).select?.grants?.where
        return rows.map((row) => ({
          id: row.id,
          toolId: `mcp:inst-${row.id}:${row.toolName}`,
          label: row.toolName,
          description: row.description ?? '',
          inputSchema: row.inputSchema ?? { type: 'object' },
          outputSchema: row.outputSchema ?? null,
          transportConfig: {
            transport: 'mcp',
            serverId: `inst-${row.id}`,
            toolName: row.toolName,
          },
          metadata: metadataFor(row),
          grants: (row.grants ?? [])
            .filter((grant) =>
              (!grantWhere?.agentId || grant.agentId === grantWhere.agentId)
              && (grantWhere?.roleId === undefined
                || (grant.roleId ?? null) === grantWhere.roleId)
              && (!grantWhere?.state || (grant.state ?? 'allowed') === grantWhere.state))
            .map((grant) => ({
              agentId: grant.agentId ?? 'agent-1',
              config: grant.config,
              state: grant.state ?? 'allowed',
            })),
          mcpInstanceId: `inst-${row.id}`,
          mcpInstance: {
            credentialRef: row.credentialRef ?? null,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            transportConfig: {},
            catalogEntry: {
              label: row.catalogName ?? 'Example',
              name: row.catalogName ?? 'example',
              visibility: row.catalogVisibility ?? 'private',
              integratedProducts: (row.integratedProductSlugs ?? []).map(
                (slug) => ({ slug }),
              ),
              authMethod: row.authMethod ?? 'none',
              authConfig: row.authConfig ?? { method: 'none' },
              defaultTransportConfig: {
                transport: 'http',
                url: 'https://mcp.example.com/mcp',
              },
            },
          },
        }))
      },
    },
    mcpServerInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows.find((candidate) => `inst-${candidate.id}` === where.id)
        return {
          id: where.id,
          credentialRef: row?.credentialRef ?? null,
          scopeId: row?.scopeId ?? 'org-1',
          scopeType: row?.scopeType ?? 'organization',
          catalogEntry: {
            authMethod: row?.authMethod ?? 'none',
            authConfig: row?.authConfig ?? { method: 'none' },
          },
        }
      },
    },
    mcpServerCredentialOverride: {
      findUnique: async ({ where }: {
        where: { instanceId_principalType_principalId: { principalId: string } }
      }) => {
        options.onCredentialOverrideLookup?.()
        return options.credentialOverrideRef
          && (!options.credentialOverrideUserId
            || where.instanceId_principalType_principalId.principalId
              === options.credentialOverrideUserId)
          ? { credentialRef: options.credentialOverrideRef }
          : null
      },
    },
    connectorUsageEvent: {
      create: async () => {
        options.onConnectorUsage?.()
        return {}
      },
    },
  } as unknown as PrismaClient
}

export const mcpActorContext = (overrides: {
  effectiveUserId?: string | null
  projectId?: string | null
  teamId?: string | null
} = {}): AuthorizedActionContext =>
  ({
    actor: { actorType: 'agent', actorId: 'agent-1', roles: [] },
    tenant: {
      organizationId: 'org-1',
      projectId: overrides.projectId ?? 'project-1',
      teamId: overrides.teamId ?? 'team-1',
    },
    actionContext: {
      effectiveUserId: overrides.effectiveUserId ?? 'user-1',
    },
  }) as unknown as AuthorizedActionContext
