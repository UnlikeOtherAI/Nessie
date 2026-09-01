import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { executeWorkflowBuiltinTool } from '../../src/run/tools.js'
import type { WorkflowBuiltinToolRuntimeContext } from '../../src/run/workflow-builtin-tools.js'
import { runDatabaseTest } from './support.js'

// W18 — compare-and-set on state_put, as a complete read→write contract.
// Runs against a real database so the version counter and the writer
// (stepRunId, attempt) identity are the persisted columns, not a mock's idea
// of them. Assertions and cleanup are scoped to this suite's own org.

type Seed = {
  installationId: string
  organizationId: string
  userId: string
  workflowRunId: string
  workflowStepRunId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `wf-cas ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Workflow Owner', email: `wf-cas-${randomUUID()}@example.com` },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: { steps: [] },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const run = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: org.id,
      startedByActorId: user.id,
      startedByActorType: 'user',
    },
  })
  const stepRun = await prisma.workflowStepRun.create({
    data: {
      sequence: 0,
      status: 'running',
      stepKey: 'watch',
      stepType: 'tool_call',
      title: 'watch',
      workflowRunId: run.id,
    },
  })
  return {
    installationId: installation.id,
    organizationId: org.id,
    userId: user.id,
    workflowRunId: run.id,
    workflowStepRunId: stepRun.id,
  }
}

const toolContext = (
  prisma: PrismaClient,
  seedRow: Seed,
  input: { workflowRunAttempt?: number; workflowStepRunId?: string } = {},
): WorkflowBuiltinToolRuntimeContext => ({
  actorContext: {
    actor: { actorId: seedRow.userId, actorType: 'user' },
    actionContext: { purpose: 'test', requestId: randomUUID() },
    tenant: { organizationId: parseOrganizationId(seedRow.organizationId) },
  } as unknown as AuthorizedActionContext,
  ledgerIdentity: null,
  organizationId: seedRow.organizationId,
  prisma,
  workflowInstallationId: seedRow.installationId,
  workflowRunId: seedRow.workflowRunId,
  workflowRunAttempt: input.workflowRunAttempt,
  workflowStepRunId: input.workflowStepRunId ?? seedRow.workflowStepRunId,
})

runDatabaseTest('W18: state_put with a stale expectedVersion fails the write', async (t) => {
  const prisma = new PrismaClient()
  const seedRow = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seedRow.organizationId } })
    await prisma.$disconnect()
  })
  const context = toolContext(prisma, seedRow, { workflowRunAttempt: 1 })

  // The read side hands back the version to compare (v1 after the first write).
  const firstPut = await executeWorkflowBuiltinTool(
    'state_put',
    { key: 'cursor', value: { lastId: 'release-1' } },
    context,
  )
  assert.equal(firstPut.success, true)
  assert.equal(firstPut.output['version'], 1)

  // A concurrent writer moves the key to v2...
  const otherStepRun = await prisma.workflowStepRun.create({
    data: {
      sequence: 1,
      status: 'running',
      stepKey: 'other',
      stepType: 'tool_call',
      title: 'other',
      workflowRunId: seedRow.workflowRunId,
    },
  })
  const secondPut = await executeWorkflowBuiltinTool(
    'state_put',
    { key: 'cursor', value: { lastId: 'release-2' } },
    toolContext(prisma, seedRow, { workflowRunAttempt: 1, workflowStepRunId: otherStepRun.id }),
  )
  assert.equal(secondPut.success, true)
  assert.equal(secondPut.output['version'], 2)

  // ...so the original reader's guarded write at v1 must fail.
  const stalePut = await executeWorkflowBuiltinTool(
    'state_put',
    { expectedVersion: 1, key: 'cursor', value: { lastId: 'release-3' } },
    context,
  )
  assert.equal(stalePut.success, false)
  assert.match(String(stalePut.summary), /conflict/i)

  // The failed CAS did not move the entry.
  const entry = await prisma.workflowStateEntry.findUniqueOrThrow({
    where: {
      workflowInstallationId_key: {
        key: 'cursor',
        workflowInstallationId: seedRow.installationId,
      },
    },
  })
  assert.equal(entry.version, 2)
  assert.deepEqual(entry.value, { lastId: 'release-2' })
})

runDatabaseTest('W18: a same-attempt repeat write with a matching value hash is an idempotent no-op', async (t) => {
  const prisma = new PrismaClient()
  const seedRow = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seedRow.organizationId } })
    await prisma.$disconnect()
  })
  const context = toolContext(prisma, seedRow, { workflowRunAttempt: 1 })

  const firstPut = await executeWorkflowBuiltinTool(
    'state_put',
    { key: 'cursor', value: { lastId: 'release-1' } },
    context,
  )
  assert.equal(firstPut.success, true)
  assert.equal(firstPut.output['version'], 1)

  // The crash-between-write-and-finish case: the same (stepRun, attempt)
  // repeats its guarded write with the same value. This must NOT wedge the
  // watcher on a permanently stale expectedVersion.
  const repeat = await executeWorkflowBuiltinTool(
    'state_put',
    { expectedVersion: 1, key: 'cursor', value: { lastId: 'release-1' } },
    context,
  )
  assert.equal(repeat.success, true)
  assert.equal(repeat.output['idempotent'], true)
  assert.equal(repeat.output['version'], 1)

  const entry = await prisma.workflowStateEntry.findUniqueOrThrow({
    where: {
      workflowInstallationId_key: {
        key: 'cursor',
        workflowInstallationId: seedRow.installationId,
      },
    },
  })
  // No double increment, and the writer identity is the recorded attempt.
  assert.equal(entry.version, 1)
  assert.equal(entry.workflowStepRunId, seedRow.workflowStepRunId)
  assert.equal(entry.writerAttempt, 1)

  // But the same writer carrying DIFFERENT data is not silently swallowed.
  const differentData = await executeWorkflowBuiltinTool(
    'state_put',
    { expectedVersion: 1, key: 'cursor', value: { lastId: 'tampered' } },
    context,
  )
  assert.equal(differentData.success, false)
  assert.match(String(differentData.summary), /conflict/i)
})

runDatabaseTest('W18: state_get and change_detect return the exact version compared', async (t) => {
  const prisma = new PrismaClient()
  const seedRow = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seedRow.organizationId } })
    await prisma.$disconnect()
  })
  const context = toolContext(prisma, seedRow, { workflowRunAttempt: 1 })

  // Absent key: both reads report version 0 — the value a create-style
  // state_put(expectedVersion: 0) compares against.
  const missing = await executeWorkflowBuiltinTool('state_get', { key: 'cursor' }, context)
  assert.equal(missing.success, true)
  assert.equal(missing.output['found'], false)
  assert.equal(missing.output['version'], 0)

  const missingChange = await executeWorkflowBuiltinTool(
    'change_detect',
    { key: 'cursor', value: { lastId: 'release-1' } },
    context,
  )
  assert.equal(missingChange.success, true)
  assert.equal(missingChange.output['version'], 0)
  assert.equal(missingChange.output['changeType'], 'created')

  await executeWorkflowBuiltinTool(
    'state_put',
    { key: 'cursor', value: { lastId: 'release-1' } },
    context,
  )
  await executeWorkflowBuiltinTool(
    'state_put',
    { key: 'cursor', value: { lastId: 'release-2' } },
    context,
  )

  const loaded = await executeWorkflowBuiltinTool('state_get', { key: 'cursor' }, context)
  assert.equal(loaded.success, true)
  assert.equal(loaded.output['found'], true)
  assert.equal(loaded.output['version'], 2)
  assert.deepEqual(loaded.output['value'], { lastId: 'release-2' })

  const detected = await executeWorkflowBuiltinTool(
    'change_detect',
    { key: 'cursor', value: { lastId: 'release-3' } },
    context,
  )
  assert.equal(detected.success, true)
  assert.equal(detected.output['version'], 2)
  assert.equal(detected.output['changed'], true)
  assert.equal(detected.output['changeType'], 'updated')

  // And the read version is accepted back: a new step's guarded write at the
  // exact version the read returned succeeds and bumps to 3. (A repeat from
  // the SAME writer is the W18 idempotent/conflict case, covered above.)
  const followupStepRun = await prisma.workflowStepRun.create({
    data: {
      sequence: 1,
      status: 'running',
      stepKey: 'followup',
      stepType: 'tool_call',
      title: 'followup',
      workflowRunId: seedRow.workflowRunId,
    },
  })
  const guarded = await executeWorkflowBuiltinTool(
    'state_put',
    { expectedVersion: loaded.output['version'], key: 'cursor', value: { lastId: 'release-3' } },
    toolContext(prisma, seedRow, { workflowRunAttempt: 1, workflowStepRunId: followupStepRun.id }),
  )
  assert.equal(guarded.success, true)
  assert.equal(guarded.output['version'], 3)
})
