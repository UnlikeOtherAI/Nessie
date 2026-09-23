import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { DEEP_WATER_RUN_UPDATE_TOOL_ID, SYSTEM_TOOL_DEFINITIONS } from '@nessie/runtime'

import { ensureBuiltinToolRegistered, ensureBuiltinToolsRegistered } from '../src/builtin-tool-registry.js'

const ORG = '00000000-0000-4000-8000-000000000001'

const recording = () => {
  const toolIds: string[] = []
  const prisma = {
    toolRegistryEntry: {
      upsert: async ({ where, create }: {
        where: { organizationId_scopeKey_toolId: { toolId: string } }
        create: { builtin: boolean; handlerKind: string; organizationId: string }
      }) => {
        assert.equal(create.builtin, true)
        assert.equal(create.handlerKind, 'builtin')
        assert.equal(create.organizationId, ORG)
        toolIds.push(where.organizationId_scopeKey_toolId.toolId)
        return {}
      },
    },
  } as unknown as PrismaClient
  return { prisma, toolIds }
}

test('one builtin is registered alone, as the full registration writes it', async () => {
  const one = recording()
  await ensureBuiltinToolRegistered(one.prisma, ORG, DEEP_WATER_RUN_UPDATE_TOOL_ID)
  assert.deepEqual(one.toolIds, [DEEP_WATER_RUN_UPDATE_TOOL_ID])

  const all = recording()
  await ensureBuiltinToolsRegistered(all.prisma, ORG)
  assert.equal(all.toolIds.length, SYSTEM_TOOL_DEFINITIONS.length)
  assert.ok(all.toolIds.includes(DEEP_WATER_RUN_UPDATE_TOOL_ID))
})

test('an id that is not a builtin is a caller bug, never a row to invent', async () => {
  const none = recording()
  await assert.rejects(ensureBuiltinToolRegistered(none.prisma, ORG, 'not_a_builtin'), /not a builtin/)
  assert.deepEqual(none.toolIds, [])
})
