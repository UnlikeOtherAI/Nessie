import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  validateWorkflowGraphSteps,
  WorkflowTemplateValidationError,
} from '../src/services/workflows.js'

// W9: `{{` must not disable validation. Binding syntax is parsed on every
// step, and every steps.<id> reference must name a step that exists AND
// precedes the referencing step — a typo is a save error, not a failed run.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const graphWithSteps = (steps: Array<{
  id: string
  input?: Record<string, unknown>
  type: string
  when?: string
}>) => ({
  steps: steps.map((step) => ({ title: step.id, ...step })),
})

const issues = async (
  prisma: PrismaClient,
  organizationId: string,
  graph: ReturnType<typeof graphWithSteps>,
): Promise<string[]> => {
  try {
    await validateWorkflowGraphSteps(prisma, organizationId, graph)
    return []
  } catch (error) {
    assert.ok(error instanceof WorkflowTemplateValidationError)
    return error.issues
  }
}

runDatabaseTest('binding validation', async (t) => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({
    data: { name: `wf-validate ${randomUUID()}` },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  await t.test('unmatched braces are a save error, not a runtime failure', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      {
        id: 'a',
        input: { prompt: 'Summarize {{ steps.a.output', toolName: 'state_get' },
        type: 'tool',
      },
    ]))
    assert.ok(result.some((issue) => issue.includes('unmatched "{{"')))
  })

  await t.test('unknown binding root is a save error', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { prompt: '{{ config.name }}', toolName: 'state_get' }, type: 'tool' },
    ]))
    assert.ok(result.some((issue) => issue.includes('unknown root "config"')))
  })

  await t.test('a steps reference must name an existing step', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { key: 'k', toolName: 'state_get' }, type: 'tool' },
      {
        id: 'b',
        input: { key: 'k', value: '{{ steps.typoed.output.result }}', toolName: 'state_put' },
        type: 'tool',
      },
    ]))
    assert.ok(result.some((issue) => issue.includes('unknown step "typoed"')))
  })

  await t.test('a steps reference must precede the referencing step', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      {
        id: 'first',
        input: { key: 'k', value: '{{ steps.later.output.result }}', toolName: 'state_put' },
        type: 'tool',
      },
      { id: 'later', input: { key: 'k', toolName: 'state_get' }, type: 'tool' },
    ]))
    assert.ok(result.some((issue) => issue.includes('before it has run')))
    // Self-reference is also a forward reference.
    const selfRef = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { key: '{{ steps.a.input.key }}', toolName: 'state_get' }, type: 'tool' },
    ]))
    assert.ok(selfRef.some((issue) => issue.includes('before it has run')))
  })

  await t.test('valid earlier-step references pass', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { key: 'k', toolName: 'state_get' }, type: 'tool' },
      {
        id: 'b',
        input: { key: 'k', value: '{{ steps.a.output.result }}', toolName: 'state_put' },
        type: 'tool',
      },
    ]))
    assert.deepEqual(result, [])
  })

  await t.test('an exact binding still skips the literal tool-name check', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { key: 'k', toolName: 'state_get' }, type: 'tool' },
      { id: 'b', input: { toolName: '{{ workflow.config.tool }}' }, type: 'tool' },
    ]))
    assert.deepEqual(result, [])
  })

  await t.test('a literal unknown tool name is still rejected', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'a', input: { toolName: 'not_a_tool' }, type: 'tool' },
    ]))
    assert.ok(result.some((issue) => issue.includes('unknown tool "not_a_tool"')))
  })

  await t.test('W13: a trigger step is not an executable step type', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 't', input: {}, type: 'trigger' },
    ]))
    assert.ok(result.some((issue) => issue.includes('not executable')))
  })
})

runDatabaseTest('W16: a when: expression that does not compile is rejected at save time', async (t) => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({
    data: { name: `wf-when-validate ${randomUUID()}` },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  const result = await issues(prisma, org.id, graphWithSteps([
    {
      id: 'guarded',
      input: { body: 'never runs', toolName: 'message_send' },
      type: 'tool',
      when: 'workflow.input.[',
    },
  ]))

  // A save error — never a failed run.
  assert.ok(
    result.some((issue) => issue.includes('invalid when guard')),
    `expected an invalid when guard issue, got: ${result.join('; ')}`,
  )
})

runDatabaseTest('W17: transform validation', async (t) => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({
    data: { name: `wf-transform-validate ${randomUUID()}` },
  })
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  await t.test('a valid transform step passes', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'fetch', input: { url: 'https://example.com', toolName: 'web_fetch' }, type: 'tool' },
      {
        id: 'shape',
        input: {
          expression: 'body.releases[0].{tag: tag_name, url: html_url}',
          source: '{{ steps.fetch.output }}',
        },
        type: 'transform',
      },
    ]))
    assert.deepEqual(result, [])
  })

  await t.test('a transform without expression is a save error', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'shape', input: { source: '{{ workflow.input }}' }, type: 'transform' },
    ]))
    assert.ok(result.some((issue) => issue.includes('missing expression')))
  })

  await t.test('a bad transform expression is a save error', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'shape', input: { expression: 'foo.[' }, type: 'transform' },
    ]))
    assert.ok(
      result.some((issue) => issue.includes('invalid expression')),
      `expected an invalid expression issue, got: ${result.join('; ')}`,
    )
  })

  await t.test('an inline jmespath: string that does not compile is a save error', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      {
        id: 'announce',
        input: { body: 'jmespath:workflow.input.[', toolName: 'message_send' },
        type: 'tool',
      },
    ]))
    assert.ok(
      result.some((issue) => issue.includes('invalid jmespath expression')),
      `expected an invalid jmespath expression issue, got: ${result.join('; ')}`,
    )
  })

  await t.test('a valid inline jmespath: string passes', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'fetch', input: { url: 'https://example.com', toolName: 'web_fetch' }, type: 'tool' },
      {
        id: 'announce',
        input: { body: 'jmespath:steps.fetch.output.result.title', toolName: 'message_send' },
        type: 'tool',
      },
    ]))
    assert.deepEqual(result, [])
  })

  await t.test('W17 rule: an unregistered step type is still rejected', async () => {
    const result = await issues(prisma, org.id, graphWithSteps([
      { id: 'ghost', input: {}, type: 'delegate' },
    ]))
    assert.ok(result.some((issue) => issue.includes('unsupported type "delegate"')))
  })
})
