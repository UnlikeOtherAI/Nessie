import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { PinnedFetch } from '@nessie/runtime'

import {
  clearUoaTeamDirectoryCache,
  readUoaTeamDirectory,
  rememberUoaTeamDirectory,
} from '../src/services/uoa-directory-cache.js'
import {
  clearUoaDirectoryRefreshState,
  refreshStaleUoaTeamDirectory,
} from '../src/services/uoa-directory-refresh.js'
import type { UoaTeamDirectory } from '../src/services/uoa-team-directory.js'

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem', type: 'pkcs8',
})
Object.assign(process.env, {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
})

const userId = '00000000-0000-4000-8000-00000000000a'
const activeLocalOrganizationId = '00000000-0000-4000-8000-000000000001'

const identity = {
  organizationId: 'uoa-org-alpha',
  subject: 'uoa-subject',
  teamId: 'uoa-team-alpha',
  tokenVersion: 4,
}

/** The `/org/me` body UOA answers, with an invite from ANOTHER organisation. */
const orgMeBody = {
  org: {
    org_id: 'uoa-org-alpha',
    team_directory: [
      {
        orgId: 'uoa-org-alpha',
        teamId: 'uoa-team-alpha',
        name: 'General',
        orgName: 'Alpha Team',
      },
    ],
    pending_invites: [
      {
        inviteId: 'invite-bravo-three',
        orgId: 'uoa-org-bravo',
        teamId: 'uoa-team-bravo-three',
        teamName: 'Bravo Three',
        orgName: 'Bravo Org',
        invitedBy: 'Test B',
        expiresAt: '2026-09-30T12:00:00.000Z',
      },
    ],
  },
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const resolveHost = async (): Promise<string[]> => ['93.184.216.34']

type CapturedUpsert = {
  create: { organizationId: string; metadata: Record<string, unknown> }
}

/** Enough Prisma for `syncTeamInviteAlerts`, recording what it wrote. */
const makePrisma = () => {
  const upserts: CapturedUpsert[] = []
  let transactions = 0
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<void>) => {
      transactions += 1
      await run({
        userAlert: {
          upsert: async (args: CapturedUpsert) => {
            upserts.push(args)
          },
          deleteMany: async () => ({ count: 0 }),
        },
      })
    },
  } as unknown as PrismaClient
  return { prisma, transactions: () => transactions, upserts }
}

const staleDirectory: UoaTeamDirectory = {
  entries: [{
    organizationId: 'uoa-org-alpha',
    teamId: 'uoa-team-alpha',
    label: 'Stale label',
  }],
  pendingInvites: [],
}

const seedStaleCache = (ageMs: number): void => {
  clearUoaTeamDirectoryCache()
  clearUoaDirectoryRefreshState()
  rememberUoaTeamDirectory(userId, staleDirectory, Date.now() - ageMs)
}

const refreshInput = {
  identity,
  organizationId: activeLocalOrganizationId,
  userId,
}

test('a directory older than the freshness bound is re-read exactly once and rewritten', async () => {
  seedStaleCache(61_000)
  let calls = 0
  const { prisma, upserts } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async (url, init) => {
      calls += 1
      assert.equal(new URL(url as string | URL).pathname, '/org/me')
      // Authorized as the person, with the same short-lived product-signed
      // assertion every other on-demand `/org/*` read uses.
      assert.ok(new Headers(init?.headers).get('x-uoa-subject-assertion'))
      return json(orgMeBody)
    }) as PinnedFetch,
    resolveHost,
  })

  assert.equal(calls, 1)
  const cached = readUoaTeamDirectory(userId)
  assert.equal(cached?.entries[0]?.label, 'General')
  assert.deepEqual(cached?.pendingInvites, [{
    inviteId: 'invite-bravo-three',
    organizationId: 'uoa-org-bravo',
    teamId: 'uoa-team-bravo-three',
    teamName: 'Bravo Three',
    orgName: 'Bravo Org',
    invitedBy: 'Test B',
    expiresAt: '2026-09-30T12:00:00.000Z',
  }])
  assert.equal(upserts.length, 1)

  // A second call within the bound is served from the copy just written.
  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => {
      throw new Error('a fresh directory must not reach UOA')
    }) as PinnedFetch,
    resolveHost,
  })
  assert.equal(calls, 1)
})

test('a cross-organisation invitation is filed in the bell the recipient is looking at', async () => {
  seedStaleCache(61_000)
  const { prisma, upserts } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json(orgMeBody)) as PinnedFetch,
    resolveHost,
  })

  assert.equal(upserts.length, 1)
  const written = upserts[0]!.create
  // The row's organisation is the ACTIVE local one — the recipient has no
  // membership of the inviting organisation, and `visibleUserAlertWhere`
  // requires one, so filing it there would hide the invitation for good.
  assert.equal(written.organizationId, activeLocalOrganizationId)
  // The invitation's own organisation travels in the metadata, which is what
  // the switcher, bell and /alerts name on the row.
  assert.equal(written.metadata.organizationId, 'uoa-org-bravo')
  assert.equal(written.metadata.orgName, 'Bravo Org')
  assert.equal(written.metadata.teamName, 'Bravo Three')
})

test('an invitation without an organisation name is still parsed and filed', async () => {
  seedStaleCache(61_000)
  const { prisma, upserts } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json({
      org: {
        ...orgMeBody.org,
        pending_invites: [{
          inviteId: 'invite-legacy',
          orgId: 'uoa-org-bravo',
          teamId: 'uoa-team-bravo-three',
          teamName: 'Bravo Three',
        }],
      },
    })) as PinnedFetch,
    resolveHost,
  })

  assert.deepEqual(readUoaTeamDirectory(userId)?.pendingInvites, [{
    inviteId: 'invite-legacy',
    organizationId: 'uoa-org-bravo',
    teamId: 'uoa-team-bravo-three',
    teamName: 'Bravo Three',
  }])
  assert.equal(upserts[0]!.create.metadata.orgName, undefined)
})

test('a failed UOA read keeps the cached directory and reconciles no alerts', async () => {
  seedStaleCache(61_000)
  const { prisma, transactions } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json({ error: 'UNAVAILABLE' }, 503)) as PinnedFetch,
    resolveHost,
  })

  // `undefined` is not a verified empty directory: the 30-minute copy stays,
  // and nothing touches the durable invitation rows.
  assert.deepEqual(readUoaTeamDirectory(userId), staleDirectory)
  assert.equal(transactions(), 0)
})

test('a body with no organisation block is a failed read, not an empty directory', async () => {
  seedStaleCache(61_000)
  const { prisma, transactions } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json({ ok: true })) as PinnedFetch,
    resolveHost,
  })

  assert.deepEqual(readUoaTeamDirectory(userId), staleDirectory)
  assert.equal(transactions(), 0)
})

test('a burst of concurrent refreshes makes exactly one UOA request', async () => {
  seedStaleCache(61_000)
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { prisma } = makePrisma()

  const inFlight = Array.from({ length: 5 }, () =>
    refreshStaleUoaTeamDirectory(prisma, refreshInput, {
      fetchImpl: (async () => {
        calls += 1
        await gate
        return json(orgMeBody)
      }) as PinnedFetch,
      resolveHost,
    }))
  release?.()
  await Promise.all(inFlight)

  assert.equal(calls, 1)
})

test('a failing UOA read is attempted once per cooldown, not once per call', async () => {
  seedStaleCache(61_000)
  let calls = 0
  const { prisma } = makePrisma()
  const deps = {
    fetchImpl: (async () => {
      calls += 1
      return json({ error: 'UNAVAILABLE' }, 503)
    }) as PinnedFetch,
    resolveHost,
  }

  // Sequential, not concurrent: the in-flight map cannot help here. A failed
  // read leaves the copy's age untouched, so without the attempt cooldown each
  // of these would hang a fresh upstream timeout off `/api/auth/me`.
  await refreshStaleUoaTeamDirectory(prisma, refreshInput, deps)
  await refreshStaleUoaTeamDirectory(prisma, refreshInput, deps)
  await refreshStaleUoaTeamDirectory(prisma, refreshInput, deps)
  assert.equal(calls, 1)
  assert.deepEqual(readUoaTeamDirectory(userId), staleDirectory)

  // Past the cooldown it tries again — an outage must not read as a permanent
  // refusal.
  await refreshStaleUoaTeamDirectory(
    prisma,
    { ...refreshInput, now: Date.now() + 61_000 },
    deps,
  )
  assert.equal(calls, 2)
})

test('a refused subject assertion stops attempts until a verified read', async () => {
  for (const status of [401, 403]) {
    seedStaleCache(61_000)
    let calls = 0
    const { prisma } = makePrisma()
    const deps = {
      fetchImpl: (async () => {
        calls += 1
        return json({ code: 'ACCESS_DENIED' }, status)
      }) as PinnedFetch,
      resolveHost,
    }

    await refreshStaleUoaTeamDirectory(prisma, refreshInput, deps)
    assert.equal(calls, 1)

    // 401/403 is UOA rejecting the assertion itself: the epoch moved on, or the
    // account was deactivated. A minute later it says the same thing, so
    // nothing is attempted for the rest of the cached copy's life.
    await refreshStaleUoaTeamDirectory(
      prisma,
      { ...refreshInput, now: Date.now() + 61_000 },
      deps,
    )
    await refreshStaleUoaTeamDirectory(
      prisma,
      { ...refreshInput, now: Date.now() + 20 * 60_000 },
      deps,
    )
    assert.equal(calls, 1, `status ${status} kept retrying`)
    // The copy is kept, never evicted — that is what this path did before an
    // on-demand read existed at all.
    assert.deepEqual(readUoaTeamDirectory(userId), staleDirectory)

    // A login or rotation writing a verified directory lifts the suppression.
    rememberUoaTeamDirectory(userId, staleDirectory, Date.now() - 61_000)
    await refreshStaleUoaTeamDirectory(prisma, refreshInput, deps)
    assert.equal(calls, 2, `status ${status} stayed suppressed after a login`)
  }
})

test('an unstated invitation list reconciles nothing; an empty one reconciles', async () => {
  const partialBodies = [
    // `pending_invites` absent entirely — an older build, or a shape change.
    { org: { org_id: 'uoa-org-alpha', team_directory: orgMeBody.org.team_directory } },
    // Present but not a list.
    {
      org: {
        org_id: 'uoa-org-alpha',
        team_directory: orgMeBody.org.team_directory,
        pending_invites: { inviteId: 'not-a-list' },
      },
    },
    // A non-empty list nothing in which parses.
    {
      org: {
        org_id: 'uoa-org-alpha',
        team_directory: orgMeBody.org.team_directory,
        pending_invites: [{ inviteId: 'invite-only', orgId: 'uoa-org-bravo' }],
      },
    },
  ]

  for (const [index, body] of partialBodies.entries()) {
    seedStaleCache(61_000)
    const { prisma, transactions } = makePrisma()
    await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
      fetchImpl: (async () => json(body)) as PinnedFetch,
      resolveHost,
    })
    // The team directory in the same body IS verified and is cached...
    assert.equal(readUoaTeamDirectory(userId)?.entries[0]?.label, 'General', `body ${index}`)
    // ...but nothing states the invitations, so nothing deletes them.
    assert.equal(readUoaTeamDirectory(userId)?.pendingInvites, undefined, `body ${index}`)
    assert.equal(transactions(), 0, `body ${index} reconciled a partial answer`)
  }

  // A genuinely empty list is UOA saying "none pending", and does reconcile.
  seedStaleCache(61_000)
  const { prisma, transactions } = makePrisma()
  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json({
      org: {
        org_id: 'uoa-org-alpha',
        team_directory: orgMeBody.org.team_directory,
        pending_invites: [],
      },
    })) as PinnedFetch,
    resolveHost,
  })
  assert.deepEqual(readUoaTeamDirectory(userId)?.pendingInvites, [])
  assert.equal(transactions(), 1)
})

test('one malformed invitation among valid ones still reconciles the valid ones', async () => {
  seedStaleCache(61_000)
  const { prisma, upserts } = makePrisma()

  await refreshStaleUoaTeamDirectory(prisma, refreshInput, {
    fetchImpl: (async () => json({
      org: {
        ...orgMeBody.org,
        pending_invites: [
          { inviteId: 'invite-broken', orgId: 'uoa-org-bravo' },
          ...orgMeBody.org.pending_invites,
        ],
      },
    })) as PinnedFetch,
    resolveHost,
  })

  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]!.create.metadata.inviteId, 'invite-bravo-three')
})

test('a session with no UOA epoch never opens a request', async () => {
  seedStaleCache(61_000)
  const { prisma } = makePrisma()
  const mustNotCall = (async () => {
    throw new Error('must not call upstream')
  }) as PinnedFetch

  await refreshStaleUoaTeamDirectory(prisma, { ...refreshInput, identity: undefined }, {
    fetchImpl: mustNotCall, resolveHost,
  })
  await refreshStaleUoaTeamDirectory(
    prisma,
    { ...refreshInput, identity: { ...identity, tokenVersion: null } },
    { fetchImpl: mustNotCall, resolveHost },
  )

  assert.deepEqual(readUoaTeamDirectory(userId), staleDirectory)
})
