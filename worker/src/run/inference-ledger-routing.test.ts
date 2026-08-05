import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type {
  LedgerAttribution,
  LedgerIdentityService,
} from '@nessie/runtime'
import {
  parseOrganizationId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { runInferenceGraph } from './inference.js'
import { createProviderRequestHeadersResolver } from './inference-identity.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const AGENT_ID = '44444444-4444-4444-8444-444444444444'
const RUN_ID = '55555555-5555-4555-8555-555555555555'

const attribution: LedgerAttribution = {
  actorId: USER_ID,
  actorType: 'user',
  agentId: AGENT_ID,
  organizationId: ORGANIZATION_ID,
  requestId: 'request-provider-ledger',
  runId: RUN_ID,
  teamId: TEAM_ID,
  userId: USER_ID,
}

const actorContext: AuthorizedActionContext = {
  actor: {
    actorId: USER_ID,
    actorType: 'user',
    roles: ['member'],
  },
  actionContext: {
    requestId: 'request-provider-ledger',
  },
  tenant: {
    organizationId: parseOrganizationId(ORGANIZATION_ID),
    teamId: parseTeamId(TEAM_ID),
  },
}

const modelConfig: ModelConfig = {
  apiKey: 'ledger-proxy-token',
  backends: [],
  maxTokens: 2048,
  modelName: 'gpt-5-mini',
  provider: 'openai',
  temperature: 0.2,
}

test('provider-record Ledger URL signs complete identity after route resolution', async () => {
  let queryCount = 0
  const prisma = {
    $queryRaw: async () => {
      queryCount += 1
      return queryCount === 1
        ? [{
            authSecretRef: 'DIRECT_PROVIDER_SECRET',
            baseUrl: 'https://ledger.unlikeotherai.com/v1',
            connectorKind: 'compiled',
            id: '66666666-6666-4666-8666-666666666666',
          }]
        : [{ id: '77777777-7777-4777-8777-777777777777' }]
    },
  } as unknown as PrismaClient

  let signedAttribution: LedgerAttribution | undefined
  let signedOptions: { requireUoaIdentity?: boolean } | undefined
  const identity = {
    requestHeaders: async (
      input: LedgerAttribution,
      options?: { requireUoaIdentity?: boolean },
    ) => {
      signedAttribution = input
      signedOptions = options
      return {
        'X-Nessie-Context': 'signed-user-team-agent-run',
        'X-UOA-Delegation': 'delegated-sso-user',
      }
    },
  } satisfies LedgerIdentityService
  const requestHeadersForProvider = createProviderRequestHeadersResolver({
    attribution,
    ledgerIdentity: identity,
  })

  const originalFetch = globalThis.fetch
  let captured: { headers: Headers; url: string } | undefined
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured = {
      headers: new Headers(init?.headers),
      url: url.toString(),
    }
    const body = [
      'data: {"id":"chatcmpl-1","model":"gpt-5-mini","choices":[{"delta":{"content":"signed"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-5-mini","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const result = await runInferenceGraph(prisma, {
      actorContext,
      agent: {
        id: AGENT_ID,
        model: 'gpt-5-mini',
        provider: 'openai',
        routingProfileId: null,
      },
      baseMessages: [{ content: 'Hello', role: 'user' }],
      modelConfig,
      organizationId: ORGANIZATION_ID,
      requestHeadersForProvider,
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalAnswer, 'signed')
    assert.deepEqual(signedAttribution, attribution)
    assert.deepEqual(signedOptions, { requireUoaIdentity: true })
    assert.equal(
      captured?.url,
      'https://ledger.unlikeotherai.com/v1/openai/chat/completions',
    )
    assert.equal(
      captured?.headers.get('authorization'),
      'Bearer ledger-proxy-token',
    )
    assert.equal(
      captured?.headers.get('x-nessie-context'),
      'signed-user-team-agent-run',
    )
    assert.equal(
      captured?.headers.get('x-uoa-delegation'),
      'delegated-sso-user',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('effective Ledger route fails before dispatch when identity is unavailable', async () => {
  const resolveHeaders = createProviderRequestHeadersResolver({
    attribution,
    ledgerIdentity: null,
  })

  await assert.rejects(
    resolveHeaders({
      apiKey: 'ledger-proxy-token',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
      connectorKind: 'compiled',
      model: 'gpt-5-mini',
      providerKey: 'openai',
    }),
    /Ledger identity service is unavailable/,
  )
})

test('direct provider routes do not require or receive Ledger identity', async () => {
  const resolveHeaders = createProviderRequestHeadersResolver({
    attribution,
    ledgerIdentity: null,
  })

  assert.equal(
    await resolveHeaders({
      apiKey: 'direct-provider-key',
      baseUrl: 'https://api.openai.com/v1',
      connectorKind: 'compiled',
      model: 'gpt-5-mini',
      providerKey: 'openai',
    }),
    undefined,
  )
})

test('a Ledger catalog service without a compiled connector uses its chat-completions route', async () => {
  let queryCount = 0
  const prisma = {
    $queryRaw: async () => {
      queryCount += 1
      return queryCount === 1
        ? [{
            authSecretRef: null,
            baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
            connectorKind: 'compiled',
            id: '66666666-6666-4666-8666-666666666666',
          }]
        : []
    },
  } as unknown as PrismaClient

  const originalFetch = globalThis.fetch
  let requestedUrl: string | undefined
  globalThis.fetch = (async (url: string | URL) => {
    requestedUrl = url.toString()
    return new Response([
      'data: {"id":"chatcmpl-1","model":"mistral-large","choices":[{"delta":{"content":"routed"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"mistral-large","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const result = await runInferenceGraph(prisma, {
      actorContext,
      agent: {
        id: AGENT_ID,
        model: 'mistral-large',
        provider: 'mistral',
        routingProfileId: null,
      },
      baseMessages: [{ content: 'Hello', role: 'user' }],
      modelConfig,
      organizationId: ORGANIZATION_ID,
      requestHeadersForProvider: createProviderRequestHeadersResolver({
        attribution,
        ledgerIdentity: {
          requestHeaders: async () => ({
            'X-Nessie-Context': 'signed-user-team-agent-run',
          }),
        },
      }),
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalAnswer, 'routed')
    assert.equal(
      requestedUrl,
      'https://ledger.unlikeotherai.com/v1/mistral/chat/completions',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
