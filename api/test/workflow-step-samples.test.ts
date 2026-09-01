import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'

import {
  WORKFLOW_STEP_SAMPLES_MAX_BYTES,
  getWorkflowTemplateStepSamples,
  recordWorkflowStepSamples,
} from '../src/services/workflow-step-samples.js'

// §5 stepSamples: the sensitive-data store behind the designer's field
// picker. Proves the W0 redaction holds on write AND on read, the quota
// refuses oversize stores, and every read is organization-scoped (the
// route layers the owner check on top).

const SECRET_REF = 'secret_mcp_cafedeadbeef'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient, input: { tainted?: boolean } = {}) => {
  const org = await prisma.organization.create({
    data: { name: `wf-samples ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `wf-${randomUUID()}@example.com` },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: { steps: [{ id: 'fetch', type: 'tool' }] },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      resolvedBindings: input.tainted ? { apiKey: SECRET_REF, channel: '#ops' } : {},
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  return { installation, org, template, user }
}

runDatabaseTest('stepSamples record + serve', async (t) => {
  const prisma = new PrismaClient()
  const { installation, org, template } = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  await t.test('recording persists provenance and serves it back', async () => {
    const runId = randomUUID()
    const result = await recordWorkflowStepSamples(prisma, org.id, {
      stepOutputs: { fetch: { result: { title: 'hello' } } },
      workflowInstallationId: installation.id,
      workflowRunId: runId,
      workflowTemplateId: template.id,
    })
    assert.equal(result, 'recorded')

    const served = await getWorkflowTemplateStepSamples(prisma, org.id, template.id)
    assert.ok(served)
    assert.equal(served.workflowInstallationId, installation.id)
    assert.equal(served.workflowRunId, runId)
    assert.equal(served.templateVersion, 1)
    assert.deepEqual(served.steps, { fetch: { result: { title: 'hello' } } })
  })

  await t.test('a foreign organization cannot read the samples', async () => {
    const foreign = await prisma.organization.create({
      data: { name: `wf-samples-foreign ${randomUUID()}` },
    })
    t.after(async () => {
      await prisma.organization.deleteMany({ where: { id: foreign.id } })
    })

    const served = await getWorkflowTemplateStepSamples(prisma, foreign.id, template.id)
    assert.equal(served, null)
  })

  await t.test('a foreign organization cannot write the samples', async () => {
    const foreign = await prisma.organization.create({
      data: { name: `wf-samples-foreign2 ${randomUUID()}` },
    })
    t.after(async () => {
      await prisma.organization.deleteMany({ where: { id: foreign.id } })
    })

    await assert.rejects(
      recordWorkflowStepSamples(prisma, foreign.id, {
        stepOutputs: {},
        workflowInstallationId: installation.id,
        workflowRunId: randomUUID(),
        workflowTemplateId: template.id,
      }),
      /WORKFLOW_STEP_SAMPLES_INSTALLATION_NOT_FOUND/,
    )
  })

  await t.test('samples are deleted with the template', async () => {
    const row = await prisma.workflowTemplate.findUniqueOrThrow({
      where: { id: template.id },
      select: { stepSamples: true },
    })
    assert.ok(row.stepSamples && Object.keys(row.stepSamples as object).length > 0)
    // The column lives on the template row itself, so the cascade IS the
    // delete — deleting the org removes template and samples together.
    await prisma.workflowTemplate.delete({ where: { id: template.id } })
    const served = await getWorkflowTemplateStepSamples(prisma, org.id, template.id)
    assert.equal(served, null)
  })
})

runDatabaseTest('stepSamples W0 redaction and quota', async (t) => {
  const prisma = new PrismaClient()
  const { installation, org, template } = await seed(prisma, { tainted: true })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  await t.test('a tainted ref in a sample is redacted on write', async () => {
    // Simulates a step output persisted before the boundary existed, or a
    // tool that echoed a binding it received pre-redaction.
    const result = await recordWorkflowStepSamples(prisma, org.id, {
      stepOutputs: {
        fetch: { result: { token: SECRET_REF, channel: '#ops' } },
      },
      workflowInstallationId: installation.id,
      workflowRunId: randomUUID(),
      workflowTemplateId: template.id,
    })
    assert.equal(result, 'recorded')

    const stored = await prisma.workflowTemplate.findUniqueOrThrow({
      where: { id: template.id },
      select: { stepSamples: true },
    })
    assert.equal(JSON.stringify(stored.stepSamples).includes(SECRET_REF), false)
    assert.equal(JSON.stringify(stored.stepSamples).includes(WORKFLOW_SECRET_REDACTION), true)

    const served = await getWorkflowTemplateStepSamples(prisma, org.id, template.id)
    assert.deepEqual(served?.steps, {
      fetch: { result: { channel: '#ops', token: WORKFLOW_SECRET_REDACTION } },
    })
  })

  await t.test('read-side redaction covers a store written before taint existed', async () => {
    // Write directly, bypassing the service's redaction: a store persisted
    // while the binding was still literal, later marked secret by a template
    // edit. The serve path redacts value-shaped refs regardless.
    await prisma.workflowTemplate.update({
      where: { id: template.id },
      data: {
        stepSamples: {
          capturedAt: new Date().toISOString(),
          steps: { fetch: { token: SECRET_REF } },
          templateVersion: 1,
          workflowInstallationId: installation.id,
          workflowRunId: randomUUID(),
        },
      },
    })

    const served = await getWorkflowTemplateStepSamples(prisma, org.id, template.id)
    assert.ok(served)
    assert.equal(JSON.stringify(served.steps).includes(SECRET_REF), false)
  })

  await t.test('the size quota refuses an oversize store', async () => {
    const result = await recordWorkflowStepSamples(prisma, org.id, {
      stepOutputs: {
        fetch: { result: { blob: 'x'.repeat(WORKFLOW_STEP_SAMPLES_MAX_BYTES) } },
      },
      workflowInstallationId: installation.id,
      workflowRunId: randomUUID(),
      workflowTemplateId: template.id,
    })
    assert.equal(result, 'quota_exceeded')
  })

  await t.test('stale samples past the retention window read as absent', async () => {
    await prisma.workflowTemplate.update({
      where: { id: template.id },
      data: {
        stepSamples: {
          capturedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
          steps: { fetch: { old: true } },
          templateVersion: 1,
          workflowInstallationId: installation.id,
          workflowRunId: randomUUID(),
        },
      },
    })

    const served = await getWorkflowTemplateStepSamples(prisma, org.id, template.id)
    assert.equal(served, null)
  })
})
