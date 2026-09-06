import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

// See providers.test.ts: `loadConfig()` is read at call time and refuses
// `filesystem` storage outside `local`, so a non-local mode names an object
// store. node --test gives each test file its own process.
process.env['NESSIE_MODE'] = 'selfHosted'
process.env['NESSIE_STORAGE_PROVIDER'] = 's3'
process.env['NESSIE_STORAGE_BUCKET'] = 'nessie'

const { dispatchSandboxedBuiltinTool } = await import('./sandboxed-tool-dispatch.js')

// The refusal happens before any database read, and the test proves it: this
// Prisma stand-in throws if the dispatcher reaches for the tool's registry
// entry at all.
const prisma = {
  toolRegistryEntry: {
    findUnique: () => {
      throw new Error('the registry was read despite the refusal')
    },
  },
} as unknown as PrismaClient

const context = {
  channel: { organizationId: 'org-1' },
  prisma,
} as unknown as BuiltinToolRuntimeContext

for (const toolName of ['file_read', 'file_write', 'file_glob'] as const) {
  test(`${toolName} is refused outside local mode, with a result the model can act on`, async () => {
    const result = await dispatchSandboxedBuiltinTool(
      toolName,
      { path: '/tmp/whatever' },
      context,
      `${toolName}(/tmp/whatever)`,
    )

    assert.ok(result, `${toolName} must be handled by this dispatcher`)
    assert.equal(result.success, false)
    assert.match(result.output, /`file_read`, `file_write` and `file_glob`/)
    assert.match(result.output, /not allowed in selfHosted mode/)
    assert.match(result.output, /knowledge base or an MCP server/)
  })
}

test('a tool this dispatcher does not own is still passed on', async () => {
  const result = await dispatchSandboxedBuiltinTool('kb_search', {}, context, 'kb_search()')

  assert.equal(result, null)
})
