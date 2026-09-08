import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import {
  CHAT_TOOLS,
  CHAT_TOOL_AGENT_WATCH_LIMIT,
  CHAT_TOOL_IDS,
  anyConversationRunning,
  availableChatTools,
  chatToolAgentStorageKey,
  chatToolAgentsToWatch,
  chatToolStorageKey,
  hasOtherRunningConversation,
  parseChatToolAgentId,
  parseOpenChatTool,
  readChatToolAgentId,
  readOpenChatTool,
  resolveChatToolAgents,
  selectedChatToolAgent,
  writeChatToolAgentId,
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

  it('availability is read from the agent records, never guessed', () => {
    // Conversations exist for every agent that can be talked to; the browser
    // exists only where the explicit browser_open grant does, which is exactly
    // what `browserEnabled` projects.
    assert.deepEqual(
      availableChatTools([agent({ browserEnabled: true })]).map((tool) => tool.id),
      ['conversations', 'browser'],
    )
    assert.deepEqual(
      availableChatTools([agent({ browserEnabled: false })]).map((tool) => tool.id),
      ['conversations'],
    )
    // An absent flag is not a browser: a missing grant is an unavailable
    // capability, not a read that failed.
    assert.deepEqual(
      availableChatTools([agent()]).map((tool) => tool.id),
      ['conversations'],
    )
    assert.deepEqual(availableChatTools([]), [])
  })

  it('a room with several agents offers conversations and no browser', () => {
    // A browser column is one agent's screen, and the room has two: rather
    // than guess whose, the tool is withheld while the list — which says which
    // agent it is showing — stays.
    const room = [
      agent({ browserEnabled: true }),
      agent({ browserEnabled: true, id: 'agent-2', name: 'Editor' }),
    ]
    assert.deepEqual(
      availableChatTools(room).map((tool) => tool.id),
      ['conversations'],
    )
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

describe('whose tools the rail offers', () => {
  const researcher = agent()
  const editor = agent({ id: 'agent-2', name: 'Editor' })
  const assistant = agent({ id: 'agent-pa', name: 'Personal Assistant', systemManaged: true })

  it('inside a conversation, the thread\u2019s own agent and nobody else', () => {
    // The thread is *with* that agent (`threads.agent_id`), so the tools beside
    // it are its own even in a room full of others.
    assert.deepEqual(
      resolveChatToolAgents({
        boundAgents: [researcher, editor],
        conversationAgent: null,
        conversationThreadAgent: editor,
        inConversation: true,
      }).map((entry) => entry.id),
      ['agent-2'],
    )
  })

  it('a DM or the assistant\u2019s room: the one agent it is with', () => {
    assert.deepEqual(
      resolveChatToolAgents({
        boundAgents: [],
        conversationAgent: assistant,
        conversationThreadAgent: null,
        inConversation: false,
      }).map((entry) => entry.id),
      ['agent-pa'],
    )
  })

  it('an ordinary room: every agent bound to it, in the order they were bound', () => {
    // This is the whole defect: a project channel with agents in it offered no
    // doorway at all, while `GET /api/agents/:id/conversations` listed that
    // very room for the same reader.
    assert.deepEqual(
      resolveChatToolAgents({
        boundAgents: [researcher, editor],
        conversationAgent: null,
        conversationThreadAgent: null,
        inConversation: false,
      }).map((entry) => entry.id),
      ['agent-1', 'agent-2'],
    )
  })

  it('a room with nobody in it draws no rail, exactly as before', () => {
    assert.deepEqual(
      resolveChatToolAgents({
        boundAgents: [],
        conversationAgent: null,
        conversationThreadAgent: null,
        inConversation: false,
      }),
      [],
    )
  })

  it('a conversation whose agent has not resolved yet keeps the room\u2019s own', () => {
    // The record is one read behind the room; falling to nothing would blink
    // the rail out mid-navigation.
    assert.deepEqual(
      resolveChatToolAgents({
        boundAgents: [researcher, editor],
        conversationAgent: null,
        conversationThreadAgent: null,
        inConversation: true,
      }).map((entry) => entry.id),
      ['agent-1', 'agent-2'],
    )
  })
})

describe('which agent the column is about', () => {
  const researcher = agent()
  const editor = agent({ id: 'agent-2', name: 'Editor' })

  it('remembers the choice per room', () => {
    withStorage((state) => {
      writeChatToolAgentId('channel-a', 'agent-2')
      assert.equal(readChatToolAgentId('channel-a'), 'agent-2')
      // Another room is its own choice: the agents differ, so the preference
      // cannot be shared.
      assert.equal(readChatToolAgentId('channel-b'), null)
      assert.equal(state.store.get(chatToolAgentStorageKey('channel-a')), 'agent-2')
    })
  })

  it('tolerates garbage, and an agent that has left the room', () => {
    const agents = [researcher, editor]
    assert.equal(parseChatToolAgentId('agent-2', agents), 'agent-2')
    assert.equal(parseChatToolAgentId(null, agents), null)
    assert.equal(parseChatToolAgentId('', agents), null)
    assert.equal(parseChatToolAgentId('{"agentId":"agent-2"}', agents), null)
    // Unbound between two visits: the stored id names nobody here any more.
    assert.equal(parseChatToolAgentId('agent-9', agents), null)
    assert.equal(parseChatToolAgentId('agent-2', []), null)
  })

  it('defaults to the first bound agent, and never to an empty column', () => {
    const agents = [researcher, editor]
    assert.equal(selectedChatToolAgent(agents, 'agent-2')?.id, 'agent-2')
    assert.equal(selectedChatToolAgent(agents, null)?.id, 'agent-1')
    assert.equal(selectedChatToolAgent(agents, 'agent-9')?.id, 'agent-1')
    assert.equal(selectedChatToolAgent([], 'agent-1'), null)
  })

  it('survives storage being blocked', () => {
    withStorage((state) => {
      state.throws = true
      assert.equal(readChatToolAgentId('channel-a'), null)
      assert.doesNotThrow(() => writeChatToolAgentId('channel-a', 'agent-1'))
    })
  })

  it('has nothing to remember without a room', () => {
    withStorage(() => {
      assert.equal(readChatToolAgentId(null), null)
      assert.doesNotThrow(() => writeChatToolAgentId(null, 'agent-1'))
    })
  })
})

describe('the conversations live dot', () => {
  const researcher = agent()
  const editor = agent({ id: 'agent-2', name: 'Editor' })
  const row = (id: string, running: boolean) => ({
    activeRun: running ? { id: 'run-1', status: 'running' } : null,
    id,
  })

  it('means a conversation is running somewhere the reader is not', () => {
    // The thread on screen already shows its own run in the thinking bubble,
    // so counting it would leave the dot lit for what is being looked at.
    assert.equal(hasOtherRunningConversation([row('t-1', true)], 't-1'), false)
    assert.equal(hasOtherRunningConversation([row('t-1', true)], 't-2'), true)
    assert.equal(hasOtherRunningConversation([row('t-1', false)], 't-2'), false)
    assert.equal(hasOtherRunningConversation([], 't-2'), false)
    // No thread on screen at all (a room's General row): every run counts.
    assert.equal(hasOtherRunningConversation([row('t-1', true)], null), true)
  })

  it('lights for any agent the rail names, and for none it does not', () => {
    const agents = [researcher, editor]
    assert.equal(anyConversationRunning({}, agents), false)
    assert.equal(anyConversationRunning({ 'agent-1': false, 'agent-2': false }, agents), false)
    // The second agent in the room is running something: that is exactly the
    // case a single-subject rail could not report.
    assert.equal(anyConversationRunning({ 'agent-2': true }, agents), true)
    // A reading left over from an agent the rail no longer names is ignored
    // rather than kept alight.
    assert.equal(anyConversationRunning({ 'agent-9': true }, agents), false)
    assert.equal(anyConversationRunning({ 'agent-1': true }, []), false)
  })

  it('polls every agent up to the cap, and only the selected one past it', () => {
    const many = Array.from({ length: CHAT_TOOL_AGENT_WATCH_LIMIT + 1 }, (_, index) =>
      agent({ id: `agent-${index}`, name: `Agent ${index}` }))
    const few = many.slice(0, CHAT_TOOL_AGENT_WATCH_LIMIT)
    assert.deepEqual(
      chatToolAgentsToWatch(few, 'agent-0').map((entry) => entry.id),
      few.map((entry) => entry.id),
    )
    assert.deepEqual(
      chatToolAgentsToWatch(many, 'agent-3').map((entry) => entry.id),
      ['agent-3'],
    )
  })
})
