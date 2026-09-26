import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import {
  DesignerAssistantPanelProvider,
  useDesignerAssistantPanel,
} from '../src/components/features/agents/designer/DesignerAssistantPanelContext.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the agent page keeps one full-height Design Assistant dock beside every tab', () => {
  const page = readSource('../src/components/features/agents/page/AgentPage.tsx')
  const dock = readSource('../src/components/features/agents/designer/DesignerAssistantDock.tsx')

  // One dock, for someone who manages the agent, outside the tab switch.
  assert.match(page, /\{manages \? \(\n\s+<DesignerAssistantDock/)
  assert.match(page, /pageContext=\{agentPageAssistantContext\(tab\)\}/)
  assert.match(dock, /aria-label="Design Assistant"/)
  assert.match(dock, /Open Design Assistant/)
  assert.match(dock, /transition-\[width,height,opacity\]/)
})

test('agent rows open the agent page, the only way into editing', () => {
  const list = readSource('../src/components/features/agents/AgentsList.tsx')
  const table = readSource('../src/components/features/agents/AgentsTable.tsx')
  const row = readSource('../src/components/features/agents/AgentListRow.tsx')

  assert.match(list, /onOpen=\{\(agentId\) => void navigate\(`\/admin\/agents\/\$\{agentId\}`\)\}/)
  assert.doesNotMatch(list, /agents\/designer/)
  assert.doesNotMatch(table, /onEdit|showMenu/)
  assert.doesNotMatch(row, /AgentRowMenu|Edit in designer|Actions for/)
})

test('assistant-driven controls reveal the real UI before changing it', () => {
  const reveal = readSource('../src/components/features/agents/designer/reveal-control.ts')
  const tools = readSource('../src/components/features/agents/AgentAvailableTools.tsx')
  const assistant = readSource('../src/components/features/agents/page/useAgentDesignAssistant.ts')

  assert.match(reveal, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(reveal, /designer-control-highlight/)
  assert.match(tools, /revealDesignerControl\(`agent-tool-\$\{toolId\}`\)/)
  assert.match(tools, /setToolState/)
  // The page shows the tab first, then the control.
  assert.match(assistant, /if \(tab && showTab\) showTab\(tab\)/)
  assert.match(assistant, /afterTabRenders\(\(\) => revealDesignerToolCall\(name\)\)/)
})

test('chat input carries the current page, and an existing agent’s tool toggles go to its Access tab', () => {
  const chat = readSource('../src/facades/designer/hooks.ts')
  const assistant = readSource('../src/components/features/agents/page/useAgentDesignAssistant.ts')

  assert.match(chat, /pageContext: options\.pageContext/)
  assert.match(
    assistant,
    /if \(agentId && panel && isAssistantToolToggle\(name\)\) return panel\.dispatchToolCall\(name, args\)/,
  )
})

/**
 * The page switches to Access when the assistant toggles a tool, and the tools
 * editor registers only once it mounts there. A toggle that arrives in between
 * is held and handed over on registration rather than lost.
 */
test('a tool toggle that arrives before the Access tab mounts is replayed into it', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { document: globals.document, window: globals.window }
  globals.window = dom.window
  globals.document = dom.window.document
  ;(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const received: string[] = []
  let dispatchedBeforeMount: boolean | null = null

  const Early = () => {
    const panel = useDesignerAssistantPanel()
    useEffect(() => {
      dispatchedBeforeMount = panel?.dispatchToolCall('toggle_tool', { enabled: true, toolId: 'web_search' }) ?? null
    }, [panel])
    return null
  }
  const Late = () => {
    const panel = useDesignerAssistantPanel()
    useEffect(() => {
      panel?.registerActionHandler((name, args) => {
        received.push(`${name}:${String(args.toolId)}`)
        return true
      })
      return () => panel?.registerActionHandler(null)
    }, [panel])
    return null
  }

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  try {
    await act(async () => {
      root.render(createElement(DesignerAssistantPanelProvider, null, createElement(Early)))
    })
    assert.equal(dispatchedBeforeMount, true, 'a held call counts as handled, not applied to the form')
    assert.deepEqual(received, [])
    await act(async () => {
      root.render(createElement(DesignerAssistantPanelProvider, null, createElement(Early), createElement(Late)))
    })
    assert.deepEqual(received, ['toggle_tool:web_search'])
  } finally {
    await act(async () => root.unmount())
    globals.window = saved.window
    globals.document = saved.document
  }
})
