import { describe, it, expect } from 'vitest'
import { partitionReasoningTags } from './reasoning-tag-stripper.js'

describe('partitionReasoningTags', () => {
  it('splits tags within a single chunk', () => {
    const state = { inReasoning: false, buffer: '' }
    const { result, newState } = partitionReasoningTags(
      'Hello <thinking>reasoning</thinking> world',
      state,
    )
    expect(result.content).toBe('Hello  world')
    expect(result.reasoning).toBe('reasoning')
    expect(newState.inReasoning).toBe(false)
    expect(newState.buffer).toBe('')
  })

  it('handles tags spanning multiple chunks', () => {
    let state = { inReasoning: false, buffer: '' }

    const { result: r1, newState: s1 } = partitionReasoningTags('Hello <think', state)
    expect(r1.content).toBe('Hello ')
    expect(r1.reasoning).toBeUndefined()
    expect(s1.inReasoning).toBe(false)
    expect(s1.buffer).toBe('<think')

    const { result: r2, newState: s2 } = partitionReasoningTags('ing>reason', s1)
    expect(r2.content).toBeUndefined()
    expect(r2.reasoning).toBe('reason')
    expect(s2.inReasoning).toBe(true)
    expect(s2.buffer).toBe('')

    const { result: r3, newState: s3 } = partitionReasoningTags('ing</thinking> world', s2)
    expect(r3.content).toBe(' world')
    expect(r3.reasoning).toBe('ing')
    expect(s3.inReasoning).toBe(false)
    expect(s3.buffer).toBe('')
  })

  it('handles nested tags by treating inner content as reasoning', () => {
    const state = { inReasoning: false, buffer: '' }
    const { result, newState } = partitionReasoningTags(
      '<thinking>outer <thinking>inner</thinking> still outer</thinking> done',
      state,
    )
    // Nested: the first closing tag ends reasoning. The "still outer" becomes content.
    expect(result.content).toBe(' still outer done')
    expect(result.reasoning).toBe('outer inner')
    expect(newState.inReasoning).toBe(false)
  })

  it('passes through as content when no tags present', () => {
    const state = { inReasoning: false, buffer: '' }
    const { result, newState } = partitionReasoningTags(
      'Just plain text here',
      state,
    )
    expect(result.content).toBe('Just plain text here')
    expect(result.reasoning).toBeUndefined()
    expect(newState.inReasoning).toBe(false)
    expect(newState.buffer).toBe('')
  })

  it('preserves tags inside markdown code blocks (optional)', () => {
    const state = { inReasoning: false, buffer: '' }
    const text = '```\n<thinking>inside code</thinking>\n```\nAfter code'
    const { result, newState } = partitionReasoningTags(text, state)
    // Basic fence detection: content inside triple-backtick blocks should be preserved
    expect(result.content).toBe(text)
    expect(result.reasoning).toBeUndefined()
    expect(newState.inReasoning).toBe(false)
  })

  it('handles all tag variants', () => {
    const variants = [
      { open: '<thinking>', close: '</thinking>' },
      { open: '<antml:thinking>', close: '</antml:thinking>' },
      { open: '<thought>', close: '</thought>' },
      { open: '<reasoning>', close: '</reasoning>' },
    ]

    for (const { open, close } of variants) {
      const state = { inReasoning: false, buffer: '' }
      const { result, newState } = partitionReasoningTags(
        `before ${open}reason${close} after`,
        state,
      )
      expect(result.content).toBe('before  after')
      expect(result.reasoning).toBe('reason')
      expect(newState.inReasoning).toBe(false)
      expect(newState.buffer).toBe('')
    }
  })

  it('handles partial tag at end of chunk with buffer', () => {
    const state = { inReasoning: false, buffer: '' }
    const { result, newState } = partitionReasoningTags(
      'text <thinki',
      state,
    )
    expect(result.content).toBe('text ')
    expect(result.reasoning).toBeUndefined()
    expect(newState.inReasoning).toBe(false)
    expect(newState.buffer).toBe('<thinki')
  })

  it('handles closing tag split across chunks', () => {
    let state = { inReasoning: true, buffer: '' }

    const { result: r1, newState: s1 } = partitionReasoningTags('reasoning </thin', state)
    expect(r1.reasoning).toBe('reasoning ')
    expect(r1.content).toBeUndefined()
    expect(s1.inReasoning).toBe(true)
    expect(s1.buffer).toBe('</thin')

    const { result: r2, newState: s2 } = partitionReasoningTags('king> after', s1)
    expect(r2.content).toBe(' after')
    expect(r2.reasoning).toBeUndefined()
    expect(s2.inReasoning).toBe(false)
    expect(s2.buffer).toBe('')
  })
})
