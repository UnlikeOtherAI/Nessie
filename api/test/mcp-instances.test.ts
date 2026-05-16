import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
  resolveInstanceTransport,
  type McpInstanceRow,
} from '../src/services/mcp-instances.js'

const baseInstance: McpInstanceRow = {
  id: 'instance-1',
  catalogEntryId: 'catalog-1',
  organizationId: 'org-1',
  scopeType: 'organization',
  scopeId: 'org-1',
  credentialRef: null,
  transportConfig: {},
  discoveredTools: [],
  lifecycleState: 'pending_setup',
  healthLastCheckedAt: null,
  healthFailureCount: 0,
  installedBy: 'actor-1',
  createdAt: new Date(),
  updatedAt: new Date(),
}

test('resolveInstanceTransport prefers instance overrides over catalog defaults', () => {
  const resolved = resolveInstanceTransport(
    {
      ...baseInstance,
      transportConfig: { transport: 'http', url: 'https://override.example/api' },
    },
    {
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://default.example/api',
        headers: { 'X-From': 'catalog' },
      },
    },
  )
  assert.equal(resolved.transport, 'http')
  if (resolved.transport === 'http') {
    assert.equal(resolved.url, 'https://override.example/api')
    assert.deepEqual(resolved.headers, { 'X-From': 'catalog' })
  }
})

test('resolveInstanceTransport falls back to catalog defaults when instance is empty', () => {
  const resolved = resolveInstanceTransport(
    { ...baseInstance, transportConfig: {} },
    {
      defaultTransportConfig: {
        transport: 'stdio',
        command: 'mcp-server',
        args: ['--verbose'],
      },
    },
  )
  assert.equal(resolved.transport, 'stdio')
  if (resolved.transport === 'stdio') {
    assert.equal(resolved.command, 'mcp-server')
    assert.deepEqual(resolved.args, ['--verbose'])
  }
})

test('resolveInstanceTransport throws typed error on invalid shape', () => {
  let thrown: unknown
  try {
    resolveInstanceTransport(
      { ...baseInstance, transportConfig: { transport: 'http' } },
      { defaultTransportConfig: {} },
    )
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpInstanceError)
  assert.equal(
    (thrown as McpInstanceError).code,
    MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})
