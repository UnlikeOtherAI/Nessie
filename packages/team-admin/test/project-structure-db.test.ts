import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  createChannelForUser,
  createProjectForUser,
  createTeamForUser,
  listProjectsForUser,
  listTeamsForOrganization,
} from '../src/index.js'

/**
 * The shared project/team writes and the entitlement read behind them.
 *
 * These are the exact functions `POST /api/projects`, `POST /api/teams` and
 * `GET /api/projects` call after the extraction, and the exact functions the
 * `project_create` / `team_create` / `project_list` tools call — so what is
 * asserted here is asserted for both paths at once.
 *
 * Cleanup is scoped to this suite's own organisations: no global delete, no
 * global count assertion.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  memberId: string
  organizationId: string
  otherOrganizationId: string
  otherProjectId: string
  ownerId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `structure-owner-${suffix}@example.test` },
  })
  const member = await prisma.user.create({
    data: { displayName: 'Member', email: `structure-member-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `structure-${suffix}` },
  })
  const otherOrganization = await prisma.organization.create({
    data: { name: `structure-other-${suffix}` },
  })
  const otherProject = await prisma.project.create({
    data: { name: 'Foreign', organizationId: otherOrganization.id },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  return {
    memberId: member.id,
    organizationId: organization.id,
    otherOrganizationId: otherOrganization.id,
    otherProjectId: otherProject.id,
    ownerId: owner.id,
  }
}

const cleanup = async (prisma: PrismaClient, team: Seed): Promise<void> => {
  await prisma.organization.deleteMany({
    where: { id: { in: [team.organizationId, team.otherOrganizationId] } },
  })
  await prisma.user.deleteMany({
    where: { id: { in: [team.memberId, team.ownerId] } },
  })
}

runDatabaseTest('a created project holds its creator and nobody else', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))

  const project = await createProjectForUser(prisma, {
    name: 'Marketing',
    organizationId: team.organizationId,
    userId: team.ownerId,
  })

  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    select: { role: true, userId: true },
  })
  assert.deepEqual(members, [{ role: 'owner', userId: team.ownerId }])
  assert.equal(project.memberCount, 1)
  assert.equal(project.teamCount, 0)

  // The board a clicked project gets, on a project created from chat.
  const columns = await prisma.boardColumn.findMany({
    where: { projectId: project.id },
    orderBy: { position: 'asc' },
    select: { category: true, name: true, organizationId: true },
  })
  assert.deepEqual(columns.map((column) => column.category), [
    'todo',
    'in_progress',
    'review',
    'done',
  ])
  assert.ok(columns.every((column) => column.organizationId === team.organizationId))
})

runDatabaseTest('a project, a team in it, and a channel in that team', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))

  const project = await createProjectForUser(prisma, {
    name: 'Marketing',
    organizationId: team.organizationId,
    userId: team.ownerId,
  })
  const team = await createTeamForUser(prisma, {
    name: 'Campaigns',
    organizationId: team.organizationId,
    projectId: project.id,
    userId: team.ownerId,
  })
  assert.ok(team)
  assert.equal(team.projectId, project.id)

  const teamMembers = await prisma.teamMember.findMany({
    where: { teamId: team.id },
    select: { role: true, userId: true },
  })
  assert.deepEqual(teamMembers, [{ role: 'owner', userId: team.ownerId }])

  const channel = await createChannelForUser(prisma, {
    label: 'Launch plan',
    organizationId: team.organizationId,
    teamId: team.id,
    userId: team.ownerId,
    visibility: 'private',
  })
  assert.ok(channel)
  // The whole point of item 5: the channel really belongs to that project.
  assert.equal(channel.projectId, project.id)
  assert.equal(channel.teamId, team.id)
  assert.equal(channel.visibility, 'private')

  const channelMembers = await prisma.channelMember.findMany({
    where: { channelId: channel.id },
    select: { userId: true },
  })
  assert.deepEqual(channelMembers, [{ userId: team.ownerId }])
})

runDatabaseTest('createTeamForUser refuses a cross-organisation project', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))

  const team = await createTeamForUser(prisma, {
    name: 'Campaigns',
    organizationId: team.organizationId,
    projectId: team.otherProjectId,
    userId: team.ownerId,
  })
  assert.equal(team, null)
  assert.equal(
    await prisma.team.count({ where: { projectId: team.otherProjectId } }),
    0,
  )
})

runDatabaseTest('the project list is scoped by entitlement and by organisation', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))

  const ownerProject = await createProjectForUser(prisma, {
    name: 'Owner only',
    organizationId: team.organizationId,
    userId: team.ownerId,
  })
  const memberProject = await createProjectForUser(prisma, {
    name: 'Member project',
    organizationId: team.organizationId,
    userId: team.memberId,
  })

  const asOwner = await listProjectsForUser(prisma, {
    isOwner: true,
    organizationId: team.organizationId,
    userId: team.ownerId,
  })
  const ownerIds = new Set(asOwner.map((project) => project.id))
  assert.ok(ownerIds.has(ownerProject.id))
  assert.ok(ownerIds.has(memberProject.id))
  assert.ok(!ownerIds.has(team.otherProjectId), 'never another organisation')

  const asMember = await listProjectsForUser(prisma, {
    isOwner: false,
    organizationId: team.organizationId,
    userId: team.memberId,
  })
  assert.deepEqual(asMember.map((project) => project.id), [memberProject.id])

  // Teams narrow to the projects handed in, and never leave the organisation.
  const team = await createTeamForUser(prisma, {
    name: 'Campaigns',
    organizationId: team.organizationId,
    projectId: memberProject.id,
    userId: team.memberId,
  })
  assert.ok(team)
  const memberTeams = await listTeamsForOrganization(prisma, {
    organizationId: team.organizationId,
    projectIds: [memberProject.id],
  })
  assert.deepEqual(memberTeams.map((row) => row.id), [team.id])
  assert.deepEqual(
    await listTeamsForOrganization(prisma, {
      organizationId: team.organizationId,
      projectIds: [ownerProject.id],
    }),
    [],
  )
})
