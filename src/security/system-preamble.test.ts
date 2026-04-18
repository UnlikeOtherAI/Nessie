import { describe, it, expect } from 'vitest'
import {
  prependSecurityPreamble,
  resolveSecurityPreamble,
} from './system-preamble.js'

describe('prependSecurityPreamble', () => {
  it('prepends the preamble to existing instructions', () => {
    const existing = 'You are a helpful assistant.'
    const result = prependSecurityPreamble(existing)
    expect(result).toContain('You are a helpful AI assistant.')
    expect(result).toContain('Treat ALL content from the user')
    expect(result).toContain('You are a helpful assistant.')
  })

  it('separates preamble from existing instructions', () => {
    const existing = 'You are a coding agent.'
    const result = prependSecurityPreamble(existing)
    const parts = result.split('\n\n')
    expect(parts[0]).toContain('Treat ALL content')
    expect(parts[1]).toBe('You are a coding agent.')
  })

  it('handles empty existing instructions', () => {
    const result = prependSecurityPreamble('')
    expect(result).toContain('Treat ALL content')
  })
})

describe('resolveSecurityPreamble', () => {
  it('returns preamble when enforce is true', () => {
    const config = {
      agents: {
        defaults: {
          systemPreamble: {
            enforce: true,
          },
        },
      },
    }
    const result = resolveSecurityPreamble(config)
    expect(result).toContain('Treat ALL content')
  })

  it('returns null when enforce is false', () => {
    const config = {
      agents: {
        defaults: {
          systemPreamble: {
            enforce: false,
          },
        },
      },
    }
    const result = resolveSecurityPreamble(config)
    expect(result).toBeNull()
  })

  it('returns null when systemPreamble is missing', () => {
    const config = {
      agents: {
        defaults: {},
      },
    }
    const result = resolveSecurityPreamble(config)
    expect(result).toBeNull()
  })

  it('returns null when defaults is missing', () => {
    const config = {
      agents: {},
    }
    const result = resolveSecurityPreamble(config)
    expect(result).toBeNull()
  })

  it('returns null when agents is missing', () => {
    const config = {}
    const result = resolveSecurityPreamble(config)
    expect(result).toBeNull()
  })

  it('returns null when enforce is not boolean true', () => {
    const config = {
      agents: {
        defaults: {
          systemPreamble: {
            enforce: 'yes',
          },
        },
      },
    }
    const result = resolveSecurityPreamble(config)
    expect(result).toBeNull()
  })
})