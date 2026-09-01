import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'
import { parseOrganizationId } from '@nessie/schemas'

import { executeWorkflowRun } from '../../src/control/workflows.js'
import { runDatabaseTest } from './support.js'

// W17: the deterministic `transform` step end-to-end against the real
// executor — reshape an upstream step's output, a downstream step consumes
// it, the inline `jmespath:` form works, and the W0 sink holds: a tainted
// binding is redacted from the expression document and never lands in the
// persisted step output. Every assertion is scoped to this file's own seed;
// the only queue jobs these paths write are the W3 terminal events, cleaned
// up by workflowRunId like the sibling suites.

type Seed = {
  channelId: string
  installationId: string
  organizationId: string
  userId: string
}

const SECRET_REF = 'secret_mcp_cafedeadbeef'

const seedInstallation = async (
  prisma: PrismaClient,
  input: { resolvedBindings?: Record<string, unknown> } = {},
): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `wf-xform ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Workflow Owner', email: `wf-${randomUUID()}@example.com` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'ops',
      slug: `ops-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
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
      channelId: channel.id,
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      resolvedBindings: input.resolvedBindings ?? {},
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  return {
    channelId: channel.id,
    installationId: installation.id,
    organizationId: org.id,
    userId: user.id,
  }
}

const seedRun = async (
  prisma: PrismaClient,
  seed: Seed,
  input: {
    actorType?: 'service' | 'user'
    graph: Record<string, unknown>
    workflowInput?: Record<string, unknown>
  },
) =>
  prisma.workflowRun.create({
    data: {
      graphSnapshot: input.graph,
      installationId: seed.installationId,
      input: input.workflowInput ?? {},
      organizationId: seed.organizationId,
      startedByActorId: input.actorType === 'service' ? seed.installationId : seed.userId,
      startedByActorType: input.actorType ?? 'user',
    },
  })

// The executor re-derives its context from the run's durable origin; the
// caller must carry the same actor/scope to pass the mismatch guard (the
// W15/W16 suite's pattern).
const executionContext = (
  seed: Seed,
  run: { startedByActorId: string; startedByActorType: string },
) => ({
  actorContext: {
    actor: {
      actorId: run.startedByActorId,
      actorType: run.startedByActorType as 'service' | 'user',
      roles: ['system'],
    },
    actionContext: { purpose: 'test', requestId: randomUUID() },
    tenant: { organizationId: parseOrganizationId(seed.organizationId) },
  },
  ledgerIdentity: null,
})

const cleanup = async (prisma: PrismaClient, seeds: Seed[], runIds: string[]) => {
  for (const runId of runIds) {
    await prisma.$executeRaw`
      DELETE FROM queue_jobs
      WHERE topic = 'trigger.event.dispatch'
        AND payload->'payload'->>'workflowRunId' = ${runId}
    `.catch(() => undefined)
  }
  await prisma.organization.deleteMany({
    where: { id: { in: seeds.map((seed) => seed.organizationId) } },
  })
}

const stepRunsOf = (prisma: PrismaClient, workflowRunId: string) =>
  prisma.workflowStepRun.findMany({
    orderBy: { sequence: 'asc' },
    where: { workflowRunId },
  })

// A deterministic upstream producer: state_put returns the value it wrote
// as its result, so it doubles as a no-LLM fixture step.
const producerStep = (value: Record<string, unknown>) => ({
  id: 'fetch',
  input: { key: `k-${randomUUID()}`, toolName: 'state_put', value },
  title: 'Fetch',
  type: 'tool',
})

runDatabaseTest('W17: a transform reshapes an upstream output and a downstream step consumes it', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      producerStep({
        body: {
          releases: [
            { tag_name: 'v1.2.3', html_url: 'https://example.com/release/1' },
            { tag_name: 'v1.2.2', html_url: 'https://example.com/release/0' },
          ],
        },
      }),
      {
        id: 'shape',
        input: {
          expression: 'result.value.body.releases[0].{tag: tag_name, url: html_url}',
          source: '{{ steps.fetch.output }}',
        },
        title: 'Shape',
        type: 'transform',
      },
      {
        id: 'announce',
        input: {
          body: 'Shipped {{ steps.shape.output.result.tag }} — {{ steps.shape.output.result.url }}',
          toolName: 'message_send',
        },
        title: 'Announce',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const steps = await stepRunsOf(prisma, run.id)
  assert.equal(steps.length, 3)
  assert.deepEqual(steps.map((step) => step.status), ['completed', 'completed', 'completed'])

  const transform = steps[1]!
  assert.deepEqual(transform.output, {
    result: { tag: 'v1.2.3', url: 'https://example.com/release/1' },
  })

  const message = await prisma.message.findFirst({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(
    message?.content,
    'Shipped v1.2.3 — https://example.com/release/1',
  )

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')
})

runDatabaseTest('W17: without source the expression joins across steps and workflow scopes', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma, {
    resolvedBindings: { environment: 'prod' },
  })
  const graph = {
    steps: [
      producerStep({ count: 3 }),
      {
        id: 'shape',
        input: {
          // Full-context form: steps + workflow.input + workflow.bindings in
          // one expression, no explicit source.
          expression:
            '{ total: steps.fetch.output.result.value.count, env: workflow.bindings.environment, label: workflow.input.label }',
        },
        title: 'Shape',
        type: 'transform',
      },
      {
        id: 'announce',
        input: {
          body: '{{ steps.shape.output.result.env }}:{{ steps.shape.output.result.label }}={{ steps.shape.output.result.total }}',
          toolName: 'message_send',
        },
        title: 'Announce',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph, workflowInput: { label: 'deploys' } })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const steps = await stepRunsOf(prisma, run.id)
  assert.deepEqual(steps[1]?.output, {
    result: { env: 'prod', label: 'deploys', total: 3 },
  })

  const message = await prisma.message.findFirst({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(message?.content, 'prod:deploys=3')
})

runDatabaseTest('W17: the inline jmespath: form reshapes inside any step input', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      producerStep({ items: [{ title: 'alpha' }, { title: 'beta' }] }),
      {
        id: 'announce',
        input: {
          body: 'jmespath:join(\', \', steps.fetch.output.result.value.items[].title)',
          toolName: 'message_send',
        },
        title: 'Announce',
        type: 'tool',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const message = await prisma.message.findFirst({
    where: { thread: { channelId: seed.channelId } },
  })
  assert.equal(message?.content, 'alpha, beta')

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')
})

runDatabaseTest('W17: a tainted binding is redacted from the transform context and the persisted output', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma, {
    resolvedBindings: { apiKey: SECRET_REF, channel: '#ops' },
  })
  const graph = {
    steps: [
      {
        id: 'shape',
        input: {
          // Full context: the tainted ref lives in workflow.bindings.
          expression:
            '{ key: workflow.bindings.apiKey, channel: workflow.bindings.channel }',
        },
        title: 'Shape',
        type: 'transform',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const [stepRun] = await stepRunsOf(prisma, run.id)
  assert.equal(stepRun?.status, 'completed')
  assert.deepEqual(stepRun?.output, {
    result: { channel: '#ops', key: WORKFLOW_SECRET_REDACTION },
  })
  // The sink holds on the persisted artifact itself: no shape of the ref
  // survives into input or output.
  assert.equal(JSON.stringify(stepRun?.input).includes(SECRET_REF), false)
  assert.equal(JSON.stringify(stepRun?.output).includes(SECRET_REF), false)

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'completed')
})

runDatabaseTest('W17: a tainted ref reached through an explicit source is redacted before the expression sees it', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma, {
    resolvedBindings: { apiKey: SECRET_REF },
  })
  const graph = {
    steps: [
      {
        id: 'shape',
        input: {
          expression: '{ token: apiKey }',
          source: '{{ workflow.bindings }}',
        },
        title: 'Shape',
        type: 'transform',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const [stepRun] = await stepRunsOf(prisma, run.id)
  assert.equal(stepRun?.status, 'completed')
  assert.deepEqual(stepRun?.output, { result: { token: WORKFLOW_SECRET_REDACTION } })
})

runDatabaseTest('W17: the envelope caps are enforced at run time', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      {
        id: 'shape',
        input: {
          // Over the 4 KiB expression cap — save-time validation rejects it
          // first, but a pre-validation template must still fail safely.
          expression: `'x' || '${'a'.repeat(5 * 1024)}'`,
        },
        title: 'Shape',
        type: 'transform',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const [stepRun] = await stepRunsOf(prisma, run.id)
  assert.equal(stepRun?.status, 'failed')
  assert.ok(
    stepRun?.errorMessage?.includes('exceeds'),
    `expected an envelope error, got: ${stepRun?.errorMessage}`,
  )

  const refreshedRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(refreshedRun.status, 'failed')
})

runDatabaseTest('W17: a data-dependent expression error fails the step with the evaluator message', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedInstallation(prisma)
  const graph = {
    steps: [
      producerStep({ n: 1 }),
      {
        id: 'shape',
        input: {
          // Valid syntax; `round/2` takes one argument — an arity error the
          // evaluator only raises against data.
          expression: 'round(`1`, `2`)',
        },
        title: 'Shape',
        type: 'transform',
      },
    ],
  }
  const run = await seedRun(prisma, seed, { graph })
  t.after(async () => {
    await cleanup(prisma, [seed], [run.id])
    await prisma.$disconnect()
  })

  await executeWorkflowRun({
    prisma,
    workflowRunId: run.id,
    ...executionContext(seed, run),
  })

  const steps = await stepRunsOf(prisma, run.id)
  const shape = steps.find((step) => step.stepKey === 'shape')
  assert.equal(shape?.status, 'failed')
  assert.ok(
    shape?.errorMessage?.includes('transform could not be evaluated'),
    `expected a transform evaluation error, got: ${shape?.errorMessage}`,
  )
  // W7: a failed step terminalizes the run; the producer ahead of it already
  // completed, and nothing downstream pretends to still be coming.
  assert.equal(steps.length, 2)
})
