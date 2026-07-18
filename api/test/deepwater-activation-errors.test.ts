import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  ensureDeepWaterTeamInstance,
  LedgerDeepWaterCatalogUnavailableError,
  LedgerDeepWaterMcpUrlUnsetError,
  LedgerIdentityConfigurationUnsetError,
  LedgerProxyTokenUnsetError,
} from '../src/services/deepwater-activation.js'

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  teamId: '22222222-2222-4222-8222-222222222222',
}
const actorContext = {
  tenant: { organizationId: scope.organizationId },
  actor: {
    actorId: '33333333-3333-4333-8333-333333333333',
    actorType: 'user',
    roles: ['owner'],
  },
  actionContext: {},
} as unknown as AuthorizedActionContext

const fakePrisma = (catalogEntryId: string | null): PrismaClient => {
  const tx = {
    $executeRaw: async () => 0,
    mcpCatalogEntry: {
      findFirst: async () => catalogEntryId ? { id: catalogEntryId } : null,
    },
  }
  return {
    ...tx,
    $transaction: async (action: (client: typeof tx) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient
}

test('enable fails loudly when the linked first-party DeepWater catalog is absent', async () => {
  await assert.rejects(
    ensureDeepWaterTeamInstance(fakePrisma(null), actorContext, scope),
    (error: unknown) =>
      error instanceof LedgerDeepWaterCatalogUnavailableError
      && error.code === 'LEDGER_DEEPWATER_CATALOG_UNAVAILABLE',
  )
})

test('enable fails loudly when LEDGER_DEEPWATER_MCP_URL is unset', async () => {
  const previous = process.env.LEDGER_DEEPWATER_MCP_URL
  delete process.env.LEDGER_DEEPWATER_MCP_URL
  try {
    await assert.rejects(
      ensureDeepWaterTeamInstance(fakePrisma('deep-water-catalog'), actorContext, scope),
      (error: unknown) =>
        error instanceof LedgerDeepWaterMcpUrlUnsetError
        && error.code === 'LEDGER_DEEPWATER_MCP_URL_UNSET',
    )
  } finally {
    if (previous === undefined) delete process.env.LEDGER_DEEPWATER_MCP_URL
    else process.env.LEDGER_DEEPWATER_MCP_URL = previous
  }
})

test('enable fails loudly when LEDGER_PROXY_TOKEN is unset', async () => {
  const previousUrl = process.env.LEDGER_DEEPWATER_MCP_URL
  const previousToken = process.env.LEDGER_PROXY_TOKEN
  process.env.LEDGER_DEEPWATER_MCP_URL = 'https://ledger.example.com/deepwater'
  delete process.env.LEDGER_PROXY_TOKEN
  try {
    await assert.rejects(
      ensureDeepWaterTeamInstance(fakePrisma('deep-water-catalog'), actorContext, scope),
      (error: unknown) =>
        error instanceof LedgerProxyTokenUnsetError
        && error.code === 'LEDGER_PROXY_TOKEN_UNSET',
    )
  } finally {
    if (previousUrl === undefined) delete process.env.LEDGER_DEEPWATER_MCP_URL
    else process.env.LEDGER_DEEPWATER_MCP_URL = previousUrl
    if (previousToken === undefined) delete process.env.LEDGER_PROXY_TOKEN
    else process.env.LEDGER_PROXY_TOKEN = previousToken
  }
})

test('enable fails loudly when signed Ledger identity is unconfigured', async () => {
  const previousUrl = process.env.LEDGER_DEEPWATER_MCP_URL
  const previousToken = process.env.LEDGER_PROXY_TOKEN
  const previousDomain = process.env.UOA_DOMAIN
  process.env.LEDGER_DEEPWATER_MCP_URL = 'https://ledger.example.com/deepwater'
  process.env.LEDGER_PROXY_TOKEN = 'service-token'
  delete process.env.UOA_DOMAIN
  try {
    await assert.rejects(
      ensureDeepWaterTeamInstance(fakePrisma('deep-water-catalog'), actorContext, scope),
      (error: unknown) =>
        error instanceof LedgerIdentityConfigurationUnsetError
        && error.code === 'LEDGER_IDENTITY_UNCONFIGURED',
    )
  } finally {
    if (previousUrl === undefined) delete process.env.LEDGER_DEEPWATER_MCP_URL
    else process.env.LEDGER_DEEPWATER_MCP_URL = previousUrl
    if (previousToken === undefined) delete process.env.LEDGER_PROXY_TOKEN
    else process.env.LEDGER_PROXY_TOKEN = previousToken
    if (previousDomain === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previousDomain
  }
})
