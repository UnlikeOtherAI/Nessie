import { describe, it, expect } from 'vitest'
import { isPathAllowed } from './path-validator.js'
import type { PathPermissions } from '../agent/types.js'

function perms(allow?: string[], block?: string[]): PathPermissions {
  return { allow, block }
}

describe('isPathAllowed', () => {
  describe('no permissions configured', () => {
    it('allows all paths', () => {
      expect(isPathAllowed('/any/path', undefined)).toBe(true)
    })
  })

  describe('block patterns', () => {
    it('blocks paths matching block pattern', () => {
      const p = perms(undefined, ['**/agent-b/**'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-b/file.txt', p)).toBe(false)
    })

    it('allows paths not matching block pattern', () => {
      const p = perms(undefined, ['**/agent-b/**'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-a/file.txt', p)).toBe(true)
    })

    it('blocks paths matching multiple block patterns', () => {
      const p = perms(undefined, ['**/agent-b/**', '**/*.md'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-a/MEMORY.md', p)).toBe(false)
    })
  })

  describe('allow patterns', () => {
    it('only allows paths matching allow pattern', () => {
      const p = perms(['/home/user/.openclaw/workspace/agent-a/**'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-a/file.txt', p)).toBe(true)
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-b/file.txt', p)).toBe(false)
    })

    it('denies non-matching allow paths', () => {
      const p = perms(['/home/user/.openclaw/workspace/agent-a/**'])
      expect(isPathAllowed('/tmp/evil.txt', p)).toBe(false)
    })
  })

  describe('allow + block (block wins)', () => {
    it('block takes precedence over allow', () => {
      const p = perms(['**/workspace/**'], ['**/agent-b/**'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-b/file.txt', p)).toBe(false)
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-a/file.txt', p)).toBe(true)
    })
  })

  describe('glob patterns', () => {
    it('handles ** for directory depth', () => {
      const p = perms(undefined, ['**/MEMORY.md'])
      expect(isPathAllowed('/home/user/.openclaw/workspace/agent-a/memory/MEMORY.md', p)).toBe(false)
    })

    it('handles * for single path component', () => {
      const p = perms(undefined, ['/home/user/*.md'])
      expect(isPathAllowed('/home/user/MEMORY.md', p)).toBe(false)
      expect(isPathAllowed('/home/user/USER.md', p)).toBe(false)
      expect(isPathAllowed('/home/user/file.txt', p)).toBe(true)
    })
  })
})