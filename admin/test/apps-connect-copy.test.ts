import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppSummaryRecord } from '@nessie/schemas'

import {
  catalogueStatesAuth,
  connectAuthExpectation,
  connectPublisherLine,
} from '../src/components/features/apps/app-connect-copy.js'

/**
 * What the connect dialog may claim before it has probed anything.
 *
 * The case behind every assertion here is real: the store's "Jira" is not
 * Atlassian. It is an MCP Registry entry published by `waystation` pointing at
 * `waystation.ai/jira/mcp`, and the dialog told a person that Jira needs no
 * sign-in — because `authMethod` defaults to `none` on ingestion and nobody
 * ever said otherwise.
 */

const app = (overrides: Partial<AppSummaryRecord> = {}): AppSummaryRecord => ({
  aliases: [],
  appSource: 'mcp_registry',
  authMethod: 'none',
  categories: ['development'],
  connectionCount: 0,
  displayName: 'Jira',
  distribution: 'remote',
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: 'app-1',
  installHref: '/install/app-1',
  locked: false,
  managedByIntegration: false,
  name: 'jira',
  primaryCategory: 'development',
  promptCount: null,
  resourceCount: null,
  shortDescription: '',
  slug: 'jira',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'community',
  vendor: 'waystation',
  ...overrides,
})

test('an ingested row never claims an auth method, because nobody set one', () => {
  // `authMethod` is the column default here: the MCP Registry does not describe
  // a server's auth, which is why 4,685 of 5,532 catalogue rows read `none` and
  // none reads `oauth2`.
  assert.equal(catalogueStatesAuth(app()), false)
  const sentence = connectAuthExpectation(app())
  assert.doesNotMatch(sentence, /needs no sign-in/)
  assert.match(sentence, /will ask waystation what sign-in it needs/)
})

test('a defaulted `none` is not evidence, even for a famous name', () => {
  // The regression in one line: this exact record rendered "This app needs no
  // sign-in" under the heading "Connect Jira".
  assert.doesNotMatch(connectAuthExpectation(app({ displayName: 'Jira' })), /no sign-in/)
})

test('an authored row does state its auth, because a human wrote it', () => {
  for (const [authMethod, expected] of [
    ['none', /needs no sign-in/],
    ['oauth2', /opens a Acme sign-in window/],
    ['api_key', /Acme needs an API key/],
  ] as const) {
    const authored = app({ appSource: 'nessie', authMethod, displayName: 'Acme' })
    assert.equal(catalogueStatesAuth(authored), true)
    assert.match(connectAuthExpectation(authored), expected)
  }
})

test('the dialog names the publisher, because the app name is the author’s claim', () => {
  // "Connect Jira" alone reads as Atlassian. The publisher is what says
  // otherwise, and it belongs on the screen where trust is granted.
  assert.equal(
    connectPublisherLine(app()),
    'Published by waystation · community-listed, not verified by Nessie',
  )
})

test('a non-community entry is named without the unverified qualifier', () => {
  assert.equal(
    connectPublisherLine(app({ trustLevel: 'verified', vendor: 'Atlassian' })),
    'Published by Atlassian',
  )
})

test('an entry naming no publisher renders no line rather than an empty one', () => {
  assert.equal(connectPublisherLine(app({ vendor: null })), null)
  // …and the expectation still reads, falling back to the app's own name.
  assert.match(connectAuthExpectation(app({ vendor: null })), /will ask Jira what sign-in/)
})
