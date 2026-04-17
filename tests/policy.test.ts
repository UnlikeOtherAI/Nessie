/**
 * tests/policy.test.ts — Unit tests for resolveTrustedGroupId and tool policy.
 *
 * Run with: npx vitest run tests/policy.test.ts
 * (Requires vitest to be installed and configured)
 */

import { describe, it, expect } from 'vitest'
import { resolveTrustedGroupId, applyFinalEffectiveToolPolicy } from '../src/agent/tools/policy.js'
import type { Tools } from '../src/tools/types.js'

// Test helper: make a minimal tool
function makeTool(name: string): { name: string; inputSchema: { parse: (x: unknown) => unknown } } {
  return {
    name,
    inputSchema: { parse: (x: unknown) => x },
  }
}

describe('resolveTrustedGroupId', () => {
  it('returns null when caller groupId is empty (no trust signal needed)', () => {
    // Empty caller groupId is accepted as-is — no trust verification needed
    const result = resolveTrustedGroupId({
      groupId: '',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'parent-task-1',
    })
    expect(result.groupId).toBeNull()
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

describe('applyFinalEffectiveToolPolicy', () => {
  const allTestTools: Tools = [
    makeTool('Bash'),
    makeTool('WebSearch'),
    makeTool('FileRead'),
    makeTool('FileWrite'),
    makeTool('Glob'),
    makeTool('Grep'),
  ]

  it('returns all tools when trust is not dropped and role allows them', () => {
    // builder role allows all 6 tools — no tools are dropped, filtered=false
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'builder',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'parent-task-1',
    })
    expect(result.tools.length).toBe(6)
    expect(result.filtered).toBe(false)
    expect(result.droppedCount).toBe(0)
  })

  it('HARD DENY: trusted.dropped === true returns empty tools array', () => {
    // Caller groupId disagrees with both trusted sources → trust dropped → ALL tools denied
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'builder',
      groupId: 'group-Caller',
      sessionKey: 'agent:main:nessie:group:group-B',
      spawnedBy: 'group-A',
    })
    expect(result.tools).toEqual([])
    expect(result.filtered).toBe(true)
  })

  it('task with tools: [WebSearch] under role that allows Bash must deny Bash', () => {
    // watcher role allows: FileRead, Glob, Grep — NOT Bash or WebSearch
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'watcher',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'group-A',
    })
    const allowedToolNames = result.tools.map(t => t.name)
    expect(allowedToolNames).not.toContain('Bash')
    expect(allowedToolNames).not.toContain('WebSearch')
    expect(allowedToolNames).toContain('FileRead')
  })

  it('task with tools: [Bash] under role that disallows Bash must deny', () => {
    // watcher role does NOT allow Bash
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'watcher',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'group-A',
    })
    const allowedToolNames = result.tools.map(t => t.name)
    expect(allowedToolNames).not.toContain('Bash')
  })

  it('trusted.dropped === true must remove ALL tools from returned set', () => {
    // Caller groupId present but sessionKey can't be parsed + no spawnedBy → trust dropped → ALL tools denied
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'builder',
      groupId: 'some-group',
      sessionKey: 'invalid-key-format',
      spawnedBy: undefined,
    })
    expect(result.tools).toHaveLength(0)
    expect(result.filtered).toBe(true)
  })

  it('empty effective tool set after policy intersection must hard-deny, not fall back', () => {
    // watcher role only allows FileRead, Glob, Grep — if caller requests only Bash,
    // the effective intersection is empty → must deny, not fall back to watcher tools
    const watcherTools = [makeTool('Bash')]
    const result = applyFinalEffectiveToolPolicy(watcherTools, {
      role: 'watcher',
      sessionKey: 'agent:main:nessie:group:group-A',
      spawnedBy: 'group-A',
    })
    expect(result.tools).toHaveLength(0)
    expect(result.filtered).toBe(true)
  })

  it('missing ledger state (no sessionKey, no spawnedBy) must fail closed', () => {
    // No server-verified group context with non-empty caller groupId → trust dropped → ALL tools denied
    const result = applyFinalEffectiveToolPolicy(allTestTools, {
      role: 'researcher',
      groupId: 'any-group',
      sessionKey: undefined,
      spawnedBy: undefined,
    })
    expect(result.tools).toEqual([])
    expect(result.filtered).toBe(true)
  })
})
