#!/usr/bin/env node
/**
 * A real MCP server over stdio, used to prove the executor's bridge against a
 * process rather than a stub. A fake proves the bridge calls our own code; only
 * a process proves the JSON-RPC framing, the handshake, and the teardown.
 *
 * Its behaviour is chosen by NESSIE_TEST_MCP_MODE:
 *   ok            - two tools, both answer
 *   error-tool    - `boom` answers with isError
 *   die-on-call   - exits mid-call, to prove a crash is noticed
 *   never-start   - exits before the handshake, a launch failure
 *   huge          - answers with more bytes than any result budget
 *   many-tools    - enough tools to force catalog pagination
 */
import { createInterface } from 'node:readline'

const mode = process.env.NESSIE_TEST_MCP_MODE ?? 'ok'

if (mode === 'never-start') process.exit(3)

const tools = mode === 'many-tools'
  ? Array.from({ length: 40 }, (_, index) => ({
    name: `tool_${String(index).padStart(3, '0')}`,
    description: `Tool ${index}. ${'padding '.repeat(40)}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }))
  : [
    {
      name: 'echo',
      description: 'Echo the value back.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    },
    {
      name: 'boom',
      description: 'Always fails.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const callResult = (request) => {
  const name = request.params?.name
  if (mode === 'die-on-call') {
    process.exit(7)
  }
  if (mode === 'huge') {
    return { content: [{ type: 'text', text: 'x'.repeat(200_000) }] }
  }
  if (name === 'boom' || mode === 'error-tool') {
    return { content: [{ type: 'text', text: 'it failed' }], isError: true }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ echoed: request.params?.arguments ?? null }) }],
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'scripted', version: '9.9.9' },
      },
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    return
  }
  if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: request.id, result: callResult(request) })
    return
  }
  if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
})
