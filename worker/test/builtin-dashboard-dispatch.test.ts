import assert from 'node:assert/strict'
import test from 'node:test'

import type { DashboardToolServices } from '../src/run/pa-tools/dashboard-context.js'
import { executeBuiltinTool } from '../src/run/tools.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

test('top-level dispatcher routes dashboard_source_import through the dashboard tool bundle', async () => {
  const context = { prisma: {} } as BuiltinToolRuntimeContext
  const services = {} as DashboardToolServices
  const calls: Array<{ args: Record<string, unknown>; name: string }> = []

  const result = await executeBuiltinTool(
    'dashboard_source_import',
    { content: 'quarter,revenue\nQ2,28', format: 'csv', name: 'Quarterly CSV' },
    context,
    new Set(),
    {
      dashboard: {
        resolveServices: async (prisma) => {
          assert.equal(prisma, context.prisma)
          return services
        },
        runTool: async (name, receivedContext, args, receivedServices) => {
          assert.equal(receivedContext, context)
          assert.equal(receivedServices, services)
          calls.push({ args, name })
          return { inputSummary: 'import', outputPreview: 'Imported CSV.', toolName: name }
        },
      },
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.output, 'Imported CSV.')
  assert.deepEqual(calls, [{
    args: { content: 'quarter,revenue\nQ2,28', format: 'csv', name: 'Quarterly CSV' },
    name: 'dashboard_source_import',
  }])
})
