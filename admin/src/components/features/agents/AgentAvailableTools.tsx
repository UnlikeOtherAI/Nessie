import type { AgentRecord } from '../../../lib/api-client'
import {
  isToolEnabled,
  useDesignerToolCatalog,
} from '../../../facades/designer/tool-catalog'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { StatusPill } from '../../primitives/StatusPill'
import { EmptyState } from '../../shared/EmptyState'

/**
 * Read-only view of the tools this agent can actually use, resolved from the
 * org tool catalog and the agent's `toolPolicy` — the same resolution the
 * worker applies at run time.
 */

type AgentAvailableToolsProps = {
  agent: AgentRecord
}

export const AgentAvailableTools = ({ agent }: AgentAvailableToolsProps) => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { groups, isLoading } = useDesignerToolCatalog(isOwner)
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
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            {group.name}
          </div>
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
                    <StatusPill tone={enabled ? 'success' : 'muted'}>
                      {enabled ? 'enabled' : 'off'}
                    </StatusPill>
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
