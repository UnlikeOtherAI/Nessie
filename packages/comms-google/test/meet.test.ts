import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGoogleMeetSpace,
  GoogleMeetApiError,
} from '../src/meet.js'

test('creates an OPEN Meet space through safeFetch', async () => {
  let requestBody: string | undefined
  let authorization: string | null = null
  const meetingUri = await createGoogleMeetSpace('user-access-token', {
    resolveHost: async () => ['8.8.8.8'],
    fetchImpl: async (url, init) => {
      assert.equal(url.toString(), 'https://meet.googleapis.com/v2/spaces')
      assert.equal(init.method, 'POST')
      const headers = new Headers(init.headers)
      authorization = headers.get('authorization')
      requestBody = init.body as string
      return new Response(JSON.stringify({
        meetingUri: 'https://meet.google.com/abc-defg-hij',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.equal(authorization, 'Bearer user-access-token')
  assert.deepEqual(JSON.parse(requestBody ?? ''), {
    config: { accessType: 'OPEN' },
  })
  assert.equal(meetingUri, 'https://meet.google.com/abc-defg-hij')
})

test('provider failures expose status without copying the response body', async () => {
  await assert.rejects(
    createGoogleMeetSpace('user-access-token', {
      resolveHost: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(
        JSON.stringify({ access_token: 'must-not-escape' }),
        { status: 401 },
      ),
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleMeetApiError)
      assert.equal(error.status, 401)
      assert.equal(error.message.includes('must-not-escape'), false)
      return true
    },
  )
})
