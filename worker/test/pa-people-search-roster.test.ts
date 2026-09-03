import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { PinnedFetch } from '@nessie/runtime'

import {
  clearPeopleSearchRosterCache,
  runPeopleSearchTool,
} from '../src/run/pa-tools/people.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000001'
const TEAM_ID = '20000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '20000000-0000-4000-8000-000000000003'
const USER_ID = '20000000-0000-4000-8000-000000000004'
const EXTERNAL_ORG_ID = 'org_acme'
const EXTERNAL_TEAM_ID = 'team_design'
const uoaPrivateKeyPem = String(
  crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

type PrismaCalls = {
  localSearches: number
  subjectJoins: string[][]
}

/**
 * The stub distinguishes the two `user.findMany` shapes structurally: the
 * local-mode search filters on `organizationMembers`, the UOA path joins on
 * `uoaSub` — so the tests can assert which directory actually answered.
 */
const makePrisma = (
  calls: PrismaCalls,
  options: {
    externalOrgId: string | null
    externalTeamId: string | null
    linkedUsers?: { id: string; uoaSub: string }[]
  },
): PrismaClient =>
  ({
    channel: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        assert.equal(where.id, CHANNEL_ID)
        return { teamId: TEAM_ID }
      },
    },
    team: {
      findFirst: async () => ({
        externalOrgId: options.externalOrgId,
        externalTeamId: options.externalTeamId,
      }),
    },
    user: {
      findMany: async ({ where }: {
        where: { uoaSub?: { in: string[] }; organizationMembers?: unknown }
      }) => {
        if (where.uoaSub) {
          calls.subjectJoins.push(where.uoaSub.in)
          return (options.linkedUsers ?? []).filter((user) =>
            where.uoaSub?.in.includes(user.uoaSub))
        }
        calls.localSearches += 1
        return [{
          id: USER_ID,
          displayName: 'Local Lena',
          email: 'lena@local.test',
          organizationMembers: [{ role: 'member' }],
        }]
      },
    },
  }) as unknown as PrismaClient

const makeContext = (prisma: PrismaClient): BuiltinToolRuntimeContext =>
  ({
    agentId: '20000000-0000-4000-8000-00000000000e',
    agentKind: 'personal_assistant',
    actorContext: {
      actor: { actorId: USER_ID, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: ORGANIZATION_ID },
      actionContext: {
        requestId: 'req-people-search',
        uoaIdentity: {
          organizationId: EXTERNAL_ORG_ID,
          subject: 'usr_ada',
          teamId: EXTERNAL_TEAM_ID,
          tokenVersion: 7,
        },
      },
    },
    channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID },
    prisma,
  }) as unknown as BuiltinToolRuntimeContext

const teamDetail = {
  id: EXTERNAL_TEAM_ID,
  members: [
    { userId: 'usr_ada', teamRole: 'owner' },
    { userId: 'usr_grace', teamRole: 'member' },
  ],
}

const orgMembers = {
  data: [
    { userId: 'usr_ada', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'owner', status: 'ACTIVE' },
    {
      userId: 'usr_grace',
      email: 'grace@acme.test',
      name: 'Grace Hopper',
      role: 'member',
      status: 'DEACTIVATED',
    },
  ],
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const rosterDeps = (urls: string[], respond: (url: string) => Response) => ({
  fetchImpl: (async (url: URL) => {
    urls.push(url.toString())
    return respond(url.toString())
  }) as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})

const respondRoster = (url: string): Response =>
  url.includes('/members') ? json(orgMembers) : json(teamDetail)

test('a UOA-linked team answers from the UOA roster, not local rows', async () => {
  await withUoaEnv(async () => {
    clearPeopleSearchRosterCache()
    const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
    const prisma = makePrisma(calls, {
      externalOrgId: EXTERNAL_ORG_ID,
      externalTeamId: EXTERNAL_TEAM_ID,
      linkedUsers: [{ id: USER_ID, uoaSub: 'usr_ada' }],
    })
    const urls: string[] = []

    const result = await runPeopleSearchTool(
      makeContext(prisma),
      'ada',
      10,
      rosterDeps(urls, respondRoster),
    )

    assert.equal(urls.length, 2)
    assert.ok(urls.some((url) => url.includes(`/org/organisations/${EXTERNAL_ORG_ID}/teams/`)))
    assert.match(result.outputPreview, /UnlikeOtherAI team roster/)
    assert.match(result.outputPreview, /Ada Lovelace \(you\) <ada@acme\.test>/)
    assert.match(result.outputPreview, /uoaSub=usr_ada/)
    assert.match(result.outputPreview, /userId=20000000-0000-4000-8000-000000000004/)
    assert.match(result.outputPreview, /role=owner/)
    assert.match(result.outputPreview, /status=ACTIVE/)
    // Grace does not match "ada" — the query filters the roster.
    assert.doesNotMatch(result.outputPreview, /Grace Hopper/)
    assert.equal(calls.localSearches, 0)
    assert.deepEqual(calls.subjectJoins, [['usr_ada']])
  })
})

test('the roster is cached briefly per (org, team) across repeated calls', async () => {
  await withUoaEnv(async () => {
    clearPeopleSearchRosterCache()
    const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
    const prisma = makePrisma(calls, {
      externalOrgId: EXTERNAL_ORG_ID,
      externalTeamId: EXTERNAL_TEAM_ID,
    })
    const urls: string[] = []
    const deps = rosterDeps(urls, respondRoster)

    const first = await runPeopleSearchTool(makeContext(prisma), 'grace', 10, deps)
    const second = await runPeopleSearchTool(makeContext(prisma), 'hopper', 10, deps)

    // Two searches, one upstream read pair (team detail + org members).
    assert.equal(urls.length, 2)
    assert.match(first.outputPreview, /Grace Hopper/)
    assert.match(second.outputPreview, /Grace Hopper/)
    assert.match(second.outputPreview, /status=DEACTIVATED/)
  })
})

test('an unlinked team keeps the local search and never calls UOA', async () => {
  await withUoaEnv(async () => {
    clearPeopleSearchRosterCache()
    const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
    const prisma = makePrisma(calls, {
      externalOrgId: null,
      externalTeamId: null,
    })
    const urls: string[] = []

    const result = await runPeopleSearchTool(
      makeContext(prisma),
      'lena',
      10,
      rosterDeps(urls, () => {
        throw new Error('an unlinked team must not reach UOA')
      }),
    )

    assert.equal(urls.length, 0)
    assert.equal(calls.localSearches, 1)
    assert.match(result.outputPreview, /Local Lena/)
    assert.doesNotMatch(result.outputPreview, /UnlikeOtherAI/)
  })
})

test('a deployment with no UOA credentials keeps the local search', async () => {
  clearPeopleSearchRosterCache()
  assert.equal(process.env.UOA_DOMAIN, undefined)
  const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
  const prisma = makePrisma(calls, {
    externalOrgId: EXTERNAL_ORG_ID,
    externalTeamId: EXTERNAL_TEAM_ID,
  })

  const result = await runPeopleSearchTool(makeContext(prisma), 'lena', 10, {
    fetchImpl: (async () => {
      throw new Error('an unconfigured deployment must not reach UOA')
    }) as unknown as PinnedFetch,
  })

  assert.equal(calls.localSearches, 1)
  assert.match(result.outputPreview, /Local Lena/)
})

test('a failed UOA read reports failure in words — never a local fallback', async () => {
  await withUoaEnv(async () => {
    clearPeopleSearchRosterCache()
    const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
    const prisma = makePrisma(calls, {
      externalOrgId: EXTERNAL_ORG_ID,
      externalTeamId: EXTERNAL_TEAM_ID,
    })
    const urls: string[] = []

    await assert.rejects(
      runPeopleSearchTool(
        makeContext(prisma),
        'ada',
        10,
        rosterDeps(urls, () => json({ error: 'nope' }, 503)),
      ),
      (error: Error) => {
        assert.match(error.message, /could not be read/)
        assert.match(error.message, /no local answer/)
        return true
      },
    )
    assert.equal(calls.localSearches, 0)
  })
})

test('an upstream refusal is also reported, not localized', async () => {
  await withUoaEnv(async () => {
    clearPeopleSearchRosterCache()
    const calls: PrismaCalls = { localSearches: 0, subjectJoins: [] }
    const prisma = makePrisma(calls, {
      externalOrgId: EXTERNAL_ORG_ID,
      externalTeamId: EXTERNAL_TEAM_ID,
    })
    const urls: string[] = []

    await assert.rejects(
      runPeopleSearchTool(
        makeContext(prisma),
        'ada',
        10,
        rosterDeps(urls, () => json({ error: 'forbidden' }, 403)),
      ),
      /could not be read/,
    )
    assert.equal(calls.localSearches, 0)
  })
})
