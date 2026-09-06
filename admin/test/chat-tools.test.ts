import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHAT_TOOLS,
  chatToolStorageKey,
  parseOpenChatTool,
  readOpenChatTool,
  writeOpenChatTool,
} from '../src/components/features/channels/tool-rail/chat-tools'

type FakeStorage = {
  store: Map<string, string>
  throws: boolean
}

/**
 * These tests share their process with every other admin suite
 * (`--experimental-test-isolation=none`), so the window they borrow is put
 * back exactly as it was found — an earlier version of this file deleted the
 * global and took an unrelated tenant-branding suite down with it.
 */
const withStorage = (run: (state: FakeStorage) => void): void => {
  const state: FakeStorage = { store: new Map(), throws: false }
  const localStorage = {
    getItem: (key: string): string | null => {
      if (state.throws) throw new Error('storage blocked')
      return state.store.get(key) ?? null
    },
    removeItem: (key: string): void => {
      if (state.throws) throw new Error('storage blocked')
      state.store.delete(key)
    },
    setItem: (key: string, value: string): void => {
      if (state.throws) throw new Error('storage blocked')
      state.store.set(key, value)
    },
  }

  const host = (globalThis as { window?: object }).window
  if (host) {
    const previous = Object.getOwnPropertyDescriptor(host, 'localStorage')
    Object.defineProperty(host, 'localStorage', { configurable: true, value: localStorage })
    try {
      run(state)
    } finally {
      if (previous) Object.defineProperty(host, 'localStorage', previous)
      else Reflect.deleteProperty(host, 'localStorage')
    }
    return
  }

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } })
  try {
    run(state)
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('chat tools', () => {
  it('every tool says which question it answers', () => {
    // Rule zero check 3: a rail button with no stated decision is decoration.
    for (const tool of CHAT_TOOLS) {
      assert.ok(tool.label.length > 0, `${tool.id} has no label`)
      assert.ok(tool.description.length > 0, `${tool.id} has no description`)
    }
  })

  it('reads back the tool it stored, per agent', () => {
    withStorage((state) => {
      writeOpenChatTool('agent-a', 'browser')
      assert.equal(readOpenChatTool('agent-a'), 'browser')
      // A second agent's rail is its own: no bleed from the first.
      assert.equal(readOpenChatTool('agent-b'), null)
      assert.equal(state.store.get(chatToolStorageKey('agent-a')), 'browser')
    })
  })

  it('closing removes the preference rather than storing a closed marker', () => {
    withStorage((state) => {
      writeOpenChatTool('agent-a', 'browser')
      writeOpenChatTool('agent-a', null)
      assert.equal(state.store.has(chatToolStorageKey('agent-a')), false)
      assert.equal(readOpenChatTool('agent-a'), null)
    })
  })

  it('ignores a retired or hand-edited tool id', () => {
    withStorage((state) => {
      state.store.set(chatToolStorageKey('agent-a'), 'telepathy')
      assert.equal(readOpenChatTool('agent-a'), null)
    })
    assert.equal(parseOpenChatTool(null), null)
    assert.equal(parseOpenChatTool(''), null)
    assert.equal(parseOpenChatTool('browser'), 'browser')
  })

  it('survives storage being blocked', () => {
    withStorage((state) => {
      state.throws = true
      assert.equal(readOpenChatTool('agent-a'), null)
      // The write must not escape either: a private window would otherwise
      // take the whole conversation down on a rail click.
      assert.doesNotThrow(() => writeOpenChatTool('agent-a', 'browser'))
    })
  })

  it('has no rail without an agent', () => {
    withStorage(() => {
      assert.equal(readOpenChatTool(null), null)
      assert.doesNotThrow(() => writeOpenChatTool(null, 'browser'))
    })
  })
})
