import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import { resolveConversationAgent } from '../src/components/features/channels/channel-tabs'
import {
  CHAT_TOOLS,
  availableChatTools,
  chatToolDoorway,
  chatToolHeaderActions,
  type ChatToolId,
} from '../src/components/features/channels/tool-rail/chat-tools'
import { partitionPageHeaderActions } from '../src/components/shared/responsive-page-header-layout'
import { toScreenBarActions } from '../src/components/shared/screen-bar-actions'

/**
 * Rule zero for the agent tools: on the iOS phone app they had no doorway at
 * all. The rail correctly stands down on a single-column layout, and what was
 * left — a row on the conversation info screen — sits two screens in, behind
 * the native bar's `···` sheet. These tests hold the two halves of the rule
 * together: exactly one control carries the tools, and the one that does stays
 * on screen instead of collapsing into a menu.
 */

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  browserEnabled: true,
  channelIds: [],
  id: 'agent-1',
  lastActivityAt: new Date(0).toISOString(),
  name: 'Agent Designer',
  role: 'Designs agents',
  status: 'idle',
  systemManaged: false,
  todosEnabled: false,
  ...overrides,
} as AgentRecord)

const conversation = {
  boundAgents: [] as AgentRecord[],
  isConversationSurface: true,
  isPersonalAssistantConversation: false,
  personalAssistantAgent: null as AgentRecord | null,
}

const doorwayFor = (boundAgents: AgentRecord[], single: boolean) =>
  chatToolDoorway({
    hasConversationAgent:
      resolveConversationAgent({ ...conversation, boundAgents }) !== null,
    single,
  })

describe('chat tool doorway', () => {
  it('gives a one-agent conversation a doorway on every layout', () => {
    assert.equal(doorwayFor([agent()], true), 'header')
    assert.equal(doorwayFor([agent()], false), 'rail')
  })

  it('offers the tools once, never twice and never nowhere', () => {
    for (const single of [false, true]) {
      const doorway = doorwayFor([agent()], single)
      const railDrawn = doorway === 'rail'
      const headerActions = chatToolHeaderActions({
        agent: agent(),
        onOpenTool: () => undefined,
        single,
      })
      assert.notEqual(doorway, 'none')
      assert.equal(railDrawn, headerActions.length === 0)
    }
  })

  it('has no doorway where the conversation has no single agent', () => {
    // A person-to-person DM: nothing whose tools these would be.
    assert.equal(doorwayFor([], true), 'none')
    assert.equal(doorwayFor([], false), 'none')
    // A room carrying two agents: one agent's browser must not be handed to
    // the other's panel, so neither is offered.
    const twoAgents = [agent(), agent({ id: 'agent-2', name: 'Second' })]
    assert.equal(doorwayFor(twoAgents, true), 'none')
    assert.equal(doorwayFor(twoAgents, false), 'none')
    // …and an ordinary channel, which resolves no conversation agent at all.
    assert.equal(
      chatToolDoorway({
        hasConversationAgent:
          resolveConversationAgent({
            ...conversation,
            boundAgents: [agent()],
            isConversationSurface: false,
          }) !== null,
        single: true,
      }),
      'none',
    )
    assert.deepEqual(
      chatToolHeaderActions({
        agent: null,
        onOpenTool: () => undefined,
        single: true,
      }),
      [],
    )
  })

  it('carries every tool the agent has, and opens the one that was pressed', () => {
    const opened: ChatToolId[] = []
    const actions = chatToolHeaderActions({
      agent: agent(),
      onOpenTool: (tool) => opened.push(tool),
      single: true,
    })

    assert.deepEqual(
      actions.map((action) => action.label),
      CHAT_TOOLS.map((tool) => tool.label),
    )
    for (const action of actions) {
      assert.equal(action.kind ?? 'button', 'button')
      if ('onSelect' in action) action.onSelect()
    }
    assert.deepEqual(opened, CHAT_TOOLS.map((tool) => tool.id))
  })

  it('an agent with no browser is offered its conversations, and nothing else', () => {
    // The capability is read from the record, so a rail button never opens a
    // door onto a room the agent does not have.
    const withoutBrowser = agent({ browserEnabled: false })
    assert.deepEqual(
      availableChatTools(withoutBrowser).map((tool) => tool.id),
      ['conversations'],
    )
    assert.deepEqual(availableChatTools(null), [])
    assert.deepEqual(
      chatToolHeaderActions({
        agent: withoutBrowser,
        onOpenTool: () => undefined,
        single: true,
      }).map((action) => action.id),
      ['chat-tool-conversations'],
    )
    // …and the doorway still exists: a conversation with an agent always has
    // at least its own list to offer.
    assert.equal(
      chatToolDoorway({ hasConversationAgent: true, single: true }),
      'header',
    )
  })

  it('the doorways are icon-only, so the screen keeps its own title', () => {
    // Two labelled pills at 96px each leave a 390px phone header no room for
    // the conversation's name — measured in the browser, then pinned here.
    for (const action of chatToolHeaderActions({
      agent: agent(),
      onOpenTool: () => undefined,
      single: true,
    })) {
      assert.equal(action.compact, true, `${action.id} is not compact`)
      assert.ok(action.label.length > 0, `${action.id} lost its accessible name`)
    }
  })

  it('keeps the doorway in the web header rather than inside More', () => {
    // The narrowest realistic action lane on a phone, and every other
    // conversation control fighting it for room: `partitionPageHeaderActions`
    // sheds by priority but never sheds a primary, which is the whole reason
    // these actions are primary.
    const actions = chatToolHeaderActions({
      agent: agent(),
      onOpenTool: () => undefined,
      single: true,
    }).map((action) => ({
      id: action.id,
      primary: action.primary,
      priority: action.priority,
      // The measured width of a compact action (`w-11`), which is what these
      // are: two labelled pills squeezed the conversation's own title to zero
      // width on a 390px phone.
      width: 44,
    }))
    const crowded = [
      { id: 'favorite', priority: 90, width: 40 },
      { id: 'conversation-info', priority: 80, width: 40 },
      ...actions,
      { id: 'record-routine', priority: 55, width: 40 },
      { id: 'call', priority: 50, width: 40 },
      { id: 'search', priority: 40, width: 40 },
    ]
    const { overflowIds, visibleIds } = partitionPageHeaderActions(crowded, 120, 34)

    // Without this the loop below passes by having nothing to check, which is
    // exactly the state the bug was in.
    assert.ok(actions.length > 0, 'the phone header carried no tool at all')
    for (const action of actions) {
      assert.ok(visibleIds.includes(action.id), `${action.id} was pushed into More`)
      assert.ok(!overflowIds.includes(action.id))
    }
  })

  it('wins the iOS bar’s one inline slot, so it is not behind ···', () => {
    // The native bar draws a single action beside its `···` circle and picks it
    // with exactly this expression (`partitionNativeScreenBarActions` in the
    // iOS shell); everything else goes into the sheet. Asserted through
    // `toScreenBarActions` because that is the wire format the bar actually
    // reads — a flag that did not survive the conversion would be a doorway
    // still buried in a menu.
    const bar = toScreenBarActions(
      chatToolHeaderActions({
        agent: agent(),
        onOpenTool: () => undefined,
        single: true,
      }),
    )
    const inline = bar.find((action) => action.primary && !action.disabled) ?? null

    assert.equal(inline?.id, `chat-tool-${CHAT_TOOLS[0]?.id ?? ''}`)
    assert.equal(inline?.label, CHAT_TOOLS[0]?.label)
  })
})
