import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { parseOrganizationId } from '@nessie/schemas'

import { getWorkflowRun } from '../src/services/workflow-runs.js'
import {
  installWorkflowTemplate,
  listWorkflowInstallations,
  updateWorkflowInstallation,
} from '../src/services/workflow-templates.js'
import { WorkflowSecretWriteError } from '../src/services/workflow-validation.js'

// W0 — the redaction boundary. A reference binding is declared per key in the
// template's `bindingSchema`; only server-minted `secret_*` refs may persist
// there, and the tainted values are redacted at every sink. These tests prove
// sinks 1 (API responses) and 4 (persisted step artifacts), plus the write
// gate itself.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const SECRET_REF = 'secret_mcp_deadbeefcafe'

const GRAPH = {
  steps: [
    {
      id: 'first',
      input: { toolName: 'state_get', key: 'k' },
      title: 'First',
      type: 'tool',
    },
  ],
}

const seedWorkspace = async (
  prisma: PrismaClient,
  bindingSchema: Record<string, unknown>,
) => {
  const org = await prisma.organization.create({
    data: { name: `wf-secrets ${randomUUID()}` },
  })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `wf-sec-${randomUUID()}@example.com` },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      bindingSchema,
      createdByActorId: owner.id,
      createdByActorType: 'user',
      graphJson: GRAPH,
      name: 'wf',
      organizationId: org.id,
    },
  })
  const context: AuthorizedActionContext = {
    actor: { actorId: owner.id, actorType: 'user' },
    tenant: { organizationId: parseOrganizationId(org.id) },
    actionContext: { requestId: randomUUID() },
  }
  return { context, organizationId: org.id, templateId: template.id }
}

const seedRunWithTaintedStepInput = async (
  prisma: PrismaClient,
  input: { organizationId: string; templateId: string; installationId: string },
) => {
  // Simulates a pre-boundary row: the tainted ref already landed on the
  // persisted step input (the §5 sample) and the run output.
  const run = await prisma.workflowRun.create({
    data: {
      input: { seeded: true },
      installationId: input.installationId,
      organizationId: input.organizationId,
      output: { leaked: SECRET_REF, status: 'ok' },
      startedByActorId: randomUUID(),
      startedByActorType: 'service',
      status: 'completed',
    },
  })
  await prisma.workflowStepRun.create({
    data: {
      input: { apiKey: SECRET_REF, toolName: 'http_fetch' },
      sequence: 0,
      status: 'completed',
      stepKey: 'first',
      stepType: 'tool_call',
      title: 'First',
      workflowRunId: run.id,
    },
  })
  return run
}

runDatabaseTest('W0 write gate: plaintext in a reference binding is rejected', async () => {
  const prisma = new PrismaClient()
  try {
    const seed = await seedWorkspace(prisma, {
      apiKey: { kind: 'reference' },
      region: { kind: 'literal' },
    })

    await assert.rejects(
      installWorkflowTemplate(prisma, seed.context, seed.templateId, {
        resolvedBindings: { apiKey: 'sk-live-plaintext', region: 'eu' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowSecretWriteError)
        assert.ok(
          error.violations.some((violation) =>
            violation.path === 'resolvedBindings.apiKey'),
        )
        return true
      },
    )

    // A caller-chosen ref in a literal binding or in config is rejected too.
    await assert.rejects(
      installWorkflowTemplate(prisma, seed.context, seed.templateId, {
        config: { token: SECRET_REF },
        resolvedBindings: { region: 'eu' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowSecretWriteError)
        assert.ok(
          error.violations.some((violation) => violation.path.startsWith('config')),
        )
        return true
      },
    )

    // The update path enforces the same gate.
    const installation = await installWorkflowTemplate(
      prisma,
      seed.context,
      seed.templateId,
      { resolvedBindings: { region: 'eu' } },
    )
    assert.ok(installation)
    await assert.rejects(
      updateWorkflowInstallation(prisma, seed.context, installation.id, {
        resolvedBindings: { apiKey: 'another-plaintext-value' },
      }),
      (error: unknown) => error instanceof WorkflowSecretWriteError,
    )
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest('W0 sink 1: API responses redact reference bindings', async () => {
  const prisma = new PrismaClient()
  try {
    const seed = await seedWorkspace(prisma, {
      apiKey: { kind: 'reference' },
      region: 'literal',
    })

    const installation = await installWorkflowTemplate(
      prisma,
      seed.context,
      seed.templateId,
      {
        config: { note: 'kept' },
        resolvedBindings: { apiKey: SECRET_REF, region: 'eu-west' },
      },
    )
    assert.ok(installation)

    const serialized = JSON.stringify(installation)
    assert.equal(serialized.includes(SECRET_REF), false)
    assert.equal(installation.resolvedBindings['apiKey'], WORKFLOW_SECRET_REDACTION)
    assert.equal(installation.resolvedBindings['region'], 'eu-west')
    assert.equal(installation.config['note'], 'kept')

    const page = await listWorkflowInstallations(prisma, seed.organizationId)
    const listed = page.items.find((item) => item.id === installation.id)
    assert.ok(listed)
    assert.equal(JSON.stringify(listed).includes(SECRET_REF), false)
    assert.equal(listed.resolvedBindings['apiKey'], WORKFLOW_SECRET_REDACTION)
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest(
  'W0 sinks 1+4: run detail redacts persisted tainted step artifacts and run JSON',
  async () => {
    const prisma = new PrismaClient()
    try {
      const seed = await seedWorkspace(prisma, {
        apiKey: { kind: 'reference' },
      })
      const installation = await installWorkflowTemplate(
        prisma,
        seed.context,
        seed.templateId,
        { resolvedBindings: { apiKey: SECRET_REF } },
      )
      assert.ok(installation)

      const run = await seedRunWithTaintedStepInput(prisma, {
        installationId: installation.id,
        organizationId: seed.organizationId,
        templateId: seed.templateId,
      })

      const detail = await getWorkflowRun(prisma, seed.organizationId, run.id)
      assert.ok(detail)
      const serialized = JSON.stringify(detail)
      assert.equal(serialized.includes(SECRET_REF), false)
      assert.equal(
        (detail.steps[0]?.input as Record<string, unknown>)['apiKey'],
        WORKFLOW_SECRET_REDACTION,
      )
      assert.equal(
        (detail.steps[0]?.input as Record<string, unknown>)['toolName'],
        'http_fetch',
      )
      assert.equal(
        (detail.run.output as Record<string, unknown>)['leaked'],
        WORKFLOW_SECRET_REDACTION,
      )
      assert.equal(
        (detail.run.output as Record<string, unknown>)['status'],
        'ok',
      )
    } finally {
      await prisma.$disconnect()
    }
  },
)
