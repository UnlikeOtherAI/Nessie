/**
 * Test MCP tools end-to-end: invoke_tool + inject_message
 */
import { Orchestrator } from './src/agent/Orchestrator.ts'
import { createMcpAdapter } from './src/mcp/adapter.ts'
import { McpServer, parseJsonRpcRequest } from './src/mcp/server.ts'

const orch = new Orchestrator({ defaultAgent: 'main' })
const adapter = createMcpAdapter(orch)
const server = new McpServer(adapter)

async function callTool(name, args) {
  const req = parseJsonRpcRequest(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  }))[0]
  return await server.handleRequest(req)
}

async function listTools() {
  const req = parseJsonRpcRequest(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  }))[0]
  return await server.handleRequest(req)
}

async function run() {
  console.log('=== MCP Tool Test ===\n')

  // Test 1: List all tools
  const toolsResult = await listTools()
  const tools = toolsResult.result.tools
  console.log(`Tools available: ${tools.length}`)
  for (const t of tools) console.log(`  - ${t.name}`)
  console.log()

  // Test 2: inject_message
  console.log('Test: inject_message')
  const injectResult = await callTool('inject_message', {
    role: 'user',
    content: 'Hello from MCP test',
    threadId: 'main'
  })
  console.log('Result:', JSON.stringify(injectResult, null, 2))
  const state1 = adapter.getState()
  console.log(`Messages in state: ${state1.messages.length}`)
  console.log()

  // Test 3: invoke_tool — Bash
  console.log('Test: invoke_tool (Bash — pwd)')
  const bashResult = await callTool('invoke_tool', {
    name: 'Bash',
    input: { command: 'echo "hello from bash"', description: 'Test echo' }
  })
  console.log('Result:', JSON.stringify(bashResult, null, 2))
  console.log()

  // Test 4: invoke_tool — Glob
  console.log('Test: invoke_tool (Glob — src/**/*.ts)')
  const globResult = await callTool('invoke_tool', {
    name: 'Glob',
    input: { pattern: 'src/**/*.ts' }
  })
  console.log('Result:', JSON.stringify(globResult, null, 2))
  console.log()

  // Test 5: invoke_tool — Grep
  console.log('Test: invoke_tool (Grep — "Orchestrator")')
  const grepResult = await callTool('invoke_tool', {
    name: 'Grep',
    input: { pattern: 'Orchestrator', path: 'src' }
  })
  console.log('Result:', JSON.stringify(grepResult, null, 2))
  console.log()

  // Test 6: invoke_tool — unknown tool
  console.log('Test: invoke_tool (unknown tool)')
  const unknownResult = await callTool('invoke_tool', {
    name: 'NonExistentTool',
    input: {}
  })
  console.log('Result:', JSON.stringify(unknownResult, null, 2))
  console.log()

  // Test 7: inject_message — assistant role
  console.log('Test: inject_message (assistant)')
  const injectAssistant = await callTool('inject_message', {
    role: 'assistant',
    content: 'I am ready to help.',
    threadId: 'main'
  })
  console.log('Result:', JSON.stringify(injectAssistant, null, 2))
  const state2 = adapter.getState()
  console.log(`Messages in state: ${state2.messages.length}`)
  for (const m of state2.messages) {
    console.log(`  [${m.role}] ${m.content.slice(0, 50)}`)
  }
  console.log()

  // Test 8: inject_message — invalid role
  console.log('Test: inject_message (invalid role)')
  const invalidRole = await callTool('inject_message', {
    role: 'king',
    content: 'Hail!'
  })
  console.log('Result:', JSON.stringify(invalidRole, null, 2))
  console.log()

  console.log('=== All tests done ===')
}

run().catch(console.error)
