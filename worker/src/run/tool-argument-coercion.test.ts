import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coerceJsonEncodedToolArguments, coerceToolArgumentsToSchema } from './tool-argument-coercion.js'

describe('coerceJsonEncodedToolArguments scalars', () => {
  it('coerces "true" to true for agent_deepwater_access_set', () => {
    const out = coerceJsonEncodedToolArguments('agent_deepwater_access_set', {
      agentId: 'a',
      teamId: 't',
      enabled: 'true',
    })
    assert.equal(out.enabled, true)
  })

  it('coerces "false" to false for agent_tool_access_set', () => {
    const out = coerceJsonEncodedToolArguments('agent_tool_access_set', {
      agentId: 'a',
      teamId: 't',
      enabled: 'false',
    })
    assert.equal(out.enabled, false)
  })

  it('leaves a non-boolean string untouched', () => {
    const out = coerceJsonEncodedToolArguments('agent_tool_access_set', {
      agentId: 'a',
      teamId: 't',
      enabled: 'yes',
    })
    assert.equal(out.enabled, 'yes')
  })

  it('coerces a numeric string for an integer parameter', () => {
    const out = coerceJsonEncodedToolArguments('task_set_processors', { limit: '5' })
    assert.equal(out.limit, 5)
  })

  it('parses a JSON-encoded arguments string', () => {
    const out = coerceJsonEncodedToolArguments(
      'agent_deepwater_access_set',
      '{"agentId":"a","teamId":"t","enabled":"true"}',
    )
    assert.equal(out.agentId, 'a')
    assert.equal(out.enabled, true)
  })
})

describe('coerceToolArgumentsToSchema', () => {
  const schema = {
    properties: {
      arguments: { type: 'object' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      tags: { items: { type: 'object' }, type: 'array' },
    },
    type: 'object',
  }

  it('applies the builtin rule to any schema, including a JSON-string object', () => {
    const out = coerceToolArgumentsToSchema(schema, {
      arguments: '{"url":"https://example.com"}',
      count: '3',
      flag: 'true',
    })
    assert.deepEqual(out, { arguments: { url: 'https://example.com' }, count: 3, flag: true })
  })

  it('shapes only scalars when asked, leaving JSON strings as they arrived', () => {
    const out = coerceToolArgumentsToSchema(schema, {
      arguments: '{"url":"https://example.com"}',
      count: '3',
      tags: ['{"a":1}'],
    }, { scalarsOnly: true })
    assert.deepEqual(out, { arguments: '{"url":"https://example.com"}', count: 3, tags: ['{"a":1}'] })
  })

  it('returns the arguments by identity when the schema declares no properties', () => {
    const args = { count: '3' }
    assert.equal(coerceToolArgumentsToSchema({ type: 'object' }, args), args)
    assert.equal(coerceToolArgumentsToSchema(undefined, args), args)
  })
})
