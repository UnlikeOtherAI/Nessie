import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import {
  CHAT_TOOLS,
  CHAT_TOOL_IDS,
  availableChatTools,
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

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  channelIds: [],
  id: 'agent-1',
  name: 'Researcher',
  role: 'Researches things',
  status: 'idle',
  systemManaged: false,
  todosEnabled: false,
  ...overrides,
} as AgentRecord)

describe('chat tools', () => {
  it('every tool says which question it answers', () => {
    // Rule zero check 3: a rail button with no stated decision is decoration.
    for (const tool of CHAT_TOOLS) {
      assert.ok(tool.label.length > 0, `${tool.id} has no label`)
      assert.ok(tool.description.length > 0, `${tool.id} has no description`)
    }
  })

  it('the list comes first — it is the agent\u2019s work, the browser is a tool it uses', () => {
    assert.deepEqual([...CHAT_TOOL_IDS], ['conversations', 'browser'])
    assert.deepEqual(CHAT_TOOLS.map((tool) => tool.id), [...CHAT_TOOL_IDS])
  })

  it('availability is read from the agent record, never guessed', () => {
    // Conversations exist for every agent that can be talked to; the browser
    // exists only where the explicit browser_open grant does, which is exactly
    // what `browserEnabled` projects.
    assert.deepEqual(
      availableChatTools(agent({ browserEnabled: true })).map((tool) => tool.id),
      ['conversations', 'browser'],
    )
    assert.deepEqual(
      availableChatTools(agent({ browserEnabled: false })).map((tool) => tool.id),
      ['conversations'],
    )
    // An absent flag is not a browser: a missing grant is an unavailable
    // capability, not a read that failed.
    assert.deepEqual(
      availableChatTools(agent()).map((tool) => tool.id),
      ['conversations'],
    )
    assert.deepEqual(availableChatTools(null), [])
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
    assert.equal(parseOpenChatTool('conversations'), 'conversations')
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
