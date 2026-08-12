import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
} from '../src/contracts/agents.js'
import {
  createAgentRecord,
  updateAgentRecord,
} from '../src/services/agent-management.js'
import { readAgentRunLimits } from '@nessie/workspace-admin'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

test('runLimits contract accepts a partial set of positive integer caps', () => {
  const parsed = UpdateAgentBodySchema.safeParse({
    runLimits: { maxTokens: 250000, maxWallclockMs: 600000 },
  })
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.success ? parsed.data.runLimits : null, {
    maxTokens: 250000,
    maxWallclockMs: 600000,
  })
})

test('runLimits contract accepts an explicit null to clear every limit', () => {
  const parsed = UpdateAgentBodySchema.safeParse({ runLimits: null })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success ? parsed.data.runLimits : undefined, null)
})

test('runLimits contract rejects non-positive, fractional and unknown keys', () => {
  assert.equal(UpdateAgentBodySchema.safeParse({ runLimits: { maxTokens: 0 } }).success, false)
  assert.equal(UpdateAgentBodySchema.safeParse({ runLimits: { maxTokens: -1 } }).success, false)
  assert.equal(UpdateAgentBodySchema.safeParse({ runLimits: { maxTokens: 1.5 } }).success, false)
  assert.equal(
    UpdateAgentBodySchema.safeParse({ runLimits: { maxTokens: 10, maxWidgets: 3 } }).success,
    false,
  )
  assert.equal(
    CreateAgentBodySchema.safeParse({ name: 'A', runLimits: { maxCostCents: '200' } }).success,
    false,
  )
})

test('stored run limits that no longer satisfy the contract read as no limits', () => {
  assert.equal(readAgentRunLimits(null), null)
  assert.equal(readAgentRunLimits({}), null)
  assert.equal(readAgentRunLimits({ maxTokens: -5 }), null)
  assert.deepEqual(readAgentRunLimits({ maxToolCalls: 40 }), { maxToolCalls: 40 })
})

type Seed = { organizationId: string; projectId: string; teamId: string }

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `run-limits ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  return { organizationId: org.id, projectId: project.id, teamId: team.id }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.agent.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

runDatabaseTest('agent runLimits round-trip: set, preserve on unrelated edits, clear', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const created = await createAgentRecord(prisma, {
    name: 'Researcher',
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    role: 'assistant',
    runLimits: { maxIterations: 40, maxTokens: 250000 },
    teamId: seed.teamId,
  })
  assert.deepEqual(created.runLimits, { maxIterations: 40, maxTokens: 250000 })

  // An edit that does not mention runLimits leaves the stored caps alone.
  const renamed = await updateAgentRecord(prisma, created.id, {
    name: 'Researcher II',
    organizationId: seed.organizationId,
  })
  assert.deepEqual(renamed?.runLimits, { maxIterations: 40, maxTokens: 250000 })

  const replaced = await updateAgentRecord(prisma, created.id, {
    organizationId: seed.organizationId,
    runLimits: { maxCostCents: 500 },
  })
  assert.deepEqual(replaced?.runLimits, { maxCostCents: 500 })

  // An explicit null clears every explicit limit (back to the backstop only).
  const cleared = await updateAgentRecord(prisma, created.id, {
    organizationId: seed.organizationId,
    runLimits: null,
  })
  assert.equal(cleared?.runLimits, undefined)
  const row = await prisma.agent.findUnique({
    where: { id: created.id },
    select: { runLimits: true },
  })
  assert.equal(row?.runLimits, null)
})

runDatabaseTest('an agent created without run limits reports none', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const created = await createAgentRecord(prisma, {
    name: 'Default',
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    role: 'assistant',
    teamId: seed.teamId,
  })
  assert.equal(created.runLimits, undefined)
})
