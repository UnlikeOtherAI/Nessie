import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
  resolveCredentialRef,
  resolveCredentialRefWithSource,
  upsertOverride,
} from '../src/mcp-credentials.js'

test('credential overrides accept only encrypted-store-minted opaque refs', async () => {
  let writes = 0
  const prisma = {
    mcpServerCredentialOverride: {
      upsert: async () => {
        writes += 1
        return {}
      },
    },
  } as unknown as PrismaClient

  for (const credentialRef of [
    'DEEPSIGNAL_MCP_APP_KEY',
    'NESSIE_AUTH_SECRET',
    'secret://caller-controlled',
  ]) {
    await assert.rejects(
      upsertOverride(prisma, {
        instanceId: 'instance-1',
        principalType: 'user',
        principalId: 'user-1',
        credentialRef,
      }),
      (error: unknown) =>
        error instanceof McpCredentialError
        && error.code === MCP_CREDENTIAL_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN,
    )
  }
  assert.equal(writes, 0)
})
test('a user-scoped instance credential never resolves for a run acting as another user', async () => {
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: 'secret_installer_credential',
        scopeType: 'user',
        scopeId: 'user-1',
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient

  // The installing user's run still resolves the instance credential.
  assert.equal(
    await resolveCredentialRef(prisma, 'instance-1', {
      userId: 'user-1',
      organizationId: 'org-1',
    }),
    'secret_installer_credential',
  )

  // A run whose effective user is anyone else must fail closed: the
  // installer's secret never falls through.
  for (const context of [
    { userId: 'user-2', organizationId: 'org-1' },
    { userId: null, organizationId: 'org-1' },
    { organizationId: 'org-1' },
  ]) {
    await assert.rejects(
      resolveCredentialRef(prisma, 'instance-1', context),
      (error: unknown) =>
        error instanceof McpCredentialError
        && error.code === MCP_CREDENTIAL_ERROR_CODES.USER_SCOPE_MISMATCH,
    )
  }
})

test('a user-scope mismatch fails before consulting any override', async () => {
  let overrideLookups = 0
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: 'secret_installer_credential',
        scopeType: 'user',
        scopeId: 'user-1',
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async ({ where }: {
        where: {
          instanceId_principalType_principalId: {
            principalType: string
            principalId: string
          }
        }
      }) => {
        void where
        overrideLookups += 1
        return { credentialRef: 'secret_agent_grant' }
      },
    },
  } as unknown as PrismaClient

  await assert.rejects(
    resolveCredentialRef(prisma, 'instance-1', {
      userId: 'user-2',
      agentId: 'agent-1',
    }),
    (error: unknown) =>
      error instanceof McpCredentialError
      && error.code === MCP_CREDENTIAL_ERROR_CODES.USER_SCOPE_MISMATCH,
  )
  assert.equal(overrideLookups, 0)
})

test('resolution reports whether an opaque ref came from the user or shared scope', async () => {
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: 'secret_shared',
        scopeType: 'organization',
        scopeId: 'org-1',
        catalogEntry: {
          authMethod: 'api_key',
          authConfig: { method: 'api_key', headerName: 'X-API-Key', valuePrefix: '' },
        },
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async ({ where }: {
        where: { instanceId_principalType_principalId: { principalType: string } }
      }) =>
        where.instanceId_principalType_principalId.principalType === 'user'
          ? { credentialRef: 'secret_personal' }
          : null,
    },
  } as unknown as PrismaClient

  assert.deepEqual(
    await resolveCredentialRefWithSource(prisma, 'instance-1', { userId: 'user-1' }),
    { credentialRef: 'secret_personal', source: 'user_override' },
  )
})

test('shared non-API-key instances resolve only the effective user override', async () => {
  const lookups: Array<{ principalType: string; principalId: string }> = []
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: 'secret_legacy_instance_default',
        scopeType: 'organization',
        scopeId: 'org-1',
        catalogEntry: { authMethod: 'oauth2', authConfig: { method: 'oauth2' } },
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async ({ where }: {
        where: {
          instanceId_principalType_principalId: {
            principalType: string
            principalId: string
          }
        }
      }) => {
        const principal = where.instanceId_principalType_principalId
        lookups.push(principal)
        return principal.principalType === 'user'
          ? { credentialRef: 'secret_effective_user' }
          : { credentialRef: 'secret_legacy_principal_override' }
      },
    },
  } as unknown as PrismaClient

  assert.equal(
    await resolveCredentialRef(prisma, 'instance-1', {
      userId: 'user-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
      teamId: 'team-1',
      projectId: 'project-1',
      organizationId: 'org-1',
    }),
    'secret_effective_user',
  )
  assert.deepEqual(lookups, [{
    instanceId: 'instance-1',
    principalType: 'user',
    principalId: 'user-1',
  }])

  lookups.splice(0)
  assert.equal(
    await resolveCredentialRef(prisma, 'instance-1', {
      agentId: 'agent-1',
      organizationId: 'org-1',
    }),
    null,
  )
  assert.deepEqual(lookups, [])
})

test('shared API-key instances retain their validated default resolution chain', async () => {
  for (const scopeType of ['system', 'organization', 'team', 'project', 'channel']) {
    const prisma = {
      mcpServerInstance: {
        findUnique: async () => ({
          id: 'instance-1',
          credentialRef: 'secret_shared',
          scopeType,
          scopeId: 'scope-1',
          catalogEntry: {
            authMethod: 'api_key',
            authConfig: { method: 'api_key', headerName: 'X-API-Key', valuePrefix: '' },
          },
        }),
      },
      mcpServerCredentialOverride: {
        findUnique: async () => null,
      },
    } as unknown as PrismaClient

    assert.equal(
      await resolveCredentialRef(prisma, 'instance-1', {
        userId: 'user-2',
        organizationId: 'org-1',
      }),
      'secret_shared',
    )
  }
})
