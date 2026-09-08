import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { createAgentRecord } from '@nessie/team-admin'

import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  createTemporaryContextSession,
  dropTemporaryContextSession,
  listTemporaryContextSessions,
} from '../src/services/capabilities.js'
import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  setAgentToolPolicyKeys,
} from '../src/services/agent-tool-policy.js'
import {
  createGrant,
  deleteGrant,
  TOOL_GRANT_ERROR_CODES,
  ToolGrantError,
} from '../src/services/tool-grants.js'
import {
  createUserStatus,
  createUserStatusRule,
  UserStatusServiceError,
} from '../src/services/user-statuses.js'

/**
 * A private agent ID can occur as a nested reference in grants, policies,
 * status rules, and temporary-session scopes. These are real Postgres checks:
 * an organisation owner must not turn a known private ID into access.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  orgId: string
  outsider: string
  owner: string
  privateAgentId: string
  privateRunId: string
  privateThreadId: string
  sharedAgentId: string
  sharedRunId: string
  sharedThreadId: string
  toolId: string
}

const actor = (organizationId: string, userId: string): AuthorizedActionContext => ({
  actionContext: { requestId: randomUUID() },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId },
})

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID().slice(0, 8)
  const org = await prisma.organization.create({ data: { name: `private-ref-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const [owner, outsider] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Private owner', email: `private-owner-${suffix}@test.local` } }),
    prisma.user.create({ data: { displayName: 'Organisation owner', email: `org-owner-${suffix}@test.local` } }),
  ])
  await prisma.organizationMember.createMany({
    data: [owner, outsider].map((user) => ({ organizationId: org.id, role: 'owner', userId: user.id })),
  })
  const [privateChannel, sharedChannel] = await Promise.all([
    prisma.channel.create({
      data: {
        label: `private-${suffix}`, organizationId: org.id, projectId: project.id,
        slug: `private-${suffix}`, teamId: team.id, visibility: 'private',
      },
    }),
    prisma.channel.create({
      data: {
        label: `shared-${suffix}`, organizationId: org.id, projectId: project.id,
        slug: `shared-${suffix}`, teamId: team.id, visibility: 'public',
      },
    }),
  ])
  await prisma.channelMember.create({ data: { channelId: privateChannel.id, userId: owner.id } })
  const [privateThread, sharedThread] = await Promise.all([
    prisma.thread.create({ data: { channelId: privateChannel.id } }),
    prisma.thread.create({ data: { channelId: sharedChannel.id } }),
  ])
  const privateAgent = await createAgentRecord(prisma, {
    name: `private-agent-${suffix}`, organizationId: org.id, ownerUserId: owner.id,
    projectId: project.id, role: 'assistant', teamId: team.id, visibility: 'private',
  })
  const sharedAgent = await createAgentRecord(prisma, {
    name: `shared-agent-${suffix}`, organizationId: org.id, projectId: project.id,
    role: 'assistant', teamId: team.id,
  })
  await prisma.agentBinding.create({ data: { agentId: sharedAgent.id, channelId: sharedChannel.id } })
  const [privateRun, sharedRun] = await Promise.all([
    prisma.run.create({ data: { agentId: privateAgent.id, status: 'completed', threadId: privateThread.id } }),
    prisma.run.create({ data: { agentId: sharedAgent.id, status: 'completed', threadId: sharedThread.id } }),
  ])
  const tool = await prisma.toolRegistryEntry.create({
    data: {
      description: 'private reference test tool', label: `tool-${suffix}`, organizationId: org.id,
      overview: 'private reference test tool', scopeKey: `private-ref-${suffix}`, toolId: `private_ref_${suffix}`,
    },
  })
  return {
    orgId: org.id, outsider: outsider.id, owner: owner.id, privateAgentId: privateAgent.id,
    privateRunId: privateRun.id, privateThreadId: privateThread.id, sharedAgentId: sharedAgent.id,
    sharedRunId: sharedRun.id, sharedThreadId: sharedThread.id, toolId: tool.id,
  }
}

const cleanup = async (prisma: PrismaClient, orgId: string): Promise<void> => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined)
}

const withSeed = async (run: (prisma: PrismaClient, s: Seed) => Promise<void>) => {
  const prisma = new PrismaClient()
  let s: Seed | undefined
  try {
    s = await seed(prisma)
    await run(prisma, s)
  } finally {
    if (s) await cleanup(prisma, s.orgId)
    await prisma.$disconnect()
  }
}

dbTest('tool grants and policy mutations refuse another owner private agent but allow owner and shared', async () => {
  await withSeed(async (prisma, s) => {
    await assert.rejects(
      () => createGrant(prisma, {
        actorUserId: s.outsider, agentId: s.privateAgentId, organizationId: s.orgId,
        toolRegistryEntryId: s.toolId,
      }),
      (error: unknown) => error instanceof ToolGrantError
        && error.code === TOOL_GRANT_ERROR_CODES.AGENT_NOT_FOUND,
    )
    const ownerGrant = await createGrant(prisma, {
      actorUserId: s.owner, agentId: s.privateAgentId, organizationId: s.orgId,
      toolRegistryEntryId: s.toolId,
    })
    const sharedGrant = await createGrant(prisma, {
      actorUserId: s.outsider, agentId: s.sharedAgentId, organizationId: s.orgId,
      toolRegistryEntryId: s.toolId,
    })
    assert.equal(await deleteGrant(prisma, s.orgId, s.toolId, ownerGrant.id, s.outsider), false)
    assert.equal(await deleteGrant(prisma, s.orgId, s.toolId, ownerGrant.id, s.owner), true)
    assert.equal(await deleteGrant(prisma, s.orgId, s.toolId, sharedGrant.id, s.outsider), true)

    await assert.rejects(
      () => setAgentToolPolicyKeys(prisma, {
        actorUserId: s.outsider, agentId: s.privateAgentId, enabled: true,
        organizationId: s.orgId, policyKeys: ['calendar.read'],
      }),
      (error: unknown) => error instanceof AgentToolPolicyError
        && error.code === AGENT_TOOL_POLICY_ERROR_CODES.AGENT_NOT_FOUND,
    )
    const ownerPolicy = await setAgentToolPolicyKeys(prisma, {
      actorUserId: s.owner, agentId: s.privateAgentId, enabled: true,
      organizationId: s.orgId, policyKeys: ['calendar.read'],
    })
    const sharedPolicy = await setAgentToolPolicyKeys(prisma, {
      actorUserId: s.outsider, agentId: s.sharedAgentId, enabled: true,
      organizationId: s.orgId, policyKeys: ['calendar.read'],
    })
    assert.equal(ownerPolicy.toolPolicy['calendar.read'], true)
    assert.equal(sharedPolicy.toolPolicy['calendar.read'], true)
  })
})

dbTest('status rules reject another owner private agent and allow owner and shared references', async () => {
  await withSeed(async (prisma, s) => {
    const status = await createUserStatus(prisma, { organizationId: s.orgId, userId: s.outsider }, {
      agentEnabled: true, label: 'Away',
    })
    const rule = { instructions: 'Reply with availability.', scope: 'fallback' as const }
    await assert.rejects(
      () => createUserStatusRule(prisma, { organizationId: s.orgId, userId: s.outsider }, status.id, {
        ...rule, agentId: s.privateAgentId,
      }),
      (error: unknown) => error instanceof UserStatusServiceError && error.code === 'AGENT_NOT_FOUND',
    )
    const ownerStatus = await createUserStatus(prisma, { organizationId: s.orgId, userId: s.owner }, {
      agentEnabled: true, label: 'Owner away',
    })
    const ownerRule = await createUserStatusRule(prisma, { organizationId: s.orgId, userId: s.owner }, ownerStatus.id, {
      ...rule, agentId: s.privateAgentId,
    })
    const sharedRule = await createUserStatusRule(prisma, { organizationId: s.orgId, userId: s.outsider }, status.id, {
      ...rule, agentId: s.sharedAgentId,
    })
    assert.equal(ownerRule.rules[0]?.agentId, s.privateAgentId)
    assert.equal(sharedRule.rules[0]?.agentId, s.sharedAgentId)
  })
})

dbTest('capability scopes deny private agent, run, and thread; lists and drops enforce the same filter', async () => {
  await withSeed(async (prisma, s) => {
    const outsider = actor(s.orgId, s.outsider)
    const owner = actor(s.orgId, s.owner)
    for (const [input, code] of [
      [{ agentId: s.privateAgentId, toolIds: [] }, CAPABILITY_ERROR_CODES.AGENT_NOT_FOUND],
      [{ runId: s.privateRunId, toolIds: [] }, CAPABILITY_ERROR_CODES.RUN_NOT_FOUND],
      [{ threadId: s.privateThreadId, toolIds: [] }, CAPABILITY_ERROR_CODES.THREAD_NOT_FOUND],
    ] as const) {
      await assert.rejects(
        () => createTemporaryContextSession(prisma, outsider, input),
        (error: unknown) => error instanceof CapabilityError && error.code === code,
      )
    }
    const privateSession = await createTemporaryContextSession(prisma, owner, {
      agentId: s.privateAgentId, toolIds: [],
    })
    const sharedSession = await createTemporaryContextSession(prisma, outsider, {
      runId: s.sharedRunId, toolIds: [],
    })
    const sharedThreadSession = await createTemporaryContextSession(prisma, outsider, {
      threadId: s.sharedThreadId, toolIds: [],
    })
    const outsiderSessions = await listTemporaryContextSessions(prisma, outsider, {})
    assert.deepEqual(
      outsiderSessions.map((session) => session.id).sort(),
      [sharedSession.id, sharedThreadSession.id].sort(),
    )
    assert.equal(await dropTemporaryContextSession(prisma, outsider, privateSession.id), null)
    assert.ok(await dropTemporaryContextSession(prisma, owner, privateSession.id))
    assert.ok(await dropTemporaryContextSession(prisma, outsider, sharedSession.id))
  })
})
