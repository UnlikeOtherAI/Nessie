import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coerceJsonEncodedToolArguments } from './tool-argument-coercion.js'

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
