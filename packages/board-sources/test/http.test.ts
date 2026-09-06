import assert from 'node:assert/strict'
import test from 'node:test'

import { sourceFetch } from '../src/http.js'

// The allowlist is checked before anything is resolved or dialled, so a
// misconfigured adapter cannot reach a host it never declared — and neither can
// a container value that smuggled one in.
test('a host the adapter did not declare is refused before any request', async () => {
  await assert.rejects(
    sourceFetch({ url: 'https://evil.test/x', allowedHosts: ['api.linear.app'] }),
    /is not an allowed host/,
  )
})

test('the allowlist is exact, not a suffix match', async () => {
  await assert.rejects(
    sourceFetch({
      url: 'https://api.linear.app.evil.test/x',
      allowedHosts: ['api.linear.app'],
    }),
    /is not an allowed host/,
  )
})
