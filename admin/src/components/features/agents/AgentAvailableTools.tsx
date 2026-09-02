import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  buildToolPolicy,
  isToolEnabled,
  useDesignerToolCatalog,
} from '../../../facades/designer/tool-catalog'
import { useUpdateAgent } from '../../../facades/agents/hooks'
import { Card } from '../../shared/Card'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { QueryState } from '../../shared/QueryState'
import { useIsOwner } from '../../shared/OwnerGate'
import { ToolPicker } from './designer/ToolPicker'
import { useDesignerAssistantPanel } from './designer/DesignerAssistantPanelContext'
import { revealDesignerControl } from './designer/reveal-control'

/**
 * The agent's Tools tab: the single place an agent's tool access is managed.
 * Owners get the enable/disable switches (the same ToolPicker the create-agent
 * designer uses) plus an inline Save; everyone else sees the resolved read-only
 * list — the same resolution the worker applies at run time. Protected
 * explicit-grant tools are never listed here; the server preserves them across
 * a save.
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
    void updateAgent.mutateAsync({ agentId: agent.id, toolPolicy: nextPolicy })
  }

  const changeTool = useCallback((toolId: string, enabled: boolean, delay = 0) => {
    window.setTimeout(() => {
      revealDesignerControl(`agent-tool-${toolId}`)
      // Let the smooth reveal begin before changing the same switch a person
      // would click. This preserves the visible cause-and-effect relationship.
      window.setTimeout(() => {
        setToolState((previous) => ({ ...previous, [toolId]: enabled }))
      }, 180)
    }, delay)
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

const AgentToolsReadOnly = ({ agent }: { agent: AgentRecord }) => {
  const toolCatalog = useDesignerToolCatalog(false)
  const { groups } = toolCatalog
  const policy = agent.toolPolicy ?? {}

  return (
    <QueryState
      className="py-6"
      emptyLabel="No tools configured."
      errorLabel="Tools could not be loaded."
      isEmpty={groups.length === 0}
      loadingLabel="Loading tools…"
      query={toolCatalog}
    >
      {() => (
        <div className="grid gap-6">
          {groups.map((group) => (
            <section className="grid gap-2" key={group.name}>
              <SectionLabel>{group.name}</SectionLabel>
              <div className="grid gap-2">
                {group.tools.map((tool) => {
                  const enabled = isToolEnabled(tool, policy)
                  return (
                    <Card className={enabled ? '' : 'opacity-60'} key={tool.key}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono text-sm text-[var(--thinking)]">{tool.label}</div>
                        <Pill tone={enabled ? 'success' : 'muted'}>
                          {enabled ? 'enabled' : 'off'}
                        </Pill>
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx3)]">{tool.description}</div>
                    </Card>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </QueryState>
  )
}

export const AgentAvailableTools = ({ agent, editable = true }: AgentAvailableToolsProps) => {
  const isOwner = useIsOwner()

  return isOwner && editable ? (
    <AgentToolsEditor agent={agent} />
  ) : (
    <AgentToolsReadOnly agent={agent} />
  )
}
