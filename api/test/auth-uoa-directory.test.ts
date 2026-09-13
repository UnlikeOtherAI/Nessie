import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient, User } from '@prisma/client'

import { MeResponseSchema } from '@nessie/schemas'

import type { SessionTokenClaims } from '../src/auth/session.js'
import { buildMeResponse } from '../src/services/auth.js'
import type { UoaTeamDirectory } from '../src/services/uoa-team-directory.js'
import {
  clearUoaTeamDirectoryCache,
  readUoaTeamDirectory,
  rememberUoaTeamDirectory,
} from '../src/services/uoa-directory-cache.js'
import { clearUoaDirectoryRefreshState } from '../src/services/uoa-directory-refresh.js'

const userId = '00000000-0000-4000-8000-00000000000a'
const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'

const claims: SessionTokenClaims = {
  exp: 1_700_086_400,
  iat: 1_700_000_000,
  org: organizationId,
  proj: projectId,
  providerId: 'uoa',
  providerType: 'uoa',
  roles: ['owner'],
  sid: 'session-1',
  sub: userId,
  team: teamId,
  uoaIdentity: {
    organizationId: 'uoa-org-active',
    subject: 'uoa-subject',
    teamId: 'uoa-team-active',
    tokenVersion: 3,
  },
}

const user: User = {
  avatarAttachmentId: null,
  avatarUrl: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  displayName: 'Ada L.',
  email: 'ada.lovelace@example.com',
  id: userId,
  passwordHash: null,
  preferences: null,
  pronouns: null,
  superAdmin: false,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

type LocalTeam = {
  externalOrgId: string
  externalTeamId: string
  id: string
  name: string
  organizationName?: string
}

type TeamQuery = {
  where: {
    externalTeamId?: { in?: string[]; not?: null }
    members: { some: { userId: string } }
  }
}

const makePrisma = (localTeams: LocalTeam[] = []) => ({
  // The freshness read reconciles durable invitation alerts after it rewrites
  // the cache. Accepting the writes keeps that path exercised and silent.
  $transaction: async (run: (tx: unknown) => Promise<void>) => {
    await run({
      userAlert: {
        upsert: async () => undefined,
        deleteMany: async () => ({ count: 0 }),
      },
    })
  },
  organizationMember: { findMany: async () => [] },
  projectMember: { findMany: async () => [] },
  teamMember: { findMany: async () => [] },
  team: {
    findMany: async ({ where }: TeamQuery) => {
      assert.equal(where.members.some.userId, userId)
      // Two callers share this model: the avatar relay resolves local ids for
      // named external teams, the degraded fallback lists every locally
      // materialized UOA team this person belongs to.
      const externalIds = where.externalTeamId?.in
      const teams = externalIds
        ? localTeams.filter((team) => externalIds.includes(team.externalTeamId))
        : localTeams
      return teams.map((team) => ({
        ...team,
        project: {
          organization: { name: team.organizationName ?? 'Mirrored organization' },
        },
      }))
    },
  },
  user: { update: async () => user },
} as unknown as PrismaClient)

const config = {
  auth: { autoRedirectToSso: true },
  automaticMembership: { enabled: false },
  mode: 'hosted',
} as Parameters<typeof buildMeResponse>[3]

// A signing key and UOA credentials so the on-demand freshness read
// (`services/uoa-directory-refresh.ts`) is configured; every test below pins
// its upstream, so nothing here ever opens a socket.
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem', type: 'pkcs8',
})
// Deliberately no `UOA_BASE_URL`: the rest of this file asserts the default
// avatar origin, and the freshness read's upstream is pinned per test anyway.
Object.assign(process.env, {
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
})

/** No UOA credentials in scope: the freshness read is skipped entirely. */
const noUoaDeps = { settings: null } as const

const verifiedDirectory = (
  entries: UoaTeamDirectory['entries'],
  pendingInvites: UoaTeamDirectory['pendingInvites'] = [],
) => ({ entries, pendingInvites })

test('a cached directory is served without touching the account link', async () => {
  clearUoaTeamDirectoryCache()
  rememberUoaTeamDirectory(userId, verifiedDirectory([
    {
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      avatarImageUrl: 'https://authentication.example.com/teams/uoa-team-active/avatar',
      label: 'Active team',
      orgName: 'Active org',
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      label: 'Other team',
    },
  ], [{
    inviteId: 'invite-1',
    organizationId: 'uoa-org-invited',
    teamId: 'uoa-team-invited',
    teamName: 'Invited team',
    invitedBy: 'Grace Hopper',
  }]))
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'Local mirror of the active team',
    organizationName: 'Active org',
  }])

  const me = await buildMeResponse(prisma, user, claims, config, noUoaDeps)

  assert.deepEqual(me.uoaTeams, [
    {
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      avatarTeamId: teamId,
      avatarImageUrl: 'https://authentication.example.com/teams/uoa-team-active/avatar?size=128',
      label: 'Active team',
      orgName: 'Active org',
      active: true,
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      avatarImageUrl:
        'https://authentication.unlikeotherai.com/teams/uoa-team-other/avatar?size=128',
      label: 'Other team',
      active: false,
    },
  ])
  assert.deepEqual(me.uoaPendingInvites, [{
    inviteId: 'invite-1',
    organizationId: 'uoa-org-invited',
    teamId: 'uoa-team-invited',
    teamName: 'Invited team',
    invitedBy: 'Grace Hopper',
  }])
  clearUoaTeamDirectoryCache()
})

test('an invitation from another organisation is served, and names it', async () => {
  clearUoaTeamDirectoryCache()
  // The production shape of F1: the session is active in "Alpha Team" and the
  // invitation belongs to a different UOA organisation the person is not a
  // member of. `/api/auth/me` must still offer it, with the organisation name
  // that tells two "General" teams apart.
  rememberUoaTeamDirectory(userId, verifiedDirectory(
    [{
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      label: 'General',
      orgName: 'Alpha Team',
    }],
    [{
      inviteId: 'invite-bravo-three',
      organizationId: 'uoa-org-bravo',
      teamId: 'uoa-team-bravo-three',
      teamName: 'Bravo Three',
      orgName: 'Bravo Org',
      invitedBy: 'Test B',
    }],
  ))
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'General',
    organizationName: 'Alpha Team',
  }])

  const me = await buildMeResponse(prisma, user, claims, config, noUoaDeps)

  assert.deepEqual(me.uoaPendingInvites, [{
    inviteId: 'invite-bravo-three',
    organizationId: 'uoa-org-bravo',
    teamId: 'uoa-team-bravo-three',
    teamName: 'Bravo Three',
    orgName: 'Bravo Org',
    invitedBy: 'Test B',
  }])
  // The response is the wire contract the admin parses, so it has to survive
  // the schema that guards it.
  MeResponseSchema.parse(me)
  clearUoaTeamDirectoryCache()
})

test('a cold cache degrades to the local Team → UOA team mapping', async () => {
  clearUoaTeamDirectoryCache()
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'Engineering',
    organizationName: 'Nessie Works',
  }])

  const me = await buildMeResponse(prisma, user, claims, config, noUoaDeps)

  // Label comes from the local team name and the avatar from UOA's
  // deterministic per-team image URL; the org name is simply unknown until the
  // next rotation refreshes the real directory.
  assert.deepEqual(me.uoaTeams, [{
    organizationId: 'uoa-org-active',
    teamId: 'uoa-team-active',
    avatarTeamId: teamId,
    avatarImageUrl:
      'https://authentication.unlikeotherai.com/teams/uoa-team-active/avatar?size=128',
    label: 'Engineering',
    orgName: 'Nessie Works',
    active: true,
  }])
  assert.equal(me.uoaPendingInvites, undefined)
})

test('a person with no locally materialized team gets no directory', async () => {
  clearUoaTeamDirectoryCache()
  const me = await buildMeResponse(makePrisma(), user, claims, config, noUoaDeps)
  assert.equal(me.uoaTeams, undefined)
})

test('a failed UOA read keeps the last verified directory', () => {
  clearUoaTeamDirectoryCache()
  const entries = [{ organizationId: 'uoa-org', teamId: 'uoa-team', label: 'Kept' }]
  rememberUoaTeamDirectory(userId, verifiedDirectory(entries))
  rememberUoaTeamDirectory(userId, undefined)
  assert.deepEqual(readUoaTeamDirectory(userId), verifiedDirectory(entries))
  clearUoaTeamDirectoryCache()
})

test('a cached directory expires after its TTL', () => {
  clearUoaTeamDirectoryCache()
  const start = 1_700_000_000_000
  rememberUoaTeamDirectory(
    userId,
    verifiedDirectory([{ organizationId: 'uoa-org', teamId: 'uoa-team', label: 'Stale soon' }]),
    start,
  )
  assert.notEqual(readUoaTeamDirectory(userId, start + 29 * 60 * 1000), undefined)
  assert.equal(readUoaTeamDirectory(userId, start + 30 * 60 * 1000), undefined)
  clearUoaTeamDirectoryCache()
})

test('the cache is bounded and evicts the least recently used person', () => {
  clearUoaTeamDirectoryCache()
  const bound = 10_000
  for (let index = 0; index < bound; index += 1) {
    rememberUoaTeamDirectory(`user-${index}`, verifiedDirectory([
      { organizationId: 'uoa-org', teamId: `uoa-team-${index}`, label: `Team ${index}` },
    ]))
  }
  // Touching the oldest entry moves it ahead of the next-oldest, so the write
  // that overflows the bound evicts `user-1` rather than `user-0`.
  assert.notEqual(readUoaTeamDirectory('user-0'), undefined)
  rememberUoaTeamDirectory('user-overflow', verifiedDirectory([
    { organizationId: 'uoa-org', teamId: 'uoa-team-overflow', label: 'Overflow' },
  ]))

  assert.notEqual(readUoaTeamDirectory('user-0'), undefined)
  assert.equal(readUoaTeamDirectory('user-1'), undefined)
  assert.notEqual(readUoaTeamDirectory('user-overflow'), undefined)
  clearUoaTeamDirectoryCache()
})

test('a directory older than the freshness bound is re-read before /auth/me answers', async () => {
  clearUoaTeamDirectoryCache()
  clearUoaDirectoryRefreshState()
  // Exactly F2: the cached copy predates an invitation created while this
  // person was already signed in. A page reload must not keep serving it.
  rememberUoaTeamDirectory(userId, verifiedDirectory(
    [{ organizationId: 'uoa-org-active', teamId: 'uoa-team-active', label: 'General' }],
    [],
  ), Date.now() - 61_000)
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'General',
  }])
  let calls = 0
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      calls += 1
      assert.equal(new URL(url).pathname, '/org/me')
      return new Response(JSON.stringify({
        org: {
          org_id: 'uoa-org-active',
          team_directory: [{
            orgId: 'uoa-org-active',
            teamId: 'uoa-team-active',
            name: 'General',
            orgName: 'Alpha Team',
          }],
          pending_invites: [{
            inviteId: 'invite-bravo-three',
            orgId: 'uoa-org-bravo',
            teamId: 'uoa-team-bravo-three',
            teamName: 'Bravo Three',
            orgName: 'Bravo Org',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as Parameters<typeof buildMeResponse>[4]['fetchImpl'],
    resolveHost: async () => ['93.184.216.34'],
  }

  const me = await buildMeResponse(prisma, user, claims, config, deps)

  assert.equal(calls, 1)
  assert.deepEqual(me.uoaPendingInvites, [{
    inviteId: 'invite-bravo-three',
    organizationId: 'uoa-org-bravo',
    teamId: 'uoa-team-bravo-three',
    teamName: 'Bravo Three',
    orgName: 'Bravo Org',
  }])

  // The rewritten copy is now current, so the next answer costs no UOA read.
  const again = await buildMeResponse(prisma, user, claims, config, deps)
  assert.equal(calls, 1)
  assert.deepEqual(again.uoaPendingInvites, me.uoaPendingInvites)
  clearUoaTeamDirectoryCache()
})

test('a UOA outage answers /auth/me from the cached copy', async () => {
  clearUoaTeamDirectoryCache()
  clearUoaDirectoryRefreshState()
  const cached = verifiedDirectory(
    [{ organizationId: 'uoa-org-active', teamId: 'uoa-team-active', label: 'General' }],
    [{
      inviteId: 'invite-known',
      organizationId: 'uoa-org-bravo',
      teamId: 'uoa-team-bravo-three',
      teamName: 'Bravo Three',
    }],
  )
  rememberUoaTeamDirectory(userId, cached, Date.now() - 61_000)
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'General',
  }])

  const me = await buildMeResponse(prisma, user, claims, config, {
    fetchImpl: (async () => new Response('{}', {
      status: 503, headers: { 'content-type': 'application/json' },
    })) as Parameters<typeof buildMeResponse>[4]['fetchImpl'],
    resolveHost: async () => ['93.184.216.34'],
  })

  assert.deepEqual(me.uoaPendingInvites, cached.pendingInvites)
  assert.deepEqual(readUoaTeamDirectory(userId), cached)
  clearUoaTeamDirectoryCache()
})
