import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { CdpClient } from '@nessie/browser-cloud'
import { BROWSER_ACT_TOOL_ID, sealSecret } from '@nessie/runtime'

import { buildBrowserActApprovalHook } from '../src/run/browser-cloud/act-approval-gate.js'
import { serialiseOriginGate } from '../src/run/browser-cloud/origin-gate.js'
import {
  __testing,
  acquireCdp,
  originGateFor,
  saveOriginGate,
} from '../src/run/browser-cloud/session-pool.js'
import type { RunContext } from '../src/run/execute/types.js'

/**
 * A run that suspends for the cross-origin write approval is re-enqueued and
 * claimed by whichever worker is free. That worker opened nothing, so before
 * audit 8.1 was fixed it held no connect URL — the browser was undrivable and
 * billed to its TTL — and no origin gate, and the approval hook read the
 * missing gate as "nothing to gate" and let the write through unasked.
 *
 * These exercise that second worker: an empty pool, and only the session row.
 * The row's own round trip is proven against Postgres in
 * `packages/browser-cloud/test/session-lifecycle-postgres.test.ts`.
 */

const AUTH_SECRET = 'test-auth-secret-for-browser-reattach'
// The pool seals and unseals with the deployment auth secret, read through
// `loadConfig()` at call time.
process.env.NESSIE_AUTH_SECRET = AUTH_SECRET

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const CONNECT_URL = 'wss://connect.browserbase.com/session-under-test'

type Row = {
  status: string
  connectCapabilityCiphertext: string | null
  originGate: unknown
  expiresAt: Date
}

const activeRow = (over: Partial<Row> = {}): Row => ({
  status: 'active',
  connectCapabilityCiphertext: sealSecret(AUTH_SECRET, CONNECT_URL),
  originGate: serialiseOriginGate({
    authenticatedOrigins: new Set(['https://mail.example.com']),
    touchedAuthenticated: true,
    currentUrl: 'https://mail.example.com/inbox',
  }),
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
})

/**
 * Only the two shapes the session row is read in: by id for the capability,
 * and by run for the live session. Written out rather than cast from a loose
 * stub so a query that stops matching fails here instead of quietly answering
 * a different question.
 */
const fakePrisma = (row: Row | null) => {
  const writes: unknown[] = []
  const delegate = {
    findFirst: async (args: { where: { id?: string; runId?: string } }) => {
      if (args.where.id !== undefined) {
        if (args.where.id !== SESSION_ID) return null
        return row && row.status === 'active' ? row : null
      }
      if (args.where.runId !== RUN_ID || !row) return null
      return {
        id: SESSION_ID,
        browserbaseSessionId: 'bb-1',
        connectionId: 'conn-1',
        status: row.status,
        expiresAt: row.expiresAt,
        controlledByUserId: null,
        authenticated: true,
      }
    },
    updateMany: async (args: unknown) => {
      writes.push(args)
      return { count: 1 }
    },
  }
  return {
    prisma: { cloudBrowserSession: delegate } as unknown as PrismaClient,
    writes,
  }
}

const fakeCdp = (): CdpClient => ({
  call: async () => ({}),
  pageSessionId: () => 'page-1',
  attachToPage: async () => 'page-1',
  targets: async () => [],
  close: () => undefined,
  closed: new Promise<void>(() => undefined),
})

test('a worker that never opened the session re-attaches from the row', async () => {
  __testing.pool.clear()
  const { prisma } = fakePrisma(activeRow())
  const dialled: string[] = []

  const cdp = await acquireCdp(
    {
      prisma,
      connect: async (connectUrl) => {
        dialled.push(connectUrl)
        return fakeCdp()
      },
    },
    SESSION_ID,
  )

  assert.ok(cdp, 'the pool must reconnect from the persisted capability')
  assert.deepEqual(dialled, [CONNECT_URL], 'it drives the browser the first worker opened')

  // And it gates on what that worker learned from the browser's cookies,
  // rather than on an empty gate that permits every write.
  const gate = await originGateFor({ prisma }, SESSION_ID)
  assert.equal(gate?.touchedAuthenticated, true)
  assert.equal(gate?.authenticatedOrigins.has('https://mail.example.com'), true)
  assert.equal(gate?.currentUrl, 'https://mail.example.com/inbox')
})

test('a released session is drivable by nobody, and dials nothing', async () => {
  __testing.pool.clear()
  const { prisma } = fakePrisma(activeRow({ status: 'released' }))
  const dialled: string[] = []

  const cdp = await acquireCdp(
    {
      prisma,
      connect: async (connectUrl) => {
        dialled.push(connectUrl)
        return fakeCdp()
      },
    },
    SESSION_ID,
  )

  assert.equal(cdp, null)
  assert.deepEqual(dialled, [])
})

test('a gate change is mirrored to the row, and an unchanged one costs no write', async () => {
  __testing.pool.clear()
  const { prisma, writes } = fakePrisma(activeRow())
  await acquireCdp({ prisma, connect: async () => fakeCdp() }, SESSION_ID)
  const gate = await originGateFor({ prisma }, SESSION_ID)
  if (!gate) assert.fail('the pool must rebuild the gate from the row')

  await saveOriginGate({ prisma }, SESSION_ID, gate)
  assert.equal(writes.length, 0, 'a gate that did not change is not re-written')

  gate.currentUrl = 'https://vendor.example.org/form'
  await saveOriginGate({ prisma }, SESSION_ID, gate)
  assert.equal(writes.length, 1, 'the next worker must see where this one went')
})

test('the act gate escalates when no gate can be read, instead of passing', async () => {
  __testing.pool.clear()
  // A live session whose capability this deployment cannot open: a rotated
  // auth secret, or a row released between the tool call and this check.
  const { prisma } = fakePrisma(activeRow({ connectCapabilityCiphertext: null }))
  const hook = buildBrowserActApprovalHook(prisma, {
    run: { id: RUN_ID, principalUserId: USER_ID },
  } as unknown as RunContext)

  const verdict = (await hook({
    toolName: BROWSER_ACT_TOOL_ID,
    args: { action: 'type', nodeId: 4, text: 'the invoice number' },
  })) as { escalate: boolean; requiredApproverUserId?: string | null } | null

  assert.equal(verdict?.escalate, true, 'an unreadable gate must ask a person, not wave it through')
  assert.equal(verdict?.requiredApproverUserId, USER_ID)
})
