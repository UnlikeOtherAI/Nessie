import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import {
  AGENT_DESIGNER_BLUEPRINT,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'

import {
  resolveDelegatedRequesterUserId,
  resolveIdentityDelegatedToolIds,
  runDelegatesToRequestingPerson,
} from '../../src/run/delegated-identity.js'
import { authorizeToolCall, resolveAgentTools } from '../../src/run/tool-policy.js'
import { runDatabaseTest } from './support.js'

/**
 * The D3 gate against the rows bootstrap actually writes.
 *
 * The gate itself is pure and unit-tested; what a fake cannot prove is that the
 * `systemSlug`, `systemChannelType` and `dmKey` the bootstrap commits are the
 * exact shapes the predicate matches on. A drift in any of the three would fail
 * OPEN in the ordinary direction (identity tools silently withheld) and could
 * fail closed in the dangerous one, and neither shows up in a unit test that
 * hand-builds the facts.
 *
 * Cleanup is scoped to this test's own organisation — no global delete, no
 * global count assertion.
 */

const IDENTITY_TOOL = 'agent_create'
const enabled = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresExplicitGrant !== true)
    .map((tool) => tool.id),
)

runDatabaseTest('the bootstrapped Designer wields identity tools in its home DM only', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `gagent-identity-${suffix}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Designer user', email: `${suffix}@test.local` },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: user.id } })
    await prisma.$disconnect()
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `gagent-identity-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `gagent-identity-team-${suffix}`, projectId: project.id },
  })

  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
  })

  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: bootstrap.agentId },
    select: { agentKind: true, systemSlug: true, toolPolicy: true },
  })
  const home = await prisma.channel.findUniqueOrThrow({
    where: { id: bootstrap.channelId },
    select: { dmKey: true, organizationId: true, systemChannelType: true },
  })

  const facts = {
    agentKind: agent.agentKind as 'shared',
    dmKey: home.dmKey,
    organizationId: home.organizationId,
    systemChannelType: home.systemChannelType,
    systemSlug: agent.systemSlug,
  }
  const requester = resolveDelegatedRequesterUserId({
    actorId: user.id,
    actorType: 'user',
    effectiveUserId: user.id,
    interactive: true,
  })

  assert.equal(requester, user.id)
  assert.equal(runDelegatesToRequestingPerson(facts), true)

  const admitted = resolveIdentityDelegatedToolIds(facts, requester)
  assert.deepEqual(
    [...admitted].sort(),
    [...AGENT_DESIGNER_BLUEPRINT.identityToolIds].sort(),
  )

  const policy = agent.toolPolicy as Record<string, boolean> | null
  assert.deepEqual(
    authorizeToolCall(
      IDENTITY_TOOL,
      enabled,
      BUILTIN_TOOL_DEFINITIONS,
      policy,
      null,
      facts.agentKind,
      { identityToolIds: admitted },
    ),
    { allowed: true },
  )

  // Unattended: the same row, the same DM, no live human requester.
  assert.equal(resolveIdentityDelegatedToolIds(facts, null).size, 0)

  // An ordinary channel in the same organisation: the toolset must OMIT the
  // identity tools, not offer and then deny them.
  const elsewhere = await prisma.channel.create({
    data: {
      label: 'Design chat',
      organizationId: organization.id,
      projectId: project.id,
      slug: `design-chat-${suffix}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const elsewhereFacts = {
    ...facts,
    dmKey: elsewhere.dmKey,
    systemChannelType: elsewhere.systemChannelType,
  }
  assert.equal(runDelegatesToRequestingPerson(elsewhereFacts), false)

  const offered = resolveAgentTools(
    enabled,
    BUILTIN_TOOL_DEFINITIONS,
    policy,
    null,
    facts.agentKind,
    {
      identityToolIds: resolveIdentityDelegatedToolIds(elsewhereFacts, requester),
      inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length,
    },
  )
  for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
    assert.equal(offered.allowedIds.has(toolId), false, `${toolId} must not be allowed`)
    assert.ok(
      !offered.descriptors.some((descriptor) => descriptor.toolName === toolId),
      `${toolId} must not appear in the schema array`,
    )
  }
})
