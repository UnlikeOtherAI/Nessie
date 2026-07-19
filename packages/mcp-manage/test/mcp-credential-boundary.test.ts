import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
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
