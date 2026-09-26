import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  AGENT_DESIGNER_BLUEPRINT,
  createChannelForUser,
  deleteProject,
  ensureGlobalAgentBootstrap,
  globalAgentHomeDmKey,
  STANDALONE_CHANNEL_TEAM_NAME,
} from '@nessie/team-admin'

import { listChannelsForUser } from '../src/services/channels.js'
import { ensurePersonalAssistantBootstrap } from '../src/services/personal-assistant.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * Where the system teams live, and what that protects.
 *
 * Every person's Personal Assistant DM and global-agent home DM hang from a
 * hidden system team. Those teams used to be created under the project of
 * whichever user team seeded them first, so deleting that project — a local
 * install's first team, say — soft-deleted every member's assistant and Agent
 * Designer conversation with it, and the bootstrap, which cleared only
 * `archivedAt`, never brought them back. They now hang from the organisation's
 * channel-root project, which `deleteProject` refuses. Real rows throughout:
 * the failure was three tables deep and a fake cannot see the soft delete.
 *
 * Cleanup is scoped to each test's own organisation and user.
 */

type Seed = {
  organizationId: string
  prisma: PrismaClient
  projectId: string
  teamId: string
  userId: string
}

const seed = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `${label}-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `${label}-${suffix}` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `${label} first project`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `${label} first team`, projectId: project.id },
  })
  await prisma.teamMember.create({
    data: { role: 'owner', teamId: team.id, userId: user.id },
  })
  return { organizationId: organization.id, prisma, projectId: project.id, teamId: team.id, userId: user.id }
}

const teardown = async (value: Seed): Promise<void> => {
  await value.prisma.organization.deleteMany({ where: { id: value.organizationId } })
  await value.prisma.user.deleteMany({ where: { id: value.userId } })
  await value.prisma.$disconnect()
}

const bootstrapBoth = async (value: Seed) => {
  const assistant = await ensurePersonalAssistantBootstrap(value.prisma, {
    organizationId: value.organizationId,
    userId: value.userId,
  })
  const designer = await ensureGlobalAgentBootstrap(value.prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: value.organizationId,
    userId: value.userId,
  })
  return { assistant, designer }
}

const systemDms = async (value: Seed) =>
  value.prisma.channel.findMany({
    where: {
      organizationId: value.organizationId,
      systemChannelType: { in: ['personal_assistant', 'system_agent'] },
    },
    select: {
      archivedAt: true,
      deletedAt: true,
      dmKey: true,
      project: { select: { channelRoot: true } },
      team: { select: { name: true, project: { select: { channelRoot: true } } } },
    },
    orderBy: { dmKey: 'asc' },
  })

dbTest('system teams hang from the channel root, and deleting the first project leaves the DMs', async () => {
  const value = await seed('system-teams-root')
  try {
    const { assistant, designer } = await bootstrapBoth(value)

    // Both teams, and both DMs, under the organisation's undeletable container.
    for (const dm of await systemDms(value)) {
      assert.equal(dm.project.channelRoot, true, dm.dmKey ?? '')
      assert.equal(dm.team.project.channelRoot, true, dm.dmKey ?? '')
    }

    // The seed project — the user's own — is deletable, and its deletion is the
    // path that used to take every system DM with it.
    assert.deepEqual(
      await deleteProject(value.prisma, {
        actorUserId: value.userId,
        organizationId: value.organizationId,
        projectId: value.projectId,
      }),
      { kind: 'deleted' },
    )

    const listed = await listChannelsForUser(value.prisma, value.userId, value.organizationId)
    const listedIds = new Set(listed.map((channel) => channel.id))
    assert.ok(listedIds.has(assistant.channelId), 'the Personal Assistant DM still lists')
    assert.ok(listedIds.has(designer.channelId), 'the Agent Designer DM still lists')
    for (const dm of await systemDms(value)) {
      assert.equal(dm.deletedAt, null, dm.dmKey ?? '')
      assert.equal(dm.archivedAt, null, dm.dmKey ?? '')
    }
  } finally {
    await teardown(value)
  }
})

dbTest('a standalone channel still lands in the root\'s own team beside the system teams', async () => {
  const value = await seed('system-teams-standalone')
  try {
    // The Personal Assistant's team is created under the root FIRST, so any
    // "a system-managed team under the root" lookup would find it before the
    // root's own team.
    await bootstrapBoth(value)

    const channel = await createChannelForUser(value.prisma, {
      label: `shared-${randomUUID().slice(0, 8)}`,
      organizationId: value.organizationId,
      scope: 'standalone',
      userId: value.userId,
      visibility: 'public',
    })
    assert.ok(channel)
    const placed = await value.prisma.channel.findUniqueOrThrow({
      where: { id: channel.id },
      select: { team: { select: { name: true, project: { select: { channelRoot: true } } } } },
    })
    assert.equal(placed.team.name, STANDALONE_CHANNEL_TEAM_NAME)
    assert.equal(placed.team.project.channelRoot, true)

    // And exactly one root project: a root whose own team was found by name
    // is not mistaken for a missing root.
    assert.equal(
      await value.prisma.project.count({
        where: { channelRoot: true, organizationId: value.organizationId },
      }),
      1,
    )
  } finally {
    await teardown(value)
  }
})

/**
 * The layout the migration and the ensure paths both have to leave behind:
 * system teams under a user's project, with a DM that project's deletion took.
 */
const seedLegacyLayout = async (value: Seed) => {
  const now = new Date()
  const paTeam = await value.prisma.team.create({
    data: { name: 'Personal Assistant System', projectId: value.projectId, systemManaged: true },
  })
  const paDm = await value.prisma.channel.create({
    data: {
      archivedAt: now,
      deletedAt: now,
      dmKey: `pa:${value.organizationId}:${value.userId}`,
      label: 'Personal Assistant',
      members: { create: { userId: value.userId } },
      organizationId: value.organizationId,
      projectId: value.projectId,
      systemChannelType: 'personal_assistant',
      teamId: paTeam.id,
      type: 'dm',
      visibility: 'private',
    },
  })
  const designerTeam = await value.prisma.team.create({
    data: { name: 'Global Agent System', projectId: value.projectId, systemManaged: true },
  })
  const designerDm = await value.prisma.channel.create({
    data: {
      archivedAt: now,
      deletedAt: now,
      dmKey: globalAgentHomeDmKey({
        organizationId: value.organizationId,
        slug: AGENT_DESIGNER_BLUEPRINT.slug,
        userId: value.userId,
      }),
      label: AGENT_DESIGNER_BLUEPRINT.name,
      members: { create: { role: 'owner', userId: value.userId } },
      organizationId: value.organizationId,
      projectId: value.projectId,
      systemChannelType: 'system_agent',
      teamId: designerTeam.id,
      type: 'dm',
      visibility: 'private',
    },
  })
  return { designerDm, designerTeam, paDm, paTeam }
}

dbTest('the next bootstrap moves a legacy system team under the root and heals its DM', async () => {
  const value = await seed('system-teams-legacy')
  try {
    const legacy = await seedLegacyLayout(value)
    const { assistant, designer } = await bootstrapBoth(value)

    // The same rows, not new ones — moved, and no longer deleted.
    assert.equal(assistant.channelId, legacy.paDm.id)
    assert.equal(designer.channelId, legacy.designerDm.id)
    for (const teamId of [legacy.paTeam.id, legacy.designerTeam.id]) {
      const team = await value.prisma.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { project: { select: { channelRoot: true } } },
      })
      assert.equal(team.project.channelRoot, true)
    }
    for (const dm of await systemDms(value)) {
      assert.equal(dm.project.channelRoot, true, dm.dmKey ?? '')
      assert.equal(dm.deletedAt, null, dm.dmKey ?? '')
      assert.equal(dm.archivedAt, null, dm.dmKey ?? '')
    }
  } finally {
    await teardown(value)
  }
})

dbTest('the migration moves the legacy rows and restores the DMs a deletion took', async () => {
  const value = await seed('system-teams-migration')
  try {
    const legacy = await seedLegacyLayout(value)
    // No root yet: this organisation predates the shared-channel root too.
    assert.equal(
      await value.prisma.project.count({ where: { channelRoot: true, organizationId: value.organizationId } }),
      0,
    )

    // The migration's own statements, applied to these rows exactly as
    // `prisma migrate deploy` applies them to a deployment's — minus its
    // `LOCK TABLE`, which is the deployment's blue-green fence: held here it
    // stalls every other suite writing projects, teams or channels in the
    // shared test database until this transaction ends, and deadlocks some.
    const sql = await readFile(
      new URL('../prisma/migrations/20260926170000_system_teams_under_channel_root/migration.sql', import.meta.url),
      'utf8',
    )
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0 && !/^LOCK TABLE/i.test(statement))
    // Without that lock the replay races the rest of the shared database: its
    // first statement backfills a root project for *every* organisation still
    // lacking one, and another suite deleting its own organisation between
    // that statement's read and its insert fails the foreign key (23503). The
    // deployment's lock is exactly what excludes that; here a fresh attempt
    // simply reads the organisations again.
    const isForeignKeyRace = (error: unknown): boolean =>
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.meta as { code?: unknown } | undefined)?.code === '23503'
    for (let attempt = 1; ; attempt += 1) {
      try {
        await value.prisma.$transaction(async (tx) => {
          for (const statement of statements) {
            await tx.$executeRaw(Prisma.raw(statement))
          }
        })
        break
      } catch (error) {
        if (attempt >= 3 || !isForeignKeyRace(error)) throw error
      }
    }

    const root = await value.prisma.project.findFirstOrThrow({
      where: { channelRoot: true, organizationId: value.organizationId },
      select: { id: true, teams: { select: { name: true, systemManaged: true } } },
    })
    assert.deepEqual(
      root.teams.map((team) => team.name).sort(),
      ['Global Agent System', 'Personal Assistant System', STANDALONE_CHANNEL_TEAM_NAME],
    )
    assert.ok(root.teams.every((team) => team.systemManaged))
    for (const channelId of [legacy.paDm.id, legacy.designerDm.id]) {
      const dm = await value.prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
        select: { archivedAt: true, deletedAt: true, projectId: true },
      })
      assert.equal(dm.projectId, root.id)
      assert.equal(dm.deletedAt, null)
      assert.equal(dm.archivedAt, null)
    }
    // The user's own project and team are untouched.
    const seedTeam = await value.prisma.team.findUniqueOrThrow({
      where: { id: value.teamId },
      select: { projectId: true },
    })
    assert.equal(seedTeam.projectId, value.projectId)
  } finally {
    await teardown(value)
  }
})
