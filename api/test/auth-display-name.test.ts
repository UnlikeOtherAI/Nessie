import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, User } from '@prisma/client'

import type { SessionTokenClaims } from '../src/auth/session.js'
import { buildMeResponse } from '../src/services/auth.js'

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
}

const makeUser = (displayName: string): User => ({
  avatarAttachmentId: null,
  avatarUrl: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  displayName,
  email: 'ada.lovelace@example.com',
  id: userId,
  passwordHash: null,
  preferences: null,
  pronouns: null,
  superAdmin: false,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
})

const makePrisma = (
  workspaceDirectory?: unknown,
  avatarTeams: Array<{ id: string; externalWorkspaceId: string }> = [],
) => {
  const updates: Array<{ displayName: string; id: string }> = []
  const prisma = {
    // loadUserMemberships now issues its three membership queries in parallel
    // rather than nesting them, so all three must exist on the fake.
    organizationMember: {
      findMany: async () => [],
    },
    projectMember: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    productAccountLink: {
      findUnique: async () => workspaceDirectory ? { metadata: { workspaceDirectory } } : null,
    },
    team: {
      findMany: async ({ where }: {
        where: {
          externalWorkspaceId: { in: string[] }
          members: { some: { userId: string } }
        }
      }) => {
        assert.equal(where.members.some.userId, userId)
        return avatarTeams.filter((team) => where.externalWorkspaceId.in.includes(team.externalWorkspaceId))
      },
    },
    user: {
      update: async ({ data, where }: { data: { displayName: string }; where: { id: string } }) => {
        updates.push({ displayName: data.displayName, id: where.id })
        return makeUser(data.displayName)
      },
    },
  } as unknown as PrismaClient

  return { prisma, updates }
}

test('buildMeResponse repairs a legacy email display name during session hydration', async () => {
  const { prisma, updates } = makePrisma()
  const me = await buildMeResponse(
    prisma,
    makeUser('ada.lovelace@example.com'),
    claims,
    { auth: { autoRedirectToSso: true }, mode: 'hosted' } as Parameters<typeof buildMeResponse>[3],
  )

  assert.equal(me.user.displayName, 'Ada Lovelace')
  assert.deepEqual(updates, [{ displayName: 'Ada Lovelace', id: userId }])
})

test('buildMeResponse leaves a non-email display name untouched', async () => {
  const { prisma, updates } = makePrisma()
  const me = await buildMeResponse(
    prisma,
    makeUser('Ada L.'),
    claims,
    { auth: { autoRedirectToSso: true }, mode: 'hosted' } as Parameters<typeof buildMeResponse>[3],
  )

  assert.equal(me.user.displayName, 'Ada L.')
  assert.deepEqual(updates, [])
})

test('buildMeResponse exposes the UOA workspace directory with its signed active workspace', async () => {
  const { prisma } = makePrisma(
    [
      {
        organizationId: 'uoa-org-active',
        teamId: 'uoa-team-active',
        avatarImageUrl: 'https://authentication.example.com/public/teams/uoa-team-active/avatar',
        label: 'Active workspace',
        orgName: 'Active org',
      },
      {
        organizationId: 'uoa-org-other',
        teamId: 'uoa-team-other',
        avatarImageUrl: 'javascript:alert(1)',
        label: 'Other workspace',
      },
    ],
    [{ id: teamId, externalWorkspaceId: 'uoa-team-active' }],
  )
  const me = await buildMeResponse(
    prisma,
    makeUser('Ada L.'),
    {
      ...claims,
      uoaIdentity: {
        organizationId: 'uoa-org-active',
        subject: 'uoa-subject',
        teamId: 'uoa-team-active',
        tokenVersion: 3,
      },
    },
    { auth: { autoRedirectToSso: true }, mode: 'hosted' } as Parameters<typeof buildMeResponse>[3],
  )

  assert.deepEqual(me.uoaWorkspaces, [
    {
      organizationId: 'uoa-org-active',
      teamId: 'uoa-team-active',
      avatarTeamId: teamId,
      avatarImageUrl: 'https://authentication.example.com/public/teams/uoa-team-active/avatar',
      label: 'Active workspace',
      orgName: 'Active org',
      active: true,
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      label: 'Other workspace',
      active: false,
    },
  ])
})
