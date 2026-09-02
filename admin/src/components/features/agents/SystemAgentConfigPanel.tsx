import { useMemo } from 'react'
import type { AgentConfigView, ResolvedAgentTool } from '@nessie/schemas'

import { useAgentConfig } from '../../../facades/agents/hooks'
import { QueryState } from '../../shared/QueryState'
import { EmptyState } from '../../shared/EmptyState'
import { SectionLabel } from '../../primitives/SectionLabel'

/**
 * What a Nessie-managed agent is, for someone who may read it and nothing else.
 *
 * A global agent used to be list-only — the detail page mounted the ordinary
 * tabs and every one of them 404'd, so "you cannot edit this" rendered as "this
 * is broken". This panel renders the narrow configuration read instead
 * (`GET /api/agents/:id/config`), and deliberately shows nothing operational:
 * no status, no activity, no messages, no sub-agents. The Agent Designer is an
 * organisation-wide singleton whose activity spans every member's private DM.
 *
 * There are no edit affordances anywhere on it, by construction rather than by
 * disabling: these agents are defined by the deployment and change by redeploy.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D7).
 */

const Field = ({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) => (
  <div className="grid gap-1 py-3">
    <div className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">{label}</div>
    <div className="text-sm text-[color:var(--tx)]">{children}</div>
  </div>
)

const TOOL_SOURCE_NOTE: Record<ResolvedAgentTool['source'], string> = {
  default: 'on by default',
  policy: 'switched on for this agent',
  reserved: 'reserved for this built-in agent, in its own conversation only',
}

const RunLimits = ({ view }: { view: AgentConfigView }) => {
  const entries = Object.entries(view.config.runLimits ?? {}).filter(
    ([, value]) => value !== undefined && value !== null,
  )
  if (entries.length === 0) {
    return <span className="text-[color:var(--tx2)]">The deployment backstop.</span>
  }
  return (
    <span>
      {entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}
    </span>
  )
}

export const SystemAgentConfigPanel = ({ agentId }: { agentId: string }) => {
  const query = useAgentConfig(agentId)
  const view = query.data

  const toolGroups = useMemo(() => {
    const byGroup = new Map<string, ResolvedAgentTool[]>()
    for (const tool of view?.tools ?? []) {
      byGroup.set(tool.group, [...(byGroup.get(tool.group) ?? []), tool])
    }
    return [...byGroup.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [view?.tools])

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <QueryState
        emptyLabel="This agent’s configuration could not be read."
        errorLabel="This agent’s configuration could not be loaded."
        isEmpty={!view}
        loadingLabel="Loading configuration…"
        query={query}
      >
        {() =>
          view ? (
            <div className="grid gap-6">
              <section className="admin-card p-4">
                <SectionLabel>Configuration</SectionLabel>
                <p className="mt-2 text-sm text-[color:var(--tx2)]">
                  {view.systemSlug
                    ? 'A built-in agent provided by Nessie. It is the same in every '
                      + 'workspace and changes only when the deployment is updated — '
                      + 'nobody edits it here, organisation owners included.'
                    : 'A Nessie-managed agent. Its configuration is provided by the '
                      + 'deployment and is not editable here.'}
                </p>
                <div className="mt-2 divide-y divide-[color:var(--sep)]">
                  <Field label="Name">{view.config.name}</Field>
                  <Field label="Role">{view.config.role}</Field>
                  <Field label="Model">
                    {view.config.model
                      ? `${view.config.model}${
                        view.config.provider ? ` (${view.config.provider})` : ''}`
                      : 'The organisation’s default model.'}
                  </Field>
                  <Field label="Reasoning effort">{view.config.effort ?? 'medium'}</Field>
                  <Field label="Run limits">
                    <RunLimits view={view} />
                  </Field>
                </div>
              </section>

              <section className="admin-card p-4">
                <SectionLabel>Instructions</SectionLabel>
                {view.config.systemPrompt ? (
                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[color:var(--tx)]">
                    {view.config.systemPrompt}
                  </pre>
                ) : (
                  <EmptyState>This agent carries no stored instructions.</EmptyState>
                )}
              </section>

              <section className="admin-card p-4">
                <SectionLabel>Tools ({view.tools.length})</SectionLabel>
                {toolGroups.length === 0 ? (
                  <EmptyState>This agent has no tools.</EmptyState>
                ) : (
                  <div className="mt-3 grid gap-4">
                    {toolGroups.map(([group, tools]) => (
                      <div key={group}>
                        <div className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">
                          {group}
                        </div>
                        <ul className="mt-2 grid gap-1">
                          {tools.map((tool) => (
                            <li className="text-sm text-[color:var(--tx)]" key={tool.key}>
                              {tool.label}
                              <span className="ml-2 text-xs text-[color:var(--tx3)]">
                                {TOOL_SOURCE_NOTE[tool.source]}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null
        }
      </QueryState>
    </div>
  )
}
