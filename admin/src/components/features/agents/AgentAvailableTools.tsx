import { useMemo, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  buildToolPolicy,
  isToolEnabled,
  useDesignerToolCatalog,
} from '../../../facades/designer/tool-catalog'
import { useUpdateAgent } from '../../../facades/agents/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { EmptyState } from '../../shared/EmptyState'
import { ToolPicker } from './designer/ToolPicker'

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
}

const sortedPolicy = (policy: Record<string, boolean>): string =>
  JSON.stringify(
    Object.keys(policy)
      .sort()
      .map((key) => [key, policy[key]]),
  )

const AgentToolsEditor = ({ agent }: AgentAvailableToolsProps) => {
  const { groups, options, isLoading } = useDesignerToolCatalog(true)
  const [toolState, setToolState] = useState<Record<string, boolean>>(
    () => agent.toolPolicy ?? {},
  )
  const updateAgent = useUpdateAgent()

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
        isLoading={isLoading}
        onToggle={(toolKey, enabled) =>
          setToolState((prev) => ({ ...prev, [toolKey]: enabled }))
        }
        toolState={toolState}
      />
    </div>
  )
}

const AgentToolsReadOnly = ({ agent }: AgentAvailableToolsProps) => {
  const { groups, isLoading } = useDesignerToolCatalog(false)
  const policy = agent.toolPolicy ?? {}

  if (isLoading) {
    return (
      <div className="py-6 text-center text-sm text-[color:var(--tx3)]">Loading tools…</div>
    )
  }

  if (groups.length === 0) {
    return <EmptyState>No tools configured.</EmptyState>
  }

  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <section className="grid gap-2" key={group.name}>
          <SectionLabel>{group.name}</SectionLabel>
          <div className="grid gap-2">
            {group.tools.map((tool) => {
              const enabled = isToolEnabled(tool, policy)
              return (
                <div
                  className={[
                    'rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-4',
                    enabled ? '' : 'opacity-60',
                  ].join(' ')}
                  key={tool.key}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-mono text-sm text-[var(--thinking)]">{tool.label}</div>
                    <Pill tone={enabled ? 'success' : 'muted'}>
                      {enabled ? 'enabled' : 'off'}
                    </Pill>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx3)]">{tool.description}</div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export const AgentAvailableTools = ({ agent }: AgentAvailableToolsProps) => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  return isOwner ? (
    <AgentToolsEditor agent={agent} />
  ) : (
    <AgentToolsReadOnly agent={agent} />
  )
}
