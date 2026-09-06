import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { DEFAULT_BROWSER_VIEWPORT } from '@nessie/schemas'

import { createBrowserbaseClient } from '../src/browserbase-client.js'
import {
  openCloudBrowserSession,
  type CloudBrowserDeps,
  type OpenSessionInput,
} from '../src/session-lifecycle.js'

/**
 * The window a session opens at is decided once, at session creation, and
 * never again — Browserbase fixes it for the session's life. So the thing
 * worth testing is not the size arithmetic (`browserViewportOrDefault` owns
 * that, and is tested where it lives) but the wiring: that the number stored
 * on an agent's browser is the number on the create request's wire body, and
 * that a browser nobody has sized still opens at a laptop window rather than
 * at whatever the platform would have picked.
 */

/** Captures every request body the client sends, and answers like Browserbase. */
const collectingFetch = (bodies: Array<Record<string, unknown>>) =>
  (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
    return new Response(
      JSON.stringify({ id: 'sess-1', connectUrl: 'wss://connect.browserbase.com/x' }),
      { status: 200 },
    )
  }) as never

const browserSettingsOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.browserSettings as Record<string, unknown>

test('a viewport becomes browserSettings.viewport; without one the key is absent', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = createBrowserbaseClient(
    { apiKey: 'bb-key' },
    { fetchImpl: collectingFetch(bodies) },
  )

  await client.createSession({ timeoutSeconds: 60, viewport: { height: 1024, width: 768 } })
  assert.deepEqual(browserSettingsOf(bodies[0]).viewport, { height: 1024, width: 768 })

  // Absent, not null and not an empty object: Browserbase reads a malformed
  // viewport as a request it must refuse, and the failure would look like a
  // bad key rather than a bad body — the same trap `projectId` fell into.
  bodies.length = 0
  await client.createSession({ timeoutSeconds: 60 })
  assert.ok(
    !Object.hasOwn(browserSettingsOf(bodies[0]), 'viewport'),
    `viewport must be absent, got ${JSON.stringify(browserSettingsOf(bodies[0]).viewport)}`,
  )
})

const CONNECTION = {
  id: 'conn-1',
  scope: 'organization',
  projectId: null,
  apiKeyRef: 'ref-1',
  userId: null,
}

/**
 * The parts of Prisma one `openCloudBrowserSession` touches, and nothing else.
 * A missing delegate here surfaces as a TypeError inside the call rather than
 * as a compile error, so every method both paths reach is present: the
 * connection lookup a durable browser dictates, the cascade a throwaway
 * resolves through, the claim transaction, and the two writes after the remote
 * create returns.
 */
const fakePrisma = (): PrismaClient => {
  const tx = {
    $executeRaw: async () => 0,
    agentBrowser: { count: async () => 1 },
    cloudBrowserSession: {
      count: async () => 0,
      create: async () => ({ id: 'session-row-1' }),
    },
  }
  return {
    $transaction: async (fn: (client: typeof tx) => Promise<string>) => fn(tx),
    agentBrowser: { update: async () => ({}) },
    cloudBrowserConnection: {
      findFirst: async () => CONNECTION,
      findMany: async () => [CONNECTION],
    },
    cloudBrowserSession: { updateMany: async () => ({ count: 1 }) },
    scopedSetting: { findMany: async () => [] },
  } as unknown as PrismaClient
}

const openWith = async (
  bodies: Array<Record<string, unknown>>,
  agentBrowser?: NonNullable<OpenSessionInput['agentBrowser']>,
  runId: string | null = 'run-1',
): Promise<void> => {
  const deps: CloudBrowserDeps = {
    prisma: fakePrisma(),
    resolveSecret: async () => 'bb-key',
    clientFactory: (credentials) =>
      createBrowserbaseClient(credentials, { fetchImpl: collectingFetch(bodies) }),
  }
  await openCloudBrowserSession(deps, {
    organizationId: 'org-1',
    runId,
    threadId: 'thread-1',
    agentId: 'agent-1',
    encryptionSecret: 'test-secret',
    originGate: { authenticatedOrigins: [], touchedAuthenticated: false, currentUrl: null },
    teamId: null,
    requestedByUserId: 'user-1',
    ...(agentBrowser ? { agentBrowser } : {}),
  })
}

test('a session for an agent browser opens at that browser’s stored window', async () => {
  const bodies: Array<Record<string, unknown>> = []
  await openWith(bodies, {
    id: 'browser-1',
    connectionId: 'conn-1',
    browserbaseContextId: 'ctx-1',
    hasLogins: false,
    viewport: { height: 1050, width: 1680 },
  })
  assert.equal(bodies.length, 1)
  const settings = browserSettingsOf(bodies[0])
  assert.deepEqual(settings.viewport, { height: 1050, width: 1680 })
  // The context still rides along: a size must not have displaced the thing
  // that makes yesterday's login still be there.
  assert.deepEqual(settings.context, { id: 'ctx-1', persist: true })
})

test('a throwaway session opens at the same laptop window a fresh browser gets', async () => {
  const bodies: Array<Record<string, unknown>> = []
  await openWith(bodies)
  assert.equal(bodies.length, 1)
  assert.deepEqual(browserSettingsOf(bodies[0]).viewport, { ...DEFAULT_BROWSER_VIEWPORT })
})


/**
 * Measured against the real service on 2026-09-06: a resumed session ended two
 * seconds after it started, at exactly the moment the restore closed its CDP
 * socket. Browserbase stops a session when its last connection drops, so the
 * panel then polled a session that was already gone and showed "the browser is
 * starting up" forever — and it only ever *appeared* to work when the live
 * view's iframe won the race to reconnect.
 *
 * A run is safe without this because the worker holds the socket from open to
 * close, and asking for it there would keep a stray browser billing after a
 * crash; the difference between the two lifetimes is the whole point.
 */
test('a session a person opened is kept alive; a run’s session is not', async () => {
  const personBodies: Array<Record<string, unknown>> = []
  await openWith(personBodies, undefined, null)
  assert.equal(personBodies[0].keepAlive, true)

  const runBodies: Array<Record<string, unknown>> = []
  await openWith(runBodies, undefined, 'run-1')
  assert.ok(
    !Object.hasOwn(runBodies[0], 'keepAlive'),
    `a run's session must not ask to outlive its worker, got ${JSON.stringify(runBodies[0].keepAlive)}`,
  )
})
