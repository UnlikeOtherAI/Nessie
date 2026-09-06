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

test('the tool set covers boards and documents, publishing included', () => {
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
    'nessie_doc_publish',
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing from the tool set`)
  }
})

test('publishing is never implied by writing', () => {
  // "Agents draft; only a human may publish" survives because publishing has
  // its own scope. A credential holding every write scope still cannot
  // publish; only a person ticking `documents_publish` at pairing time does.
  const publish = nessieMcpTools().find((tool) => tool.name === 'nessie_doc_publish')
  assert.ok(publish)
  assert.rejects(
    () => publish.run(
      { scopes: ['boards_write', 'documents_read', 'documents_write'] } as never,
      {},
    ),
    McpScopeError,
  )
})
