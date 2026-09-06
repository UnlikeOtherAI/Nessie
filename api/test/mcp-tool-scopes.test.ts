import assert from 'node:assert/strict'
import test from 'node:test'

import { McpScopeError, requireScope } from '../src/mcp/scopes.js'
import { nessieMcpTools } from '../src/mcp/server.js'

// Scopes are what makes an agent credential a slice of an account rather than
// the whole of it, so the property worth pinning is that every tool actually
// asks for one — a tool that forgets is a tool that ignores the grant.

test('a held scope passes and a missing one refuses by name', () => {
  assert.doesNotThrow(() => requireScope(['boards_read'], 'boards_read'))

  assert.throws(
    () => requireScope(['boards_read'], 'boards_write'),
    (error: unknown) => {
      assert.ok(error instanceof McpScopeError)
      assert.equal(error.required, 'boards_write')
      // The message has to tell the agent what to ask for, or the refusal is
      // just a dead end.
      assert.match(error.message, /boards_write/)
      return true
    },
  )
})

test('every tool refuses without its scope', async () => {
  const tools = nessieMcpTools()
  assert.ok(tools.length > 0)

  for (const tool of tools) {
    // An empty credential holds nothing, so every tool must refuse.
    await assert.rejects(
      () => tool.run(
        { scopes: [] } as never,
        {},
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof McpScopeError,
          `${tool.name} did not check a scope before doing work`,
        )
        return true
      },
      `${tool.name} must refuse a credential holding no scopes`,
    )
  }
})

test('read scopes never imply write ones', () => {
  const readOnly = ['boards_read', 'documents_read'] as const
  assert.throws(() => requireScope([...readOnly], 'boards_write'), McpScopeError)
  assert.throws(() => requireScope([...readOnly], 'documents_write'), McpScopeError)
})

test('the tool set covers boards and documents, and does not publish', () => {
  const names = nessieMcpTools().map((tool) => tool.name)

  for (const expected of [
    'nessie_board_list',
    'nessie_board_get',
    'nessie_task_get',
    'nessie_task_create',
    'nessie_task_update',
    'nessie_task_move',
    'nessie_space_list',
    'nessie_doc_list',
    'nessie_doc_get',
    'nessie_doc_create',
    'nessie_doc_update',
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing from the tool set`)
  }

  // Publishing is a human act: the HTTP route refuses an agent outright and
  // routes it to an approval. An agent credential resolves as the human who
  // approved it, so a publish tool here would walk straight past a gate written
  // for exactly this kind of caller.
  assert.equal(
    names.some((name) => name.includes('publish')),
    false,
    'an agent must not be able to publish a document',
  )
})
