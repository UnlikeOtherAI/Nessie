import type { PrismaClient } from '@prisma/client'
import type { McpCredentialPrincipalType } from '@nessie/schemas'

/**
 * Per-principal credential override service plus the 7-level credential
 * resolution helper used by the tool dispatcher.
 *
 * Spec: `docs/external-tool-integration.md` §4 (Credential Scoping for Tools)
 * and plan §6/D6.
 *
 * Resolution order (most specific → least specific):
 *   user → agent → channel → team → project → organization → default
 * The "default" is the instance's own `credentialRef`. The first non-null hit
 * wins. Returning `null` means "no credential configured" — the caller decides
 * whether that's a failure (most tools) or fine (servers with `none` auth).
 */

export const MCP_CREDENTIAL_ERROR_CODES = {
  INSTANCE_NOT_FOUND: 'MCP_CREDENTIAL_INSTANCE_NOT_FOUND',
  OVERRIDE_NOT_FOUND: 'MCP_CREDENTIAL_OVERRIDE_NOT_FOUND',
  CREDENTIAL_REF_FORBIDDEN: 'MCP_CREDENTIAL_REF_FORBIDDEN',
  USER_SCOPE_MISMATCH: 'MCP_CREDENTIAL_USER_SCOPE_MISMATCH',
} as const

export class McpCredentialError extends Error {
  override readonly name = 'McpCredentialError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type McpCredentialOverrideRow = {
  id: string
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  credentialRef: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Principal chain used by `resolveCredentialRef`. Callers populate the
 * principals that apply to the current call. Any missing entry is skipped.
 */
export type CredentialResolutionContext = {
  userId?: string | null
  agentId?: string | null
  channelId?: string | null
  teamId?: string | null
  projectId?: string | null
  organizationId?: string | null
}

const CREDENTIAL_RESOLUTION_ORDER: Array<{
  principalType: McpCredentialPrincipalType
  field: keyof CredentialResolutionContext
}> = [
  { principalType: 'user', field: 'userId' },
  { principalType: 'agent', field: 'agentId' },
  { principalType: 'channel', field: 'channelId' },
  { principalType: 'team', field: 'teamId' },
  { principalType: 'project', field: 'projectId' },
  { principalType: 'organization', field: 'organizationId' },
]

export const listOverrides = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<McpCredentialOverrideRow[]> => {
  return prisma.mcpServerCredentialOverride.findMany({
    where: { instanceId },
    orderBy: [{ createdAt: 'asc' }],
  })
}

export type UpsertOverrideInput = {
  instanceId: string
  principalType: McpCredentialPrincipalType
  principalId: string
  credentialRef: string
}

export const upsertOverride = async (
  prisma: PrismaClient,
  input: UpsertOverrideInput,
): Promise<McpCredentialOverrideRow> => {
  if (!input.credentialRef.startsWith('secret_')) {
    throw new McpCredentialError(
      MCP_CREDENTIAL_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN,
      'Credential overrides must use an opaque reference minted by the encrypted secret store',
    )
  }
  return prisma.mcpServerCredentialOverride.upsert({
    where: {
      instanceId_principalType_principalId: {
        instanceId: input.instanceId,
        principalType: input.principalType,
        principalId: input.principalId,
      },
    },
    create: {
      instanceId: input.instanceId,
      principalType: input.principalType,
      principalId: input.principalId,
      credentialRef: input.credentialRef,
    },
    update: {
      credentialRef: input.credentialRef,
    },
  })
}

export const deleteOverride = async (
  prisma: PrismaClient,
  input: {
    instanceId: string
    principalType: McpCredentialPrincipalType
    principalId: string
  },
): Promise<boolean> => {
  const existing = await prisma.mcpServerCredentialOverride.findUnique({
    where: {
      instanceId_principalType_principalId: {
        instanceId: input.instanceId,
        principalType: input.principalType,
        principalId: input.principalId,
      },
    },
  })
  if (!existing) return false
  await prisma.mcpServerCredentialOverride.delete({ where: { id: existing.id } })
  return true
}

/**
 * 7-level credential resolution. The returned ref is opaque — pass it to the
 * `SecretResolver` (see `secret-resolver.ts`) to obtain plaintext at dispatch
 * time. NEVER persist or log the resolved plaintext.
 *
 * Owner rule (install scope is a hard ceiling): for a user-scoped instance the
 * run's effective user must be the installing user (`context.userId` must equal
 * the instance's scope id) before the instance's stored credential is used.
 * When it is not, resolution FAILS CLOSED — the installer's secret must never
 * resolve for a run acting as someone else. Per-principal overrides keyed to
 * other principals are explicit grants by a privileged actor and still resolve.
 */
export const resolveCredentialRef = async (
  prisma: PrismaClient,
  instanceId: string,
  context: CredentialResolutionContext,
): Promise<string | null> => {
  const instance = await prisma.mcpServerInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, credentialRef: true, scopeType: true, scopeId: true },
  })
  if (!instance) {
    throw new McpCredentialError(
      MCP_CREDENTIAL_ERROR_CODES.INSTANCE_NOT_FOUND,
      `MCP server instance ${instanceId} not found`,
    )
  }

  for (const { principalType, field } of CREDENTIAL_RESOLUTION_ORDER) {
    const principalId = context[field]
    if (!principalId) continue
    const override = await prisma.mcpServerCredentialOverride.findUnique({
      where: {
        instanceId_principalType_principalId: {
          instanceId,
          principalType,
          principalId,
        },
      },
      select: { credentialRef: true },
    })
    if (override?.credentialRef) {
      return override.credentialRef
    }
  }

  if (instance.scopeType === 'user' && context.userId !== instance.scopeId) {
    throw new McpCredentialError(
      MCP_CREDENTIAL_ERROR_CODES.USER_SCOPE_MISMATCH,
      `MCP server instance ${instanceId} is scoped to a specific user; its credential is not available to this caller`,
    )
  }

  return instance.credentialRef ?? null
}
