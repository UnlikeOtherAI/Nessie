import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
  resolveCredentialRef,
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

test('a user-scope mismatch never hides an explicit grant to another principal', async () => {
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
      }) =>
        where.instanceId_principalType_principalId.principalType === 'agent'
          ? { credentialRef: 'secret_agent_grant' }
          : null,
    },
  } as unknown as PrismaClient

  // An agent-level override is an explicit grant by a privileged actor, not a
  // leak of the installer's secret: it resolves even when the run's effective
  // user is not the installer.
  assert.equal(
    await resolveCredentialRef(prisma, 'instance-1', {
      userId: 'user-2',
      agentId: 'agent-1',
    }),
    'secret_agent_grant',
  )
})

test('shared-scope instances keep resolving regardless of the effective user', async () => {
  for (const scopeType of ['system', 'organization', 'team', 'project', 'channel']) {
    const prisma = {
      mcpServerInstance: {
        findUnique: async () => ({
          id: 'instance-1',
          credentialRef: 'secret_shared',
          scopeType,
          scopeId: 'scope-1',
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
