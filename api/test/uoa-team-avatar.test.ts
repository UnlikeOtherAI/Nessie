import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerTeamAvatarRoutes } from '../src/routes/team-avatar.js'
import { resolveUoaTeam } from '../src/services/uoa-avatar.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const localTeamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-00000000000a'
const externalTeamId = 'uoa-team-42'
const externalOrgId = 'uoa-org-7'
const otherTeamId = '00000000-0000-4000-8000-000000000005'
const otherExternalTeamId = 'uoa-team-99'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// A public IP literal, not a hostname: the relay goes through safeFetch, which
// resolves the host before dialling, and a literal is validated without DNS —
// so these route tests (which stub globalThis.fetch) reach the stub instead of
// failing a lookup for a name that does not exist.
const UOA_TEST_BASE_URL = 'https://93.184.216.34'

// A real key: the `/org/*` relay signs a subject assertion with it, so a
// placeholder would fail before any request was made.
const uoaPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

// The UOA session the signed-in person holds, for the team they are in.
const uoaIdentity = {
  organizationId: externalOrgId,
  subject: 'usr_ondra',
  teamId: externalTeamId,
  tokenVersion: 3,
}

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    UOA_BASE_URL: UOA_TEST_BASE_URL,
    UOA_CLIENT_SECRET: 'test-client-secret',
    UOA_CONFIG_JWT_KID: 'test-kid',
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
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

type TeamRow = {
  id: string
  organizationId: string
  externalOrgId: string | null
  externalTeamId: string | null
  name: string
}

const teams: TeamRow[] = [
  {
    id: teamId,
    organizationId,
    externalOrgId,
    externalTeamId: externalTeamId,
    name: 'Design',
  },
  // Another team in the same organisation, which the picker may read but
  // the session is not standing in.
  {
    id: otherTeamId,
    organizationId,
    externalOrgId,
    externalTeamId: otherExternalTeamId,
    name: 'Support',
  },
  // Bound to no UOA team — a purely local team.
  {
    id: localTeamId,
    organizationId,
    externalOrgId: null,
    externalTeamId: null,
    name: 'Local only',
  },
]

const makePrisma = (): PrismaClient =>
  ({
    team: {
      // Two shapes reach this: the current-team routes scope by the
      // actor's organisation, the picker route by the signed-in user's
      // membership. Honour both `where`s — a fake that ignored one would widen
      // the result set past what production returns.
      findFirst: async ({
        where,
      }: {
        where: {
          id: string
          project?: { organizationId: string }
          members?: { some: { userId: string } }
        }
      }) => {
        const team = teams.find(
          (candidate) =>
            candidate.id === where.id &&
            (where.project
              ? candidate.organizationId === where.project.organizationId
              : true) &&
            (where.members ? where.members.some.userId === userId : true),
        )
        return team
          ? {
            externalOrgId: team.externalOrgId,
            externalTeamId: team.externalTeamId,
            name: team.name,
          }
          : null
      },
    },
  }) as unknown as PrismaClient

const actorContextFor = (
  roles: string[],
  overrides: { teamId?: string; uoa?: boolean } = {},
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: {
    organizationId,
    projectId,
    teamId: overrides.teamId ?? teamId,
  },
  actionContext: {
    requestId: 'req-team-avatar',
    // Absent by default: a session with no assertable UOA identity is exactly
    // the case that still has to take the `/domain/*` relay.
    ...(overrides.uoa ? { uoaIdentity } : {}),
  },
} as unknown as AuthorizedActionContext)

const makeApp = async (actorContext: AuthorizedActionContext) => {
  const app = Fastify({ logger: false })
  await app.register(multipart)
  registerTeamAvatarRoutes(app, {
    prisma: makePrisma(),
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerTeamAvatarRoutes>[1])
  return app
}

// Build a multipart body without pulling in a form-data dependency.
const multipartBody = (
  fieldname: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----nessietest'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; ` +
      `filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

type StubCall = {
  url: string
  method: string
  authorization?: string
  subjectAssertion?: string
}

const stubFetch = (
  calls: StubCall[],
  respond: (call: StubCall) => Response,
): typeof fetch =>
  (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: StubCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      subjectAssertion: headers.get('x-uoa-subject-assertion') ?? undefined,
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch

test('resolveUoaTeam maps the session team to its UOA team', async () => {
  const prisma = makePrisma()

  assert.deepEqual(
    await resolveUoaTeam(prisma, { organizationId, teamId }),
    { externalOrgId, externalTeamId, name: 'Design' },
  )
  // A team with no UOA binding, no team in context, and a team in another
  // organization all resolve to nothing.
  assert.equal(
    await resolveUoaTeam(prisma, { organizationId, teamId: localTeamId }),
    null,
  )
  assert.equal(await resolveUoaTeam(prisma, { organizationId, teamId: null }), null)
  assert.equal(
    await resolveUoaTeam(prisma, {
      organizationId: otherOrganizationId,
      teamId,
    }),
    null,
  )
})

test('GET /api/team/avatar relays the company image for any member', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['member']))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch(
      calls,
      () =>
        new Response(PNG_BYTES, {
          headers: { 'content-type': 'image/png', 'x-uoa-avatar-source': 'uploaded' },
        }),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/avatar' })

      assert.equal(response.statusCode, 200)
      assert.equal(
        calls[0]?.url,
        `${UOA_TEST_BASE_URL}/domain/teams/${externalTeamId}/avatar?domain=nessie.test`,
      )
      assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
      assert.equal(response.headers['content-type'], 'image/png')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.equal(response.headers['content-security-policy'], "default-src 'none'")
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
      assert.deepEqual(response.rawPayload, PNG_BYTES)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('GET /api/team/avatar 404s a team with no UOA team', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['owner'], { teamId: localTeamId }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('a team with no UOA binding must not reach UOA')
    }) as unknown as typeof fetch

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/avatar' })

      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'AVATAR_NOT_FOUND')
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('PUT /api/team/avatar relays an owner or admin upload as multipart', async () => {
  for (const role of ['owner', 'admin']) {
    await withUoaEnv(async () => {
      const app = await makeApp(actorContextFor([role]))
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
        return new Response(
          JSON.stringify({ ok: true, avatar: { source: 'uploaded' } }),
          { headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const body = multipartBody('file', 'logo.png', 'image/png', PNG_BYTES)
      try {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/team/avatar',
          payload: body.payload,
          headers: body.headers,
        })

        assert.equal(response.statusCode, 200, `role ${role}`)
        assert.equal(response.json().data.ok, true)
        assert.equal(calls[0]?.method, 'PUT')
        assert.equal(
          calls[0]?.url,
          `${UOA_TEST_BASE_URL}/domain/teams/${externalTeamId}/avatar?domain=nessie.test`,
        )
        // UOA wants exactly one part named "file".
        assert.match(relayedBody ?? '', /name="file"/)
      } finally {
        globalThis.fetch = originalFetch
        await app.close()
      }
    })
  }
})

test('PUT and DELETE /api/team/avatar reject non-admin members', async () => {
  for (const role of ['member', 'viewer']) {
    await withUoaEnv(async () => {
      const app = await makeApp(actorContextFor([role]))
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        assert.fail(`a ${role} must never reach the full-trust domain-hash relay`)
      }) as unknown as typeof fetch

      const body = multipartBody('file', 'logo.png', 'image/png', PNG_BYTES)
      try {
        const put = await app.inject({
          method: 'PUT',
          url: '/api/team/avatar',
          payload: body.payload,
          headers: body.headers,
        })
        assert.equal(put.statusCode, 403, `role ${role}`)
        assert.equal(put.json().error.code, 'FORBIDDEN')

        const removed = await app.inject({
          method: 'DELETE',
          url: '/api/team/avatar',
        })
        assert.equal(removed.statusCode, 403, `role ${role}`)
      } finally {
        globalThis.fetch = originalFetch
        await app.close()
      }
    })
  }
})

test('PUT /api/team/avatar rejects a non-raster upload before relaying', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['owner']))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an unsupported type must not reach UOA')
    }) as unknown as typeof fetch

    const body = multipartBody(
      'file',
      'logo.svg',
      'image/svg+xml',
      Buffer.from('<svg/>'),
    )
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/team/avatar',
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

test('PUT /api/team/avatar rejects an image over the 1 MiB ceiling', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['owner']))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      assert.fail('an oversize image must not reach UOA')
    }) as unknown as typeof fetch

    const body = multipartBody(
      'file',
      'huge.png',
      'image/png',
      Buffer.alloc(1024 * 1024 + 512, 1),
    )
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/team/avatar',
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

test('PUT /api/team/avatar surfaces a UOA rejection as a 400', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['owner']))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{"error":{"code":"INVALID"}}', {
        status: 400,
      })) as unknown as typeof fetch

    const body = multipartBody('file', 'logo.png', 'image/png', PNG_BYTES)
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/team/avatar',
        payload: body.payload,
        headers: body.headers,
      })

      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error.code, 'TEAM_AVATAR_REJECTED')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('DELETE /api/team/avatar clears the image for an owner', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['owner']))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch(
      calls,
      () => new Response(JSON.stringify({ ok: true })),
    )

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/team/avatar',
      })

      assert.equal(response.statusCode, 200)
      assert.equal(response.json().data.ok, true)
      assert.equal(calls[0]?.method, 'DELETE')
      assert.equal(
        calls[0]?.url,
        `${UOA_TEST_BASE_URL}/domain/teams/${externalTeamId}/avatar?domain=nessie.test`,
      )
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('GET /api/team/avatar reports an upstream failure as 502', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['member']))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('boom', { status: 503 })) as unknown as typeof fetch

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/avatar' })

      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_AVATAR_UNAVAILABLE')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('team avatar routes are inert when UOA is not configured', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  const app = await makeApp(actorContextFor(['owner']))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    assert.fail('an unconfigured deployment must not call UOA')
  }) as unknown as typeof fetch

  try {
    const read = await app.inject({ method: 'GET', url: '/api/team/avatar' })
    assert.equal(read.statusCode, 404)

    const removed = await app.inject({ method: 'DELETE', url: '/api/team/avatar' })
    assert.equal(removed.statusCode, 404)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
    await app.close()
  }
})

/**
 * The `/org/*` relay is the whole reason a team picture can be overridden
 * at all for a tenant whose UOA organisation was founded somewhere other than
 * Nessie's own domain: `/domain/teams/:teamId/avatar` scopes to organisations
 * *created on* the calling domain and answers the generic 404 for every other
 * one — GET included, which is what drew initials in settings while the rail
 * showed the team's real SSO icon from UOA's public image. `/org/*` is
 * scoped by the acting person instead, so the assertion is the fix, not a
 * decoration.
 */
const ORG_AVATAR_PATH =
  `/org/organisations/${externalOrgId}/teams/${externalTeamId}/avatar`

test('a UOA session relays the team avatar as the signed-in person', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['member'], { uoa: true }))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch(
      calls,
      () => new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/avatar' })

      assert.equal(response.statusCode, 200)
      const url = new URL(calls[0]?.url ?? '')
      assert.equal(url.pathname, ORG_AVATAR_PATH)
      // `/org/*` runs the config verifier, so the signed config must be named.
      assert.equal(url.searchParams.get('config_url'), 'https://nessie.test/uoa/config.jwt')
      assert.ok(calls[0]?.subjectAssertion, 'the person is asserted, not the tenant')
      assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('a UOA session uploads and clears through the org-scoped route', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(actorContextFor(['admin'], { uoa: true }))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch(calls, () => new Response(JSON.stringify({ ok: true })))

    const body = multipartBody('file', 'logo.png', 'image/png', PNG_BYTES)
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/team/avatar',
        payload: body.payload,
        headers: body.headers,
      })
      assert.equal(put.statusCode, 200)

      const removed = await app.inject({ method: 'DELETE', url: '/api/team/avatar' })
      assert.equal(removed.statusCode, 200)

      assert.deepEqual(
        calls.map((call) => [call.method, new URL(call.url).pathname]),
        [['PUT', ORG_AVATAR_PATH], ['DELETE', ORG_AVATAR_PATH]],
      )
      for (const call of calls) {
        assert.ok(call.subjectAssertion, `${call.method} must assert the person`)
      }
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('a UOA session still takes the domain relay for another team', async () => {
  await withUoaEnv(async () => {
    // The picker reads teams the session is not standing in. UOA pins an
    // assertion to the asserted team, so a foreign team id can never ride
    // one — the read has to fall back to the domain-scoped route.
    const app = await makeApp(actorContextFor(['owner'], { teamId: otherTeamId, uoa: true }))
    const calls: StubCall[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch(
      calls,
      () => new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/teams/${otherTeamId}/avatar`,
      })

      assert.equal(response.statusCode, 200)
      assert.equal(new URL(calls[0]?.url ?? '').pathname, `/domain/teams/${otherExternalTeamId}/avatar`)
      assert.equal(calls[0]?.subjectAssertion, undefined)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})

test('a UOA capability refusal is not reported as a bad image', async () => {
  await withUoaEnv(async () => {
    // Only `/org/*` can 403 — it re-resolves the person's own `teams.manage`
    // capability, while `/domain/*` applies no role check at all. A Nessie
    // admin who lacks that UOA capability must not be told to fix an image
    // that was never the problem.
    const app = await makeApp(actorContextFor(['admin'], { uoa: true }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{"code":"INSUFFICIENT_ORG_ROLE"}', {
        status: 403,
      })) as unknown as typeof fetch

    const body = multipartBody('file', 'logo.png', 'image/png', PNG_BYTES)
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/team/avatar',
        payload: body.payload,
        headers: body.headers,
      })

      assert.equal(response.statusCode, 403)
      assert.equal(response.json().error.code, 'TEAM_AVATAR_REJECTED')
      assert.match(response.json().error.message, /permission/)
      assert.doesNotMatch(response.json().error.message, /PNG/)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})
