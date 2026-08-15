import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerProfileAvatarRoutes } from '../src/routes/profile-avatar.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-00000000000a'
const otherUserId = '00000000-0000-4000-8000-00000000000b'
const uoaSub = 'uoa-subject-42'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// A public IP literal, not a hostname: the relay goes through safeFetch, which
// resolves the host before dialling, and a literal is validated without DNS.
const UOA_TEST_BASE_URL = 'https://93.184.216.34'

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    UOA_BASE_URL: UOA_TEST_BASE_URL,
    UOA_CLIENT_SECRET: 'test-client-secret',
    UOA_CONFIG_JWT_KID: 'test-kid',
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from('unused').toString('base64'),
    UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
    UOA_DOMAIN: 'nessie.test',
    UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
    UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
  })
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

// Only the acting user has a UOA subject; the other row models a local account.
const subjects = new Map<string, string | null>([
  [userId, uoaSub],
  [otherUserId, null],
])

const makePrisma = (lookups: string[]): PrismaClient =>
  ({
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        lookups.push(where.id)
        const subject = subjects.get(where.id)
        return subject === undefined ? null : { uoaSub: subject }
      },
    },
  }) as unknown as PrismaClient

const actorContextFor = (actorId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId, roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
  actionContext: { requestId: 'req-profile-avatar' },
})

const makeApp = async (actorContext: AuthorizedActionContext, lookups: string[] = []) => {
  const app = Fastify({ logger: false })
  await app.register(multipart)
  registerProfileAvatarRoutes(app, {
    prisma: makePrisma(lookups),
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerProfileAvatarRoutes>[1])
  return app
}

// Build a multipart body without pulling in a form-data dependency.
const multipartBody = (
  filename: string,
  contentType: string,
  bytes: Buffer,
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----nessietest'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; `
      + `filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

type StubCall = { url: string; method: string; authorization?: string }

test('PUT /api/auth/me/avatar/uoa relays the crop to the actor\'s own subject', async () => {
  await withUoaEnv(async () => {
    const lookups: string[] = []
    const app = await makeApp(actorContextFor(userId), lookups)
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    let relayedBody: string | null = null
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      relayedBody = await new Response(init?.body as BodyInit).text()
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const body = multipartBody('me.png', 'image/png', PNG_BYTES)
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/me/avatar/uoa',
        payload: body.payload,
        headers: body.headers,
      })

      assert.equal(response.statusCode, 200)
      assert.equal(response.json().data.ok, true)
      assert.equal(calls[0]?.method, 'PUT')
      assert.equal(
        calls[0]?.url,
        `${UOA_TEST_BASE_URL}/domain/users/${uoaSub}/avatar?domain=nessie.test`,
      )
      assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
      assert.match(relayedBody ?? '', /name="file"/)
      // The subject came from the acting user's own row, never the request.
      assert.deepEqual(lookups, [userId])
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('DELETE /api/auth/me/avatar/uoa clears the photo at UOA', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(userId))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify({ ok: true }))
    }) as unknown as typeof fetch

    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/auth/me/avatar/uoa' })

      assert.equal(response.statusCode, 200)
      assert.equal(calls[0]?.method, 'DELETE')
      assert.equal(
        calls[0]?.url,
        `${UOA_TEST_BASE_URL}/domain/users/${uoaSub}/avatar?domain=nessie.test`,
      )
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('a member with no UOA subject cannot reach the full-trust relay', async () => {
  await withUoaEnv(async () => {
    // The route never takes a subject from the request, so the only way to
    // write someone else's picture would be a foreign subject on the row it
    // reads — which is the acting user's own by construction.
    const app = await makeApp(actorContextFor(otherUserId))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an unlinked account must never reach the domain-hash relay')
    }) as unknown as typeof fetch

    const body = multipartBody('me.png', 'image/png', PNG_BYTES)
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/auth/me/avatar/uoa',
        payload: body.payload,
        headers: body.headers,
      })
      assert.equal(put.statusCode, 404)
      assert.equal(put.json().error.code, 'UOA_PROFILE_NOT_LINKED')

      const removed = await app.inject({ method: 'DELETE', url: '/api/auth/me/avatar/uoa' })
      assert.equal(removed.statusCode, 404)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('PUT /api/auth/me/avatar/uoa rejects a non-raster upload before relaying', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(userId))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an unsupported type must not reach UOA')
    }) as unknown as typeof fetch

    const body = multipartBody('me.svg', 'image/svg+xml', Buffer.from('<svg/>'))
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/me/avatar/uoa',
        payload: body.payload,
        headers: body.headers,
      })

      assert.equal(response.statusCode, 415)
      assert.equal(response.json().error.code, 'UNSUPPORTED_IMAGE_TYPE')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('PUT /api/auth/me/avatar/uoa rejects an image over the 1 MiB ceiling', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(userId))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an oversize image must not reach UOA')
    }) as unknown as typeof fetch

    const body = multipartBody('huge.png', 'image/png', Buffer.alloc(1024 * 1024 + 512, 1))
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/me/avatar/uoa',
        payload: body.payload,
        headers: body.headers,
      })

      assert.equal(response.statusCode, 413)
      assert.equal(response.json().error.code, 'FILE_TOO_LARGE')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('a UOA refusal surfaces as a 400 and an outage as a 502', async () => {
  await withUoaEnv(async () => {
    for (const [status, expected, code] of [
      [400, 400, 'PROFILE_AVATAR_REJECTED'],
      [503, 502, 'UOA_AVATAR_UNAVAILABLE'],
    ] as const) {
      const app = await makeApp(actorContextFor(userId))
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () =>
        new Response('{"error":{"code":"INVALID"}}', { status })) as unknown as typeof fetch

      const body = multipartBody('me.png', 'image/png', PNG_BYTES)
      try {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/auth/me/avatar/uoa',
          payload: body.payload,
          headers: body.headers,
        })

        assert.equal(response.statusCode, expected)
        assert.equal(response.json().error.code, code)
      } finally {
        globalThis.fetch = originalFetch
        await app.close()
      }
    }
  })
})

test('the relay is inert when the deployment has no UOA', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  const app = await makeApp(actorContextFor(userId))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    assert.fail('an unconfigured deployment must not call UOA')
  }) as unknown as typeof fetch

  try {
    const removed = await app.inject({ method: 'DELETE', url: '/api/auth/me/avatar/uoa' })
    assert.equal(removed.statusCode, 404)
    assert.equal(removed.json().error.code, 'UOA_PROFILE_NOT_LINKED')
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
    await app.close()
  }
})
