import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { AuthorizedActionContext, TeamMemberRecord } from '@nessie/schemas'

import { registerUserRoutes } from '../src/routes/users.js'
import type { UoaIdentityDirectory } from '../src/services/uoa-identity-directory.js'
import {
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
} from '../src/services/uoa-org-roster.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const teamId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'
const channelId = '55555555-5555-4555-8555-555555555555'
const externalOrgId = 'org_acme'
const timestamp = new Date('2026-09-10T12:00:00.000Z')

const identity = {
  organizationId: externalOrgId,
  subject: 'uoa-owner',
  teamId: 'team_design',
  tokenVersion: 7,
}

const member: TeamMemberRecord = {
  avatarImageUrl: 'https://uoa.example/avatar.png',
  displayName: 'Live Person',
  email: 'live@example.test',
  orgRole: 'member',
  status: 'ACTIVE',
  uoaSub: 'uoa-person',
}

const boundUser = (uoaSub: string | null = member.uoaSub) => ({
  channelMembers: [{ channelId }],
  createdAt: timestamp,
  id: userId,
  statuses: [],
  uoaSub,
  updatedAt: timestamp,
})

const unboundUser = {
  avatarAttachmentId: null,
  avatarUrl: null,
  channelMembers: [{ channelId }],
  createdAt: timestamp,
  displayName: 'Local Person',
  email: 'local@example.test',
  id: userId,
  organizationMembers: [{ deactivatedAt: null, role: 'owner' }],
  statuses: [],
  updatedAt: timestamp,
}

type AppOptions = {
  directoryList?: () => Promise<TeamMemberRecord[]>
  externalId?: string | null
  hasIdentity?: boolean
  owner?: boolean
  users?: unknown[]
}

const makeApp = async (options: AppOptions = {}) => {
  let directoryCalls = 0
  let userReads = 0
  const actorContext: AuthorizedActionContext = {
    actor: { actorType: 'user', actorId: userId, roles: options.owner === false ? ['member'] : ['owner'] },
    tenant: { organizationId, projectId, teamId },
    actionContext: {
      requestId: 'req-users-route',
      ...(options.hasIdentity === false ? {} : { uoaIdentity: identity }),
    },
  }
  const directory: UoaIdentityDirectory = {
    invalidateOrganization: () => undefined,
    list: async () => {
      directoryCalls += 1
      return (options.directoryList ?? (async () => [member]))()
    },
  }
  const prisma = {
    organization: {
      findUnique: async () => ({ externalOrgId: options.externalId === undefined
        ? externalOrgId
        : options.externalId }),
    },
    user: {
      findMany: async () => {
        userReads += 1
        return options.users ?? [boundUser()]
      },
    },
  }
  const app = Fastify({ logger: false })
  registerUserRoutes(app, {
    MEMBERSHIP_ROLES: ['owner', 'admin', 'member', 'viewer'],
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: (_context, reply) => {
      if (options.owner !== false) return true
      reply.code(403).send({ error: { code: 'OWNER_REQUIRED', message: 'Owner access required' } })
      return false
    },
    resolveMembershipRole: (role: string) => role,
  } as never, directory)
  await app.ready()
  return {
    app,
    calls: () => ({ directory: directoryCalls, users: userReads }),
  }
}

test('bound owner receives only UOA-authorized identities with product extensions', async () => {
  const fixture = await makeApp()
  const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(fixture.calls(), { directory: 1, users: 1 })
  assert.deepEqual(response.json().data, [{
    activeStatus: null,
    avatarUrl: member.avatarImageUrl,
    channelIds: [channelId],
    createdAt: timestamp.toISOString(),
    displayName: member.displayName,
    email: member.email,
    id: userId,
    role: member.orgRole,
    updatedAt: timestamp.toISOString(),
  }])
  await fixture.app.close()
})

test('non-owner is rejected before any UOA directory read', async () => {
  const fixture = await makeApp({ owner: false })
  const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

  assert.equal(response.statusCode, 403)
  assert.deepEqual(fixture.calls(), { directory: 0, users: 0 })
  await fixture.app.close()
})

test('bound organization requires a current UOA identity', async () => {
  const fixture = await makeApp({ hasIdentity: false })
  const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'UOA_SESSION_REQUIRED')
  assert.deepEqual(fixture.calls(), { directory: 0, users: 0 })
  await fixture.app.close()
})

for (const failure of [
  {
    code: 'ORGANIZATION_MEMBERS_REJECTED',
    error: new UoaRosterRejectedError('denied', 403),
    status: 403,
  },
  {
    code: 'UOA_DIRECTORY_UNAVAILABLE',
    error: new UoaRosterUnavailableError('offline'),
    status: 502,
  },
]) {
  test(`upstream ${failure.status} never falls back to local identities`, async () => {
    const fixture = await makeApp({ directoryList: async () => { throw failure.error } })
    const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

    assert.equal(response.statusCode, failure.status)
    assert.equal(response.json().error.code, failure.code)
    assert.deepEqual(fixture.calls(), { directory: 1, users: 0 })
    await fixture.app.close()
  })
}

test('a missing stable subject returns a migration error', async () => {
  const fixture = await makeApp({ users: [boundUser(null)] })
  const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error.code, 'UOA_IDENTITY_MAPPING_REQUIRED')
  assert.deepEqual(fixture.calls(), { directory: 1, users: 1 })
  await fixture.app.close()
})

test('an unbound organization retains the local directory path', async () => {
  const fixture = await makeApp({ externalId: null, users: [unboundUser] })
  const response = await fixture.app.inject({ method: 'GET', url: '/api/users' })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data[0].displayName, unboundUser.displayName)
  assert.equal(response.json().data[0].email, unboundUser.email)
  assert.deepEqual(fixture.calls(), { directory: 0, users: 1 })
  await fixture.app.close()
})
