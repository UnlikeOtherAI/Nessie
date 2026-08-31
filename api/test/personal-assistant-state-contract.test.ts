import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { ensurePersonalAssistantBootstrap } from '../src/services/personal-assistant.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * `loadPersonalAssistantState` hand-assembles its agent object instead of going
 * through `toAgentRecord`, so it drifts from `AgentRecordSchema` silently — the
 * compiler cannot see the gap, because the literal is only checked against the
 * schema at runtime, by `.parse`.
 *
 * That drift reached production on 2026-08-31: the agent-todos work added a
 * required `todosEnabled` to `AgentRecordSchema` and updated `toAgentRecord`,
 * but not this producer, so every `GET /api/personal-assistant` answered
 * `500 ZodError: agent.todosEnabled — expected boolean, received undefined`
 * and the assistant would not open at all.
 *
 * The assertion is therefore the *parse itself*, against a real bootstrapped
 * PA. Any future required field added to the record fails here rather than in
 * front of a person.
 */
dbTest('the personal-assistant state parses its own contract, every required field included', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()

  try {
    await prisma.organization.create({ data: { id: organizationId, name: `pa-contract ${organizationId}` } })
    await prisma.user.create({
      data: { displayName: 'Ada', email: `ada-${userId}@pa-contract.test`, id: userId },
    })
    await prisma.organizationMember.create({
      data: { organizationId, role: 'owner', userId },
    })
    const project = await prisma.project.create({
      data: { name: 'Default Project', organizationId },
    })
    const team = await prisma.team.create({
      data: { name: 'Default Team', projectId: project.id },
    })

    await ensurePersonalAssistantBootstrap(prisma, {
      organizationId,
      projectId: project.id,
      teamId: team.id,
      userId,
    })

    const helpers = createRequestHelpers(prisma)
    const state = await helpers.loadPersonalAssistantState({
      actionContext: {},
      actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId, projectId: project.id, teamId: team.id },
    } as never)

    // A null state would mean the bootstrap did not take, and would let the
    // contract go unchecked — the precondition is stated, not assumed.
    assert.ok(state, 'the bootstrapped assistant must load')
    assert.ok(state.agent, 'the assistant must carry its agent')
    assert.equal(typeof state.agent.todosEnabled, 'boolean')
  } finally {
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})
