import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, User } from '@prisma/client'

import type { SessionTokenClaims } from '../src/auth/session.js'
import { buildMeResponse } from '../src/services/auth.js'
import type { UoaTeamDirectory } from '../src/services/uoa-team-directory.js'
import {
  clearUoaTeamDirectoryCache,
  readUoaTeamDirectory,
  rememberUoaTeamDirectory,
} from '../src/services/uoa-directory-cache.js'

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

  const me = await buildMeResponse(prisma, user, claims, config)

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

test('a cold cache degrades to the local Team → UOA team mapping', async () => {
  clearUoaTeamDirectoryCache()
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalTeamId: 'uoa-team-active',
    id: teamId,
    name: 'Engineering',
    organizationName: 'Nessie Works',
  }])

  const me = await buildMeResponse(prisma, user, claims, config)

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
  const me = await buildMeResponse(makePrisma(), user, claims, config)
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
