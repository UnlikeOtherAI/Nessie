import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { registerPeopleRoutes } from '../src/routes/people.js'

/**
 * `GET /api/people` on an install with no sign-in provider: the install's own
 * rows are the roster, at the organisation and at any of its teams — which is
 * what fixes the local Team roster, which used to read the provider relay and
 * could only answer "this team has lost its connection".
 *
 * Against a real database because the answers are relation filters and keyset
 * pages: who is deactivated, which teams are the organisation's own (never a
 * system team), and who may read which roster.
 */

const suite = 'e7a1'
const id = (n: string) => `00000000-0000-4000-8000-${suite}${n}`
const orgId = id('00000001')
const projectId = id('00000002')
const designId = id('00000003')
const salesId = id('00000004')
const systemTeamId = id('00000005')
const ownerId = id('00000010')
const adminId = id('00000011')
const miaId = id('00000012')
const benId = id('00000013')
const oscarId = id('00000014')
const userIds = [ownerId, adminId, miaId, benId, oscarId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string, role: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: [role] },
  tenant: {
    organizationId: parseOrganizationId(orgId),
    projectId: parseProjectId(projectId),
    teamId: parseTeamId(designId),
  },
  actionContext: { requestId: `req-people-${userId}`, teamId: parseTeamId(designId) },
} as AuthorizedActionContext)

const cleanup = async (prisma: PrismaClient) => {
  await prisma.teamMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.team.deleteMany({ where: { id: { in: [designId, salesId, systemTeamId] } } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `org-people-${suite}` } })
  await prisma.user.createMany({
    data: [
      { id: ownerId, displayName: 'Olivia Owner' },
      { id: adminId, displayName: 'Adam Admin' },
      { id: miaId, displayName: 'Mia Member' },
      { id: benId, displayName: 'Ben Deactivated' },
      { id: oscarId, displayName: 'Oscar Outside' },
    ].map((user, index) => ({ ...user, email: `people-${suite}-${index}@test.local` })),
  })
  // Joined one after another, so the roster's order (who joined first) is known.
  const joined = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute))
  await prisma.organizationMember.createMany({
    data: [
      { createdAt: joined(0), organizationId: orgId, role: 'owner', userId: ownerId },
      { createdAt: joined(1), organizationId: orgId, role: 'admin', userId: adminId },
      { createdAt: joined(2), organizationId: orgId, role: 'member', userId: miaId },
      { createdAt: joined(3), deactivatedAt: new Date(), organizationId: orgId, role: 'member', userId: benId },
      { createdAt: joined(4), organizationId: orgId, role: 'member', userId: oscarId },
    ],
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.createMany({
    data: [
      { id: designId, name: `Design ${suite}`, projectId },
      { id: salesId, name: `Sales ${suite}`, projectId },
      { id: systemTeamId, name: `Assistant ${suite}`, projectId, systemManaged: true },
    ],
  })
  await prisma.teamMember.createMany({
    data: [
      { createdAt: joined(0), role: 'owner', teamId: designId, userId: ownerId },
      { createdAt: joined(2), role: 'admin', teamId: designId, userId: miaId },
      { createdAt: joined(2), role: 'member', teamId: systemTeamId, userId: miaId },
      { createdAt: joined(3), role: 'member', teamId: salesId, userId: benId },
    ],
  })
}

const withApp = async (
  actor: AuthorizedActionContext,
  run: (inject: (url: string) => Promise<{ body: Body; status: number }>) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const app = Fastify({ logger: false })
  try {
    await cleanup(prisma)
    await seed(prisma)
    registerPeopleRoutes(app, {
      prisma,
      requireActorContext: () => actor,
    } as unknown as Parameters<typeof registerPeopleRoutes>[1])
    await run(async (url) => {
      const res = await app.inject({ method: 'GET', url })
      return { body: res.json() as Body, status: res.statusCode }
    })
  } finally {
    await app.close()
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

type Person = {
  displayName: string
  orgRole: string
  status: string
  teamRole?: string
  teams: unknown[]
  userId: string
}
type Body = {
  data: { items: Person[]; permissions: Record<string, boolean>; source: string; team?: unknown }
  error?: { code: string }
  meta: { hasMore: boolean; nextCursor: string | null; total?: number }
}

dbTest('the organisation’s people, each with their own teams and never a system team', async () => {
  await withApp(actorFor(ownerId, 'owner'), async (inject) => {
    const { body, status } = await inject('/api/people')
    assert.equal(status, 200)
    assert.equal(body.data.source, 'local')
    assert.equal(body.meta.total, 4)
    assert.deepEqual(body.data.items.map((person) => person.displayName), [
      'Olivia Owner', 'Adam Admin', 'Mia Member', 'Oscar Outside',
    ])
    const mia = body.data.items.find((person) => person.userId === miaId)
    assert.equal(mia?.orgRole, 'member')
    assert.deepEqual(mia?.teams, [{ id: designId, name: `Design ${suite}`, role: 'admin' }])
    assert.deepEqual(body.data.permissions, {
      addMember: true, addToTeam: false, changeActivation: true, changeRole: true,
    })
  })
})

dbTest('the deactivated are their own list, still showing their teams', async () => {
  await withApp(actorFor(ownerId, 'owner'), async (inject) => {
    const { body } = await inject('/api/people?status=DEACTIVATED')
    assert.deepEqual(body.data.items.map((person) => [person.displayName, person.status]), [['Ben Deactivated', 'DEACTIVATED']])
    assert.deepEqual(body.data.items[0]?.teams, [{ id: salesId, name: `Sales ${suite}`, role: 'member' }])
  })
})

dbTest('an administrator reads the roster; every write stays the owner’s', async () => {
  await withApp(actorFor(adminId, 'admin'), async (inject) => {
    const { body, status } = await inject('/api/people')
    assert.equal(status, 200)
    assert.ok(Object.values(body.data.permissions).every((allowed) => allowed === false))
  })
})

dbTest('a member does not read the organisation’s roster', async () => {
  await withApp(actorFor(oscarId, 'member'), async (inject) => {
    const { body, status } = await inject('/api/people')
    assert.equal(status, 403)
    assert.equal(body.error?.code, 'ORGANIZATION_ADMIN_REQUIRED')
  })
})

dbTest('a team’s own member reads its roster, each with their role in it', async () => {
  await withApp(actorFor(miaId, 'member'), async (inject) => {
    const { body, status } = await inject(`/api/people?team=${designId}`)
    assert.equal(status, 200)
    assert.deepEqual(body.data.team, { id: designId, name: `Design ${suite}` })
    assert.deepEqual(body.data.items.map((person) => [person.displayName, person.teamRole]), [
      ['Olivia Owner', 'owner'], ['Mia Member', 'admin'],
    ])
    assert.equal(body.data.permissions.addToTeam, false)
  })
})

dbTest('somebody outside a team, and not an administrator, is refused its roster', async () => {
  await withApp(actorFor(miaId, 'member'), async (inject) => {
    const { body, status } = await inject(`/api/people?team=${salesId}`)
    assert.equal(status, 403)
    assert.equal(body.error?.code, 'TEAM_MEMBERSHIP_REQUIRED')
  })
})

dbTest('the owner reads any team, and may add people to it', async () => {
  await withApp(actorFor(ownerId, 'owner'), async (inject) => {
    const active = await inject(`/api/people?team=${salesId}`)
    assert.deepEqual(active.body.data.items, [])
    assert.equal(active.body.data.permissions.addToTeam, true)
    const deactivated = await inject(`/api/people?team=${salesId}&status=DEACTIVATED`)
    assert.deepEqual(deactivated.body.data.items.map((person) => person.displayName), ['Ben Deactivated'])
  })
})

dbTest('a system team is not a team people are listed in', async () => {
  await withApp(actorFor(ownerId, 'owner'), async (inject) => {
    const { body, status } = await inject(`/api/people?team=${systemTeamId}`)
    assert.equal(status, 404)
    assert.equal(body.error?.code, 'TEAM_NOT_FOUND')
  })
})

dbTest('the roster pages by who joined first, with the shared page contract', async () => {
  await withApp(actorFor(ownerId, 'owner'), async (inject) => {
    const first = await inject('/api/people?limit=2')
    assert.deepEqual(first.body.data.items.map((person) => person.displayName), ['Olivia Owner', 'Adam Admin'])
    assert.equal(first.body.meta.hasMore, true)
    assert.equal(first.body.meta.total, 4)
    const second = await inject(`/api/people?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor ?? '')}`)
    assert.deepEqual(second.body.data.items.map((person) => person.displayName), ['Mia Member', 'Oscar Outside'])
    assert.equal(second.body.meta.hasMore, false)
  })
})
