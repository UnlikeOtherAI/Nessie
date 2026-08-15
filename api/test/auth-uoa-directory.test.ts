import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, User } from '@prisma/client'

import type { SessionTokenClaims } from '../src/auth/session.js'
import { buildMeResponse } from '../src/services/auth.js'
import {
  clearUoaWorkspaceDirectoryCache,
  readUoaWorkspaceDirectory,
  rememberUoaWorkspaceDirectory,
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
  externalWorkspaceId: string
  id: string
  name: string
}

type TeamQuery = {
  where: {
    externalWorkspaceId?: { in?: string[]; not?: null }
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
      // named external workspaces, the degraded fallback lists every locally
      // materialized UOA workspace this person belongs to.
      const externalIds = where.externalWorkspaceId?.in
      return externalIds
        ? localTeams.filter((team) => externalIds.includes(team.externalWorkspaceId))
        : localTeams
    },
  },
  user: { update: async () => user },
} as unknown as PrismaClient)

const config = {
  auth: { autoRedirectToSso: true },
  mode: 'hosted',
} as Parameters<typeof buildMeResponse>[3]

test('a cached directory is served without touching the account link', async () => {
  clearUoaWorkspaceDirectoryCache()
  rememberUoaWorkspaceDirectory(userId, [
    {
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      avatarImageUrl: 'https://authentication.example.com/teams/uoa-team-active/avatar',
      label: 'Active workspace',
      orgName: 'Active org',
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      label: 'Other workspace',
    },
  ])
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalWorkspaceId: 'uoa-team-active',
    id: teamId,
    name: 'Local mirror of the active workspace',
  }])

  const me = await buildMeResponse(prisma, user, claims, config)

  assert.deepEqual(me.uoaWorkspaces, [
    {
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      avatarTeamId: teamId,
      avatarImageUrl: 'https://authentication.example.com/teams/uoa-team-active/avatar?size=128',
      label: 'Active workspace',
      orgName: 'Active org',
      active: true,
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      avatarImageUrl:
        'https://authentication.unlikeotherai.com/teams/uoa-team-other/avatar?size=128',
      label: 'Other workspace',
      active: false,
    },
  ])
  clearUoaWorkspaceDirectoryCache()
})

test('a cold cache degrades to the local Team → UOA workspace mapping', async () => {
  clearUoaWorkspaceDirectoryCache()
  const prisma = makePrisma([{
    externalOrgId: 'uoa-org-active',
    externalWorkspaceId: 'uoa-team-active',
    id: teamId,
    name: 'Engineering',
  }])

  const me = await buildMeResponse(prisma, user, claims, config)

  // Label comes from the local team name and the avatar from UOA's
  // deterministic per-team image URL; the org name is simply unknown until the
  // next rotation refreshes the real directory.
  assert.deepEqual(me.uoaWorkspaces, [{
    organizationId: 'uoa-org-active',
    teamId: 'uoa-team-active',
    avatarTeamId: teamId,
    avatarImageUrl:
      'https://authentication.unlikeotherai.com/teams/uoa-team-active/avatar?size=128',
    label: 'Engineering',
    active: true,
  }])
})

test('a person with no locally materialized workspace gets no directory', async () => {
  clearUoaWorkspaceDirectoryCache()
  const me = await buildMeResponse(makePrisma(), user, claims, config)
  assert.equal(me.uoaWorkspaces, undefined)
})

test('a failed UOA read keeps the last verified directory', () => {
  clearUoaWorkspaceDirectoryCache()
  const entries = [{ organizationId: 'uoa-org', teamId: 'uoa-team', label: 'Kept' }]
  rememberUoaWorkspaceDirectory(userId, entries)
  rememberUoaWorkspaceDirectory(userId, undefined)
  assert.deepEqual(readUoaWorkspaceDirectory(userId), entries)
  clearUoaWorkspaceDirectoryCache()
})

test('a cached directory expires after its TTL', () => {
  clearUoaWorkspaceDirectoryCache()
  const start = 1_700_000_000_000
  rememberUoaWorkspaceDirectory(
    userId,
    [{ organizationId: 'uoa-org', teamId: 'uoa-team', label: 'Stale soon' }],
    start,
  )
  assert.notEqual(readUoaWorkspaceDirectory(userId, start + 29 * 60 * 1000), undefined)
  assert.equal(readUoaWorkspaceDirectory(userId, start + 30 * 60 * 1000), undefined)
  clearUoaWorkspaceDirectoryCache()
})

test('the cache is bounded and evicts the least recently used person', () => {
  clearUoaWorkspaceDirectoryCache()
  const bound = 10_000
  for (let index = 0; index < bound; index += 1) {
    rememberUoaWorkspaceDirectory(`user-${index}`, [
      { organizationId: 'uoa-org', teamId: `uoa-team-${index}`, label: `Workspace ${index}` },
    ])
  }
  // Touching the oldest entry moves it ahead of the next-oldest, so the write
  // that overflows the bound evicts `user-1` rather than `user-0`.
  assert.notEqual(readUoaWorkspaceDirectory('user-0'), undefined)
  rememberUoaWorkspaceDirectory('user-overflow', [
    { organizationId: 'uoa-org', teamId: 'uoa-team-overflow', label: 'Overflow' },
  ])

  assert.notEqual(readUoaWorkspaceDirectory('user-0'), undefined)
  assert.equal(readUoaWorkspaceDirectory('user-1'), undefined)
  assert.notEqual(readUoaWorkspaceDirectory('user-overflow'), undefined)
  clearUoaWorkspaceDirectoryCache()
})
