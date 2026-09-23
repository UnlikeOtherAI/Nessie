import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { McpAuthError, McpTimeoutError } from '@nessie/mcp-client'
import {
  LedgerIdentityError,
  UOA_SUBJECT_FORBIDDEN_CODE,
  type DeepWaterBriefRun,
  type LedgerAttribution,
  type LedgerIdentityService,
  type UoaExchangeFailure,
} from '@nessie/runtime'

import {
  callDeepWaterLedgerTool,
  deepWaterAgentOriginAttribution,
  deepWaterSystemAttribution,
  isTransientLedgerRefusal,
} from './deepwater-ledger-call.js'
import type { dispatchTool } from './tool-dispatch.js'

const ORG = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b01'
const CONNECTOR = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b02'
const identity = { subject: 'uoa|r', organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 2 }

const prisma = (catalog: { name: string; visibility: string; slug: string } | null) => ({
  mcpServerInstance: {
    findFirst: async () => catalog && {
      credentialRef: 'LEDGER_PROXY_TOKEN',
      transportConfig: { transport: 'http', url: 'https://ledger.example/v1/mcp/deepwater' },
      catalogEntry: {
        authConfig: { method: 'bearer' },
        defaultTransportConfig: {},
        name: catalog.name,
        visibility: catalog.visibility,
        integratedProducts: [{ slug: catalog.slug }],
      },
    },
  },
  // Operational usage telemetry is best-effort and its write is not under test.
  connectorUsageEvent: { create: async () => ({}) },
}) as unknown as PrismaClient

const managed = { name: 'deep-water', visibility: 'public', slug: 'deep-water' }

const signer = (fail?: LedgerIdentityError): LedgerIdentityService & { toolCallIds: string[] } => {
  const toolCallIds: string[] = []
  return {
    toolCallIds,
    requestHeaders: async (_attribution, options) => {
      if (fail) throw fail
      toolCallIds.push(options?.toolCallId ?? '')
      return { 'X-Nessie-Context': 'signed' }
    },
  }
}

const attribution: LedgerAttribution = { organizationId: ORG, actorId: 'user-1', userId: 'user-1' }

const call = (
  deps: { catalog?: typeof managed | null; ledgerIdentity?: LedgerIdentityService; dispatch: typeof dispatchTool },
) => {
  process.env.LEDGER_PROXY_TOKEN = 'lk_test'
  return callDeepWaterLedgerTool(
    {
      prisma: prisma(deps.catalog === undefined ? managed : deps.catalog),
      ledgerIdentity: deps.ledgerIdentity ?? signer(),
      dispatchMcpTool: deps.dispatch,
    },
    {
      organizationId: ORG,
      connectorId: CONNECTOR,
      attribution,
      toolCallId: 'watch:run:7',
      toolName: 'research_status',
      args: { id: 'rs_abc' },
    },
  )
}

const answer = (success: boolean, structuredContent?: Record<string, unknown>): typeof dispatchTool =>
  async () => ({ success, output: '', raw: { isError: !success, content: [], ...(structuredContent ? { structuredContent } : {}) } })

test('a structured answer comes back as it is, signed with the stable tool-call id', async () => {
  const ledgerIdentity = signer()
  let headers: Record<string, string> | undefined
  const outcome = await call({
    ledgerIdentity,
    dispatch: async (input) => {
      headers = input.spec.transport === 'mcp' && input.spec.connection.transport !== 'stdio'
        ? input.spec.connection.headers
        : undefined
      return { success: true, output: '', raw: { isError: false, content: [], structuredContent: { id: 'rs_abc' } } }
    },
  })
  assert.deepEqual(outcome, { outcome: 'ok', structured: { id: 'rs_abc' } })
  assert.deepEqual(ledgerIdentity.toolCallIds, ['watch:run:7'])
  assert.equal(headers?.Authorization, 'Bearer lk_test')
  assert.equal(headers?.['X-Nessie-Context'], 'signed')
})

test('a Ledger refusal is read from its structured error; only transient ones retry', async () => {
  const outcome = await call({
    dispatch: answer(false, { error: 'upstream_unavailable', error_description: 'retry', status_code: 503 }),
  })
  assert.equal(outcome.outcome, 'refused')
  assert.equal(outcome.outcome === 'refused' && isTransientLedgerRefusal(outcome.error), true)
  const forbidden = await call({ dispatch: answer(false, { error: 'forbidden', status_code: 403 }) })
  assert.equal(forbidden.outcome === 'refused' && isTransientLedgerRefusal(forbidden.error), false)
})

test('an answer outside the contract is malformed, not a success', async () => {
  assert.equal((await call({ dispatch: answer(true) })).outcome, 'malformed')
  assert.equal((await call({ dispatch: answer(false, { detail: 'no code' }) })).outcome, 'malformed')
})

test('a lost connection is unavailable; a refused bearer is a deployment fault and throws', async () => {
  const timeout = await call({ dispatch: async () => { throw new McpTimeoutError('slow', 30_000) } })
  assert.equal(timeout.outcome, 'unavailable')
  await assert.rejects(call({ dispatch: async () => { throw new McpAuthError('401') } }), McpAuthError)
})

const exchangeFailed = (failure: UoaExchangeFailure): LedgerIdentityError =>
  new LedgerIdentityError('LEDGER_UOA_TOKEN_EXCHANGE_FAILED', 'exchange failed', failure)

test('identity: a lost link or a person UOA refuses is identity drift; an outage is unavailable', async () => {
  const dispatch = answer(true, { id: 'rs_abc' })
  const outcome = async (error: LedgerIdentityError) =>
    (await call({ dispatch, ledgerIdentity: signer(error) })).outcome
  assert.equal(await outcome(new LedgerIdentityError('LEDGER_UOA_IDENTITY_REQUIRED', 'no link')), 'identity')
  // UOA's token exchange names this code on a 403 for a moved epoch or a lost
  // organisation, team or domain role; a token for another epoch is the same
  // drift.
  assert.equal(
    await outcome(exchangeFailed({ kind: 'refused', status: 403, code: UOA_SUBJECT_FORBIDDEN_CODE })),
    'identity',
  )
  assert.equal(await outcome(exchangeFailed({ kind: 'epoch_mismatch' })), 'identity')
  for (const status of [408, 429, 500, 503]) {
    assert.equal(await outcome(exchangeFailed({ kind: 'refused', status, code: null })), 'unavailable', `status ${status}`)
  }
  assert.equal(await outcome(exchangeFailed({ kind: 'unreachable' })), 'unavailable')
})

test('identity: a refused client, assertion or delegation, or UOA outside its contract, is a deployment fault and throws', async () => {
  const dispatch = answer(true, { id: 'rs_abc' })
  for (const failure of [
    { kind: 'refused', status: 400, code: null },
    { kind: 'refused', status: 401, code: null },
    // A 403 that does not prove the person was refused: Nessie's delegation
    // mapping, client domain, resource or scope, or a body that hides its code.
    { kind: 'refused', status: 403, code: null },
    { kind: 'refused', status: 403, code: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED' },
    { kind: 'malformed' },
  ] satisfies UoaExchangeFailure[]) {
    await assert.rejects(
      call({ dispatch, ledgerIdentity: signer(exchangeFailed(failure)) }),
      LedgerIdentityError,
      JSON.stringify(failure),
    )
  }
  // An exchange error that never said why is not guessed at either.
  await assert.rejects(
    call({ dispatch, ledgerIdentity: signer(new LedgerIdentityError('LEDGER_UOA_TOKEN_EXCHANGE_FAILED', 'why?')) }),
    LedgerIdentityError,
  )
})

test('only the managed first-party connector is called', async () => {
  const dispatch = answer(true, { id: 'rs_abc' })
  assert.deepEqual(await call({ dispatch, catalog: null }), { outcome: 'connector_missing' })
  assert.deepEqual(
    await call({ dispatch, catalog: { name: 'deep-water', visibility: 'private', slug: 'deep-water' } }),
    { outcome: 'connector_missing' },
  )
})

test('system calls act for the requester as the component\'s stable agent on the product run', () => {
  const run = {
    id: '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b10',
    organizationId: ORG,
    teamId: '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b11',
    requestedByUserId: '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b12',
    channelId: null,
    threadId: null,
    originAgentId: '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b13',
    originRunId: '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6b14',
  } as DeepWaterBriefRun
  const watch = deepWaterSystemAttribution(run, { systemComponent: 'deep-water.delivery', identity })
  const again = deepWaterSystemAttribution(run, { systemComponent: 'deep-water.delivery', identity })
  assert.equal(watch.runId, run.id)
  assert.equal(watch.userId, run.requestedByUserId)
  assert.equal(watch.agentKind, null)
  assert.equal(watch.systemComponent, 'deep-water.delivery')
  assert.ok(watch.agentId)
  assert.equal(watch.agentId, again.agentId)
  assert.deepEqual(watch.uoaIdentity, identity)

  const replay = deepWaterAgentOriginAttribution(run, { agentKind: 'shared', identity })
  assert.deepEqual(
    {
      runId: replay.runId,
      agentId: replay.agentId,
      agentKind: replay.agentKind,
      systemComponent: replay.systemComponent,
    },
    { runId: run.originRunId, agentId: run.originAgentId, agentKind: 'shared', systemComponent: undefined },
  )
})
