import { useMemo, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  useCreateToolGrant,
  useDeleteToolGrant,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { Row, RowList } from '../../shared/RowList'
import { Pill } from '../../primitives/Pill'
import { Switch } from '../../primitives/Switch'

/**
 * Per-agent access list for one tool. Each row flips an `allowed` grant on/off
 * for the (tool, agent) pair via POST `/api/mcp/tools/{toolId}/grants` and
 * DELETE `/api/mcp/tools/{toolId}/grants/{grantId}`.
 *
 * Existing grants arrive joined on the registry record (`tool.grants`). A
 * `denied` grant (deny-overrides) renders as a read-only pill so an `allowed`
 * grant is never stacked on top of it. Each row owns its own mutation state,
 * so it flips optimistically and disables only itself while in flight.
 */

type ToolAgentAccessPanelProps = {
  agents: AgentRecord[]
  tool: McpToolRegistryRecord
}

type RowBaseline = { allowedGrantId: string | null; denied: boolean }

type AgentAccessRowProps = {
  agent: AgentRecord
  baseline: RowBaseline
  tool: McpToolRegistryRecord
}

const AgentAccessRow = ({ agent, baseline, tool }: AgentAccessRowProps) => {
  const createGrant = useCreateToolGrant()
  const deleteGrant = useDeleteToolGrant()
  // `undefined` => use the baseline from tool.grants; an explicit value is an
  // optimistic this-session override that wins until the refetch catches up.
  const [override, setOverride] = useState<
    { allowed: boolean; grantId: string | null } | undefined
  >()
  const [error, setError] = useState<string | null>(null)
  const pending = createGrant.isPending || deleteGrant.isPending

  const allowedGrantId = override
    ? override.allowed
      ? override.grantId
      : null
    : baseline.allowedGrantId
  const checked = override ? override.allowed : baseline.allowedGrantId !== null

  const toggle = (next: boolean) => {
    if (pending) return
    setError(null)
    if (!next) {
      setOverride({ allowed: false, grantId: null })
      if (!allowedGrantId) return
      deleteGrant.mutate(
        { toolRegistryEntryId: tool.id, grantId: allowedGrantId },
        {
          onError: (caught) => {
            setOverride(undefined)
            setError(caught instanceof Error ? caught.message : 'Failed to revoke')
          },
        },
      )
      return
    }
    setOverride({ allowed: true, grantId: allowedGrantId })
    createGrant.mutate(
      { toolRegistryEntryId: tool.id, agentId: agent.id, state: 'allowed' },
      {
        onSuccess: (grant) => setOverride({ allowed: true, grantId: grant?.id ?? null }),
        onError: (caught) => {
          setOverride(undefined)
          setError(caught instanceof Error ? caught.message : 'Failed to grant')
        },
      },
    )
  }

  return (
    <Row
      subtitle={agent.role}
      title={agent.name}
      trailing={
        baseline.denied ? (
          <Pill height="control" tone="danger">denied</Pill>
        ) : (
          <div className={pending ? 'opacity-50' : ''}>
            <Switch
              checked={checked}
              label={`${checked ? 'Revoke' : 'Grant'} ${tool.label} for ${agent.name}`}
              onChange={toggle}
            />
          </div>
        )
      }
    >
      {error ? <FormError className="mt-1">{error}</FormError> : null}
    </Row>
  )
}

export const ToolAgentAccessPanel = ({ agents, tool }: ToolAgentAccessPanelProps) => {
  const baselines = useMemo(() => {
    const map = new Map<string, RowBaseline>()
    for (const grant of tool.grants) {
      if (!grant.agentId) continue
      const existing = map.get(grant.agentId) ?? { allowedGrantId: null, denied: false }
      if (grant.state === 'denied') {
        existing.denied = true
      } else if (grant.state === 'allowed') {
        existing.allowedGrantId = grant.id
      }
      map.set(grant.agentId, existing)
    }
    return map
  }, [tool.grants])

  const grantedCount = useMemo(
    () =>
      agents.filter((agent) => {
        const baseline = baselines.get(agent.id)
        return baseline && !baseline.denied && baseline.allowedGrantId !== null
      }).length,
    [agents, baselines],
  )

  if (agents.length === 0) {
    return <EmptyState>No agents yet — create one to grant this tool.</EmptyState>
  }

  return (
    <div className="grid gap-2">
      <div className="text-xs text-[color:var(--tx3)]">
        {grantedCount} of {agents.length} agents granted
      </div>
      <RowList label="Agent access">
        {agents.map((agent) => (
          <AgentAccessRow
            agent={agent}
            baseline={baselines.get(agent.id) ?? { allowedGrantId: null, denied: false }}
            key={agent.id}
            tool={tool}
          />
        ))}
      </RowList>
    </div>
  )
}
