import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerUserRoutes } from '../src/routes/users.js'
import {
  fetchUoaUserAvatar,
  resolveUoaAvatarSubject,
  UoaAvatarUnavailableError,
} from '../src/services/uoa-avatar.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
const actorUserId = '00000000-0000-4000-8000-00000000000a'
const linkedUserId = '00000000-0000-4000-8000-00000000000b'
const unlinkedUserId = '00000000-0000-4000-8000-00000000000c'
const otherOrgUserId = '00000000-0000-4000-8000-00000000000d'
const linkedUoaSub = 'uoa-sub-linked'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The service is only exercised through injected settings, so tests never need
// real UOA credentials — but the route path does read process.env through
// isUoaConfigured(). Set the minimum the loader requires.
//
// The base URL is a public IP literal rather than a hostname because the relay
// now goes through safeFetch, which resolves the host before dialling. A
// literal is validated without DNS, so the route tests below (which have no
// dependency seam of their own and stub globalThis.fetch) reach the stub
// instead of dying on a lookup for a name that does not exist.
const UOA_TEST_BASE_URL = 'https://93.184.216.34'

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    UOA_BASE_URL: UOA_TEST_BASE_URL,
    UOA_CLIENT_SECRET: 'test-client-secret',
    UOA_CONFIG_JWT_KID: 'test-kid',
    // Any base64 blob: clientHash() only hashes domain + secret, and no test
    // path signs a JWT.
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

type LinkRow = {
  organizationId: string
  productSlug: string
  status: string
  uoaSub: string | null
  userId: string
}

const links: LinkRow[] = [
  {
    organizationId,
    productSlug: 'nessie',
    status: 'linked',
    uoaSub: linkedUoaSub,
    userId: linkedUserId,
  },
  {
    organizationId: otherOrganizationId,
    productSlug: 'nessie',
    status: 'linked',
    uoaSub: 'uoa-sub-other-org',
    userId: otherOrgUserId,
  },
]

const makePrisma = (): PrismaClient =>
  ({
    productAccountLink: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId_productSlug: {
            organizationId: string
            productSlug: string
            userId: string
          }
        }
      }) => {
        const key = where.organizationId_userId_productSlug
        return (
          links.find(
            (link) =>
              link.organizationId === key.organizationId &&
              link.productSlug === key.productSlug &&
              link.userId === key.userId,
          ) ?? null
        )
      },
    },
  }) as unknown as PrismaClient

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: actorUserId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-uoa-avatar' },
}

const makeApp = () => {
  const app = Fastify({ logger: false })
  registerUserRoutes(app, {
    MEMBERSHIP_ROLES: ['owner', 'admin', 'member', 'viewer'],
    prisma: makePrisma(),
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    resolveMembershipRole: (role: string) => role,
  } as unknown as Parameters<typeof registerUserRoutes>[1])
  return app
}

test('resolveUoaAvatarSubject returns the subject only for a linked user in the caller org', async () => {
  const prisma = makePrisma()

  assert.equal(
    await resolveUoaAvatarSubject(prisma, { organizationId, userId: linkedUserId }),
    linkedUoaSub,
  )
  assert.equal(
    await resolveUoaAvatarSubject(prisma, { organizationId, userId: unlinkedUserId }),
    null,
  )
  // The link exists, but in a different organization — a caller in this org
  // must not be able to resolve it.
  assert.equal(
    await resolveUoaAvatarSubject(prisma, { organizationId, userId: otherOrgUserId }),
    null,
  )
})

test('fetchUoaUserAvatar calls the domain-hash avatar endpoint and returns the bytes', async () => {
  await withUoaEnv(async () => {
    const calls: { url: string; authorization: string | undefined }[] = []
    const image = await fetchUoaUserAvatar(linkedUoaSub, {
      fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        })
        return new Response(PNG_BYTES, {
          headers: {
            'content-type': 'image/png',
            'x-uoa-avatar-source': 'uploaded',
          },
        })
      }) as unknown as typeof fetch,
    })

    assert.equal(calls.length, 1)
    assert.equal(
      calls[0]?.url,
      `${UOA_TEST_BASE_URL}/domain/users/${linkedUoaSub}/avatar?domain=nessie.test`,
    )
    assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
    assert.equal(image?.contentType, 'image/png')
    assert.equal(image?.source, 'uploaded')
    assert.deepEqual(image?.body, PNG_BYTES)
  })
})

test('fetchUoaUserAvatar maps an unknown subject to null and a bad upstream to an error', async () => {
  await withUoaEnv(async () => {
    const respondWith = (response: Response) =>
      fetchUoaUserAvatar(linkedUoaSub, {
        fetchImpl: (async () => response) as unknown as typeof fetch,
      })

    assert.equal(await respondWith(new Response('{}', { status: 404 })), null)

    await assert.rejects(
      respondWith(new Response('nope', { status: 500 })),
      UoaAvatarUnavailableError,
    )

    // A non-image response must never be relayed to the browser.
    await assert.rejects(
      respondWith(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      ),
      UoaAvatarUnavailableError,
    )

    await assert.rejects(
      fetchUoaUserAvatar(linkedUoaSub, {
        fetchImpl: (async () => {
          throw new Error('socket hang up')
        }) as unknown as typeof fetch,
      }),
      UoaAvatarUnavailableError,
    )
  })
})

test('fetchUoaUserAvatar is a no-op when UOA is not configured', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  try {
    const image = await fetchUoaUserAvatar(linkedUoaSub, {
      fetchImpl: (async () => {
        assert.fail('unconfigured deployments must not call UOA')
      }) as unknown as typeof fetch,
    })
    assert.equal(image, null)
  } finally {
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
  }
})

test('GET /api/users/:userId/avatar relays the image for a linked user', async () => {
  await withUoaEnv(async () => {
    const app = makeApp()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, {
        headers: { 'content-type': 'image/png', 'x-uoa-avatar-source': 'provider' },
      })) as unknown as typeof fetch

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${linkedUserId}/avatar`,
      })

      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['content-type'], 'image/png')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
      assert.equal(response.headers['content-security-policy'], "default-src 'none'")
      assert.equal(response.headers['x-uoa-avatar-source'], 'provider')
      assert.deepEqual(response.rawPayload, PNG_BYTES)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('GET /api/users/:userId/avatar 404s an unlinked user without calling UOA', async () => {
  await withUoaEnv(async () => {
    const app = makeApp()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an unlinked user must not reach UOA')
    }) as unknown as typeof fetch

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${unlinkedUserId}/avatar`,
      })

      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'AVATAR_NOT_FOUND')
      // The miss is cacheable so unlinked members are not re-asked on every mount.
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('GET /api/users/:userId/avatar 404s a user linked in another organization', async () => {
  await withUoaEnv(async () => {
    const app = makeApp()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('a cross-organization user must not reach UOA')
    }) as unknown as typeof fetch

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${otherOrgUserId}/avatar`,
      })

      assert.equal(response.statusCode, 404)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('GET /api/users/:userId/avatar reports an upstream failure as 502', async () => {
  await withUoaEnv(async () => {
    const app = makeApp()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('boom', { status: 503 })) as unknown as typeof fetch

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${linkedUserId}/avatar`,
      })

      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_AVATAR_UNAVAILABLE')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})
