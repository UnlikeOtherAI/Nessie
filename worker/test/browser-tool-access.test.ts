import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_OBSERVE_TOOL_ID, BROWSER_OPEN_TOOL_ID } from '@nessie/runtime'

import {
  liveSession,
  observeWithinGrantedOrigin,
  recordBrowserDisclosure,
  requireGrantedObservationOrigin,
} from '../src/run/browser-cloud/browser-tool-access.js'
import { cloudBrowserTool } from '../src/run/browser-cloud/browser-tools.js'

const legacyTeamSession = {
  agentBrowser: { principalUserId: null, _count: { logins: 1 } },
  authenticated: true,
  browserbaseSessionId: 'browserbase-session',
  connectionId: 'connection',
  controlledByUserId: null,
  expiresAt: new Date(Date.now() + 60_000),
  id: 'session',
  status: 'active',
}

const accessFor = async (userId: string) =>
  liveSession({
    prisma: {
      cloudBrowserSession: { findFirst: async () => legacyTeamSession },
    },
  } as never, {
    agentId: 'agent',
    consumedSources: { add: () => undefined },
    run: { id: `run-${userId}`, threadId: 'thread' },
  } as never, BROWSER_OBSERVE_TOOL_ID)

test('a legacy team login refuses browser reads for both Alice and Bob', async () => {
  const [alice, bob] = await Promise.all([accessFor('alice'), accessFor('bob')])
  assert.equal(alice.ok, false)
  assert.equal(bob.ok, false)
  if (!alice.ok && !bob.ok) {
    assert.match(alice.result.output, /without a private owner/)
    assert.equal(alice.result.output, bob.result.output)
  }
})

test('a signed-in browser cannot omit the run disclosure sink', () => {
  assert.throws(
    () => recordBrowserDisclosure({ agentId: 'agent' } as never, 'person'),
    /requires the run disclosure source sink/,
  )
})

test('a deferred observation redirected outside a temporary grant emits no output', async () => {
  const cdp = {
    call: async () => ({
      currentIndex: 0,
      entries: [{ url: 'https://signin.example.test/complete' }],
    }),
  }
  let rendered = false
  await assert.rejects(async () => {
    const observation = await observeWithinGrantedOrigin(
      cdp as never,
      ['https://signin.example.test'],
      async () => ({ url: 'https://outside.example.test/redirected-while-capturing' }),
    )
    rendered = observation.url.length > 0
  }, /approved sites/)
  assert.equal(rendered, false)
})

test('the post-observation page check catches a redirect after the snapshot', async () => {
  const cdp = {
    call: async () => ({
      currentIndex: 0,
      entries: [{ url: 'https://outside.example.test/after-capture' }],
    }),
  }
  await assert.rejects(
    () => requireGrantedObservationOrigin(
      cdp as never,
      ['https://signin.example.test'],
      'https://signin.example.test/snapshot',
    ),
    /approved sites/,
  )
})

test('browser_open keeps an adopted temporary session instead of requesting another login', async () => {
  const result = await cloudBrowserTool(BROWSER_OPEN_TOOL_ID, {
    url: 'https://signin.example.test',
  }, {
    agentId: 'agent',
    channel: { organizationId: 'organization' },
    cloudBrowser: {
      prisma: {
        browserPersonalAccessGrant: {
          findFirst: async () => ({
            expiresAt: new Date(Date.now() + 60_000),
            id: 'grant',
            origins: ['https://signin.example.test'],
          }),
        },
      },
    },
    run: { id: 'successor', threadId: 'thread' },
  } as never)

  assert.deepEqual(result, {
    inputSummary: '{"url":"https://signin.example.test"}',
    output: 'A private browser session is already active for this task. Do not request another sign-in. '
      + 'Use browser_observe, then browser_act within its approved origins to continue.',
    success: true,
  })
})
