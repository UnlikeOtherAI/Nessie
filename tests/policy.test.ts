/**
 * tests/policy.test.ts — Unit tests for resolveTrustedGroupId and tool policy.
 *
 * Run with: npx vitest run tests/policy.test.ts
 * (Requires vitest to be installed and configured)
 */

import { describe, it, expect } from 'vitest'
import { resolveTrustedGroupId } from '../src/agent/tools/policy.js'

describe('resolveTrustedGroupId', () => {
  it('returns caller groupId as-is when empty', () => {
    const result = resolveTrustedGroupId({
      groupId: '',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'parent-task-1',
    })
    expect(result.groupId).toBe('')
    expect(result.dropped).toBe(false)
  })

  it('returns caller groupId when it matches sessionKey-derived group', () => {
    const result = resolveTrustedGroupId({
      groupId: 'group-A',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: undefined,
    })
    expect(result.groupId).toBe('group-A')
    expect(result.dropped).toBe(false)
  })

  it('returns caller groupId when it matches spawnedBy', () => {
    const result = resolveTrustedGroupId({
      groupId: 'parent-task-1',
      sessionKey: undefined,
      spawnedBy: 'parent-task-1',
    })
    expect(result.groupId).toBe('parent-task-1')
    expect(result.dropped).toBe(false)
  })

  it('returns caller groupId when it matches both sessionKey and spawnedBy', () => {
    const result = resolveTrustedGroupId({
      groupId: 'group-A',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'group-A',
    })
    expect(result.groupId).toBe('group-A')
    expect(result.dropped).toBe(false)
  })

  it('rejects groupId that disagrees with sessionKey', () => {
    const result = resolveTrustedGroupId({
      groupId: 'group-B',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: undefined,
    })
    expect(result.groupId).toBeNull()
    expect(result.dropped).toBe(true)
  })

  it('rejects groupId that disagrees with spawnedBy', () => {
    const result = resolveTrustedGroupId({
      groupId: 'wrong-group',
      sessionKey: undefined,
      spawnedBy: 'parent-task-1',
    })
    expect(result.groupId).toBeNull()
    expect(result.dropped).toBe(true)
  })

  it('fails closed when no group context exists anywhere', () => {
    const result = resolveTrustedGroupId({
      groupId: 'some-group',
      sessionKey: undefined,
      spawnedBy: undefined,
    })
    expect(result.groupId).toBeNull()
    expect(result.dropped).toBe(true)
  })

  it('fails closed when sessionKey cannot be parsed', () => {
    const result = resolveTrustedGroupId({
      groupId: 'some-group',
      sessionKey: 'invalid-key-format',
      spawnedBy: undefined,
    })
    expect(result.groupId).toBeNull()
    expect(result.dropped).toBe(true)
  })

  it('accepts groupId that matches either trusted source', () => {
    // When spawnedBy matches but sessionKey doesn't
    const result1 = resolveTrustedGroupId({
      groupId: 'parent-task-1',
      sessionKey: 'agent:main:nessie:group:group-A', // different
      spawnedBy: 'parent-task-1', // matches caller
    })
    expect(result1.groupId).toBe('parent-task-1')
    expect(result1.dropped).toBe(false)
  })

  it('handles null/undefined groupId gracefully', () => {
    const result = resolveTrustedGroupId({
      groupId: null,
      sessionKey: undefined,
      spawnedBy: undefined,
    })
    expect(result.groupId).toBeNull()
    expect(result.dropped).toBe(false) // empty caller value is returned as-is
  })

  it('trims whitespace from caller groupId', () => {
    const result = resolveTrustedGroupId({
      groupId: '  group-A  ',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: undefined,
    })
    expect(result.groupId).toBe('group-A')
    expect(result.dropped).toBe(false)
  })
})
