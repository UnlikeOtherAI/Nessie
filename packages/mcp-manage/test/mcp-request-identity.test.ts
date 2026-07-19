import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpTransportConfig } from '@nessie/schemas'

import {
  applyMcpRequestIdentity,
  mcpTransportAudience,
} from '../src/mcp-request-identity.js'

const appKeyTransport: McpTransportConfig = {
  transport: 'http',
  url: 'https://api.deepsignal.live/mcp',
  headers: {
    Authorization: 'Bearer dsk_nessie_only_application_key',
  },
}

test('signed MCP identity preserves the independent application credential', () => {
  const resolved = applyMcpRequestIdentity(appKeyTransport, {
    'X-Nessie-Context': 'signed-context',
    'X-UOA-Delegation': 'delegated-user',
  })

  assert.deepEqual(resolved.headers, {
    Authorization: 'Bearer dsk_nessie_only_application_key',
    'X-Nessie-Context': 'signed-context',
    'X-UOA-Delegation': 'delegated-user',
  })
  assert.equal(mcpTransportAudience(resolved), 'https://api.deepsignal.live')
})

test('signed MCP identity cannot replace Authorization', () => {
  assert.throws(
    () =>
      applyMcpRequestIdentity(appKeyTransport, {
        authorization: 'Bearer delegated-user',
      }),
    /must not replace the application credential/,
  )
})

test('signed MCP identity rejects stale headers regardless of casing', () => {
  for (const name of ['x-uoa-delegation', 'X-NESSIE-CONTEXT']) {
    assert.throws(
      () =>
        applyMcpRequestIdentity(
          {
            ...appKeyTransport,
            headers: {
              ...appKeyTransport.headers,
              [name]: 'stale-identity',
            },
          },
          {
            'X-Nessie-Context': 'fresh-context',
            'X-UOA-Delegation': 'fresh-delegation',
          },
        ),
      /stale request identity header/,
      name,
    )
  }
})

test('signed MCP identity rejects duplicate fresh header casing', () => {
  assert.throws(
    () =>
      applyMcpRequestIdentity(appKeyTransport, {
        'X-Nessie-Context': 'fresh-context',
        'x-nessie-context': 'second-context',
      }),
    /duplicate header names/,
  )
})

test('signed remote identity rejects stdio transports', () => {
  const stdio = {
    transport: 'stdio',
    command: 'not-allowed',
    args: [],
  } as McpTransportConfig
  assert.throws(
    () => mcpTransportAudience(stdio),
    /unavailable for stdio transports/,
  )
  assert.throws(
    () => applyMcpRequestIdentity(stdio, {}),
    /unavailable for stdio transports/,
  )
})
