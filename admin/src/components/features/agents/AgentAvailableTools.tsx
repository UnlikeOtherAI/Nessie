import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  buildToolPolicy,
  useDesignerToolCatalog,
} from '../../../facades/designer/tool-catalog'
import { useUpdateAgent } from '../../../facades/agents/hooks'
import { useCanEditAgent } from './agent-edit-authority'
import { ToolPicker } from './designer/ToolPicker'
import { useDesignerAssistantPanel } from './designer/DesignerAssistantPanelContext'
import { revealDesignerControl } from './designer/reveal-control'

/**
 * The agent's Tools tab: the single place an agent's tool access is managed.
 * Whoever may edit this agent gets the enable/disable switches (the same
 * ToolPicker the create-agent designer uses) plus an inline Save; everyone else
 * sees the resolved read-only list — the same resolution the worker applies at
 * run time. Protected explicit-grant tools are never listed here; the server
 * preserves them across a save.
 *
 * "May edit" is `canEditAgent`, not the organization owner role: the steward of
 * a private or person-owned agent, and any entitled member of a team-owned one,
 * may change its tools too.
 */

type AgentAvailableToolsProps = {
  agent: AgentRecord
  /**
   * Whether the switches are offered. A system-managed agent (the Personal
   * Assistant) is configured through its own surface, so listing its resolved
   * tools is right and offering a Save that competes with that surface is not.
   */
  editable?: boolean
}

const sortedPolicy = (policy: Record<string, boolean>): string =>
  JSON.stringify(
    Object.keys(policy)
      .sort()
      .map((key) => [key, policy[key]]),
  )

const AgentToolsEditor = ({ agent }: { agent: AgentRecord }) => {
  const toolCatalog = useDesignerToolCatalog(true)
  const { groups, options } = toolCatalog
  const [toolState, setToolState] = useState<Record<string, boolean>>(
    () => agent.toolPolicy ?? {},
  )
  const updateAgent = useUpdateAgent()
  const assistantPanel = useDesignerAssistantPanel()

  // Compare over the visible option set only, so protected grants the server
  // keeps (and the picker never shows) do not make the tab look permanently
  // dirty.
  const savedPolicy = useMemo(
    () => buildToolPolicy(options, agent.toolPolicy ?? {}),
    [agent.toolPolicy, options],
  )
  const nextPolicy = useMemo(
    () => buildToolPolicy(options, toolState),
    [options, toolState],
  )
  const dirty = sortedPolicy(savedPolicy) !== sortedPolicy(nextPolicy)

  const save = () => {
    // No local onError: the switches simply stay at their pending state on
    // failure, and the app-wide mutation default (providers/QueryProvider.tsx)
    // surfaces the failure as a toast. `.catch` here only stops an unhandled
    // promise rejection — it does not silence the failure.
    void updateAgent.mutateAsync({ agentId: agent.id, toolPolicy: nextPolicy }).catch(() => undefined)
  }

  // The assistant can stagger many toggles across a batch (`index * 650` in
  // `handleAssistantAction` below); every scheduled timer is tracked here so
  // a tab switch away from this agent before they fire cancels them instead
  // of revealing/toggling a control that is no longer on screen.
  const toolChangeTimers = useRef<number[]>([])

  useEffect(() => () => {
    for (const timer of toolChangeTimers.current) {
      window.clearTimeout(timer)
    }
    toolChangeTimers.current = []
  }, [])

  const changeTool = useCallback((toolId: string, enabled: boolean, delay = 0) => {
    const revealTimer = window.setTimeout(() => {
      revealDesignerControl(`agent-tool-${toolId}`)
      // Let the smooth reveal begin before changing the same switch a person
      // would click. This preserves the visible cause-and-effect relationship.
      const toggleTimer = window.setTimeout(() => {
        setToolState((previous) => ({ ...previous, [toolId]: enabled }))
      }, 180)
      toolChangeTimers.current.push(toggleTimer)
    }, delay)
    toolChangeTimers.current.push(revealTimer)
  }, [])

  const handleAssistantAction = useCallback((name: string, args: Record<string, unknown>) => {
    if (name === 'toggle_tool') {
      if (typeof args.toolId !== 'string' || !args.toolId) return false
      changeTool(args.toolId, Boolean(args.enabled))
      return true
    }

    if (name !== 'batch_toggle_tools' || !Array.isArray(args.tools)) return false
    args.tools.forEach((item, index) => {
      const tool = item as { enabled?: unknown; toolId?: unknown }
      if (typeof tool.toolId === 'string') {
        changeTool(tool.toolId, Boolean(tool.enabled), index * 650)
      }
    })
    return true
  }, [changeTool])

  useEffect(() => {
    assistantPanel?.registerActionHandler(handleAssistantAction)
    return () => assistantPanel?.registerActionHandler(null)
  }, [assistantPanel, handleAssistantAction])

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[color:var(--tx3)]">
          Built-in tools are on by default; connector (MCP) tools must be switched
          on per agent.
        </p>
        <button
          className="admin-button admin-button-primary flex-shrink-0"
          disabled={!dirty || updateAgent.isPending}
          onClick={save}
          type="button"
        >
          {updateAgent.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      <ToolPicker
        groups={groups}
        onToggle={(toolKey, enabled) =>
          setToolState((prev) => ({ ...prev, [toolKey]: enabled }))
        }
        query={toolCatalog}
        toolState={toolState}
      />
    </div>
  )
}

/**
 * The same list, without the switches. It is `ToolPicker` in read-only mode
 * rather than a second renderer: the previous copy had drifted into its own
 * grouping, its own cards and no search at all, so a non-owner saw a different
 * catalogue from the one the owner was editing.
 */
const AgentToolsReadOnly = ({ agent }: { agent: AgentRecord }) => {
  const toolCatalog = useDesignerToolCatalog(false)

  return (
    <ToolPicker
      groups={toolCatalog.groups}
      onToggle={() => undefined}
      query={toolCatalog}
      readOnly
      toolState={agent.toolPolicy ?? {}}
    />
  )
}

export const AgentAvailableTools = ({ agent, editable = true }: AgentAvailableToolsProps) => {
  const canEdit = useCanEditAgent(agent)

  return canEdit && editable ? (
    <AgentToolsEditor agent={agent} />
  ) : (
    <AgentToolsReadOnly agent={agent} />
  )
}
