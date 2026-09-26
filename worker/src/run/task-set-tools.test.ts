import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { createConsumedSourceSink } from './execute/disclosure-basis.js'
import { inheritedTaskSetDisclosure, runTaskSetTool, taskSetDisclosureObserver } from './task-set-tools.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const userId = id(1)
const setId = id(2)
const itemId = id(3)
const channelId = id(4)

test('task-set native tools accept neither model identity nor invented disclosure lineage', () => {
  const tools = BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.id.startsWith('task_set_'))
  assert.equal(tools.length, 10)
  for (const tool of tools) assert.notEqual(tool.personalAssistantOnly, true)
  const create = tools.find((tool) => tool.id === 'task_set_create')!.inputSchema!
  const request = {
    name: 'Research', objective: 'Summarise each row', instructions: '',
    processor: { provider: 'local/ollama', model: 'small', localInferenceBindingId: id(5) },
    output: { kind: 'journal' },
  }
  assert.equal(create.safeParse(request).success, true)
  for (const extra of [{ ownerUserId: userId }, { originThreadId: id(6) }, { disclosure: {} }]) {
    assert.equal(create.safeParse({ ...request, ...extra }).success, false)
  }
})

test('task-set tools fail before reading or mutating when the disclosure sink is absent', async () => {
  await assert.rejects(runTaskSetTool('task_set_create', {} as BuiltinToolRuntimeContext, {}), /disclosure-aware/)
  await assert.rejects(runTaskSetTool('task_set_read', {} as BuiltinToolRuntimeContext, {}), /disclosure-aware/)
})

test('task-set tool observer retains exact private authors and unknown-author markers', () => {
  const context = { consumedSources: createConsumedSourceSink() } as BuiltinToolRuntimeContext
  const disclosure = {
    classified: true as const, basisScopes: [{ scopeType: 'channel', scopeId: channelId }],
    disclosureSources: [
      { sourceChannelId: channelId, sourceAuthorUserId: userId },
      { sourceChannelId: channelId, sourceAuthorUserId: null },
    ],
  }
  taskSetDisclosureObserver(context)(disclosure)
  assert.deepEqual(inheritedTaskSetDisclosure(context), disclosure)
})

test('task-set result chunks reconstruct a large result through the real authorized reader', async () => {
  const result = 'Příliš žluťoučký kůň. \u0000\n'.repeat(4000)
  const disclosure = { classified: true, basisScopes: [{ scopeType: 'user', scopeId: userId }], disclosureSources: [] }
  const context = {
    consumedSources: createConsumedSourceSink(),
    actorContext: { actor: { actorType: 'agent', actorId: id(9) },
      tenant: { organizationId: id(8) }, actionContext: { effectiveUserId: userId } },
    prisma: {
      organization: { findUnique: async () => ({ externalOrgId: null }) },
      organizationMember: { findFirst: async () => ({ id: userId }) },
      channelMember: { findMany: async () => [] }, teamMember: { findMany: async () => [] },
      projectMember: { findMany: async () => [] }, agent: { findMany: async () => [] },
      taskSet: { findFirst: async () => ({ id: setId, disclosure }) },
      taskSetItem: { findFirst: async () => ({ id: itemId, taskSetId: setId, sequence: 125,
        prompt: 'Research', input: {}, dependencies: [], status: 'completed', attempts: 1,
        createdAt: new Date(), statusChangedAt: new Date(), reason: null, result,
        outputPageId: null, sourceLocator: 'row 125', disclosure, resultDisclosure: disclosure }) },
    },
  } as unknown as BuiltinToolRuntimeContext
  let reconstructed = ''
  let offset: number | null = 0
  do {
    const output = await runTaskSetTool('task_set_item_read', context, { taskSetId: setId, itemId, offset })
    const page = JSON.parse(output.outputPreview) as { text: string; page: { nextOffset: number | null }; url: string }
    assert.ok(output.outputPreview.length < 32000)
    assert.equal(page.url, `/admin/automations/batch-jobs/${setId}?item=${itemId}`)
    reconstructed += page.text
    offset = page.page.nextOffset
  } while (offset !== null)
  assert.equal(reconstructed, result)
  assert.deepEqual(context.consumedSources!.list(), disclosure.basisScopes)
})
