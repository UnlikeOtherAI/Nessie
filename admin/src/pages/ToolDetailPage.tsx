import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ExplicitToolAgentAccessPanel } from '../components/features/workflow-tools/ExplicitToolAgentAccessPanel'
import { ToolAgentAccessPanel } from '../components/features/workflow-tools/ToolAgentAccessPanel'
import { ToolDetailSection } from '../components/features/workflow-tools/ToolDetailSection'
import { ToolReviewActions } from '../components/features/workflow-tools/ToolReviewActions'
import { OwnerGate } from '../components/shared/OwnerGate'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { ToolBadge } from '../components/shared/ToolBadge'
import { ToolPermissionPill } from '../components/shared/ToolPermissionPill'
import { ToolTransportPill } from '../components/shared/ToolTransportPill'
import { useAgents } from '../facades/agents/hooks'
import { useIsOwner } from '../facades/auth/hooks'
import {
  useAgentToolPolicyTargets,
  useMcpToolRegistry,
} from '../facades/tool-grants/hooks'

/**
 * One tool: what it is, what it exposes, and which agents may call it.
 *
 * Reached by opening a row in the Tools table. The registry is read unfiltered
 * here — the list's `?source=`/`?status=` narrowing belongs to the list, and a
 * tool opened from a filtered page must not vanish because the filter that
 * found it is no longer applied.
 */
export const ToolDetailPage = () => {
  const navigate = useNavigate()
  const { toolId } = useParams<{ toolId?: string }>()
  const isOwner = useIsOwner()
  const toolsQuery = useMcpToolRegistry({}, isOwner)
  const agentsQuery = useAgents()
  const policyTargetsQuery = useAgentToolPolicyTargets(isOwner)

  const allTools = useMemo(() => toolsQuery.data ?? [], [toolsQuery.data])
  const tool = allTools.find((candidate) => candidate.id === toolId)

  const deepWaterDependencyPolicyKeys = useMemo(
    () =>
      allTools
        .filter((candidate) =>
          candidate.managedProductSlug === 'deep-water' && candidate.mcpInstanceId !== null)
        .map((candidate) => candidate.policyKey),
    [allTools],
  )

  const backToList = () => void navigate('/admin/advanced/tools')

  if (!tool) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ScreenHeader backLabel="Back to Tool registry" onBack={backToList} title="Tool" />
        <OwnerGate>
          <QueryState
            className="flex flex-1 items-center justify-center"
            emptyLabel="This tool is not in the registry. Its connector may have been removed."
            errorLabel="Failed to load tools."
            isEmpty
            loadingLabel="Loading tool…"
            query={toolsQuery}
          >
            {() => null}
          </QueryState>
        </OwnerGate>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        backLabel="Back to Tool registry"
        eyebrow="Tool registry"
        onBack={backToList}
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs text-[color:var(--tx3)]">{tool.toolId}</code>
            {tool.source !== 'builtin' ? (
              <ToolBadge label={tool.source} source={tool.source} />
            ) : null}
            {tool.transport !== 'direct' ? (
              <ToolTransportPill transport={tool.transport} />
            ) : null}
            {tool.status !== 'active' ? <ToolPermissionPill status={tool.status} /> : null}
          </div>
        }
        title={tool.label}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4">
        <OwnerGate>
          <div className="grid max-w-3xl gap-6">
            {tool.description ? (
              <p className="text-sm leading-6 text-[color:var(--tx2)]">{tool.description}</p>
            ) : null}

            <ToolDetailSection heading={false} tool={tool} />
            <ToolReviewActions tool={tool} />

            <section>
              <h2 className="text-sm font-semibold text-[color:var(--tx)]">Agent access</h2>
              <p className="mt-1 text-xs text-[color:var(--tx3)]">
                {tool.requiresExplicitGrant
                  ? 'This tool is off by default. Switch a row on to write the exact per-agent allow; switch it off to revoke only that allow.'
                  : 'Switch a row on to grant this tool to that agent; switch it off to revoke. A denied grant is read-only and always wins.'}
              </p>
              {/* `py-6`, not the default `py-8`: these states swap with the two
                  access panels, whose own "no agents yet" line is py-6. */}
              <div className="mt-3">
                <QueryState
                  className="py-6"
                  errorLabel="Failed to load agents."
                  loadingLabel="Loading agents…"
                  query={tool.requiresExplicitGrant ? policyTargetsQuery : agentsQuery}
                >
                  {() =>
                    tool.requiresExplicitGrant ? (
                      <ExplicitToolAgentAccessPanel
                        deepWaterDependencyPolicyKeys={deepWaterDependencyPolicyKeys}
                        targets={policyTargetsQuery.data ?? []}
                        tool={tool}
                      />
                    ) : (
                      <ToolAgentAccessPanel agents={agentsQuery.data ?? []} tool={tool} />
                    )}
                </QueryState>
              </div>
            </section>
          </div>
        </OwnerGate>
      </div>
    </div>
  )
}
