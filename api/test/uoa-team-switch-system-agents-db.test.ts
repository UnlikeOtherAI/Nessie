import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  globalAgentHomeDmKey,
  listAgentsForUser,
  listGlobalAgentBlueprints,
} from '@nessie/team-admin'

import { materializeUoaTeam } from '../src/services/uoa-team-switch.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * A person's first entry into an organisation is not always a login.
 *
 * A team switch, a brand-new team or organisation created in-app, an accepted
 * invitation and an adopted refresh drift all land through `materializeUoaTeam`,
 * and none of them is followed by the login that provisions Nessie's own
 * agents. A person who created a new team found it with no Personal Assistant
 * and no Agent Designer: the rows are per organisation, and nothing had ever
 * written them for the organisation they had just entered. Real rows, because
 * the ensures are three tables deep and a cast fake cannot see the CHECKs
 * that keep a system DM to exactly its member.
 *
 * Cleanup is scoped to this test's own user and organisation.
 */
dbTest('materializing a team in a fresh organisation provisions its system agents', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const uoaSub = `uoa-sub-${suffix}`
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `ws-${suffix}`
  const user = await prisma.user.create({
    data: {
      displayName: 'Switcher',
      email: `switcher-${suffix}@example.test`,
      uoaSub,
    },
  })
  const bootstrapErrors: unknown[] = []

  try {
    await materializeUoaTeam(prisma, {
      identity: {
        displayName: 'Switcher',
        email: user.email,
        externalSubject: uoaSub,
        team: {
          activeOrgId: externalOrgId,
          activeTeamId: externalTeamId,
          teamIds: [externalTeamId],
          teamRoles: { [externalTeamId]: 'owner' },
        },
        uoaTokenVersion: 1,
      },
      onSystemAgentsBootstrapError: (error) => bootstrapErrors.push(error),
      userId: user.id,
    })

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { externalOrgId },
      select: { id: true },
    })
    assert.deepEqual(bootstrapErrors, [])

    // The organisation the switch landed in already holds the Personal
    // Assistant and every registered global agent — the same list the Agents
    // page's Global tab and the DM address book read.
    const agents = await listAgentsForUser(prisma, user.id, organization.id, false, true)
    assert.ok(
      agents.some((agent) => agent.agentKind === 'personal_assistant' && agent.systemManaged),
      'the Personal Assistant exists in the new organisation',
    )
    for (const blueprint of listGlobalAgentBlueprints()) {
      assert.ok(
        agents.some((agent) => agent.systemSlug === blueprint.slug),
        `${blueprint.slug} exists in the new organisation`,
      )
    }

    // And each one is reachable by this person: their own home DM, with them
    // as its only member.
    const paHome = await prisma.channel.findFirst({
      where: { dmKey: `pa:${organization.id}:${user.id}` },
      select: { members: { select: { userId: true } } },
    })
    assert.deepEqual(paHome?.members.map((member) => member.userId), [user.id])
    for (const blueprint of listGlobalAgentBlueprints()) {
      const home = await prisma.channel.findFirst({
        where: {
          dmKey: globalAgentHomeDmKey({
            organizationId: organization.id,
            slug: blueprint.slug,
            userId: user.id,
          }),
        },
        select: { members: { select: { userId: true } } },
      })
      assert.deepEqual(home?.members.map((member) => member.userId), [user.id], blueprint.slug)
    }

    // Idempotent: entering the same organisation again writes nothing new.
    await materializeUoaTeam(prisma, {
      identity: {
        displayName: 'Switcher',
        email: user.email,
        externalSubject: uoaSub,
        team: {
          activeOrgId: externalOrgId,
          activeTeamId: externalTeamId,
          teamIds: [externalTeamId],
          teamRoles: { [externalTeamId]: 'owner' },
        },
        uoaTokenVersion: 2,
      },
      onSystemAgentsBootstrapError: (error) => bootstrapErrors.push(error),
      userId: user.id,
    })
    assert.deepEqual(bootstrapErrors, [])
    const systemAgentCount = await prisma.agent.count({
      where: { organizationId: organization.id, systemManaged: true },
    })
    assert.equal(systemAgentCount, 1 + listGlobalAgentBlueprints().length)
  } finally {
    await prisma.organization.deleteMany({ where: { externalOrgId } })
    await prisma.user.deleteMany({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})
