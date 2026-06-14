import { useMemo, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  useCreateToolGrant,
  useDeleteToolGrant,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'

/**
 * Per-agent grant matrix. Each cell flips an `allowed` grant on/off for the
 * given (tool, agent) pair via POST `/api/mcp/tools/{toolId}/grants` and
 * DELETE `/api/mcp/tools/{toolId}/grants/{grantId}`.
 *
 * Existing grants arrive on the registry record (`tool.grants`, joined by the
 * list endpoint) and seed each cell's baseline. A `denied` grant (deny-overrides)
 * is surfaced as a distinct read-only state so an `allowed` grant is never
 * stacked on top of it. Each cell owns its own mutation, so it flips optimistically
 * and disables only itself while the request is in flight.
 */

type AgentGrantMatrixProps = {
  agents: AgentRecord[]
  tools: McpToolRegistryRecord[]
}

type CellBaseline = { allowedGrantId: string | null; denied: boolean }

const TINY_LABEL = ['text-[10px] uppercase tracking-[0.18em] text-[color:var(--tx3)]'].join(' ')

const cellKey = (toolId: string, agentId: string) => `${toolId}:${agentId}`

type GrantCellProps = {
  toolId: string
  toolLabel: string
  agentId: string
  agentName: string
  baseline: CellBaseline
}

const GrantCell = ({ toolId, toolLabel, agentId, agentName, baseline }: GrantCellProps) => {
  const createGrant = useCreateToolGrant()
  const deleteGrant = useDeleteToolGrant()
  // `undefined` => use the baseline from tool.grants; an explicit value is an
  // optimistic this-session override that wins until the refetch catches up.
  const [override, setOverride] = useState<{ allowed: boolean; grantId: string | null } | undefined>()
  const [error, setError] = useState<string | null>(null)
  const pending = createGrant.isPending || deleteGrant.isPending

  if (baseline.denied) {
    return (
      <td className="px-3 py-2 align-top">
        <span
          aria-label={`${toolLabel} is denied for ${agentName}`}
          className={[
            'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
            'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
          ].join(' ')}
        >
          denied
        </span>
      </td>
    )
  }

  const allowedGrantId = override ? (override.allowed ? override.grantId : null) : baseline.allowedGrantId
  const checked = override ? override.allowed : baseline.allowedGrantId !== null

  const toggle = (next: boolean) => {
    setError(null)
    if (!next) {
      if (!allowedGrantId) {
        setOverride({ allowed: false, grantId: null })
        return
      }
      setOverride({ allowed: false, grantId: null })
      deleteGrant.mutate(
        { toolRegistryEntryId: toolId, grantId: allowedGrantId },
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
      { toolRegistryEntryId: toolId, agentId, state: 'allowed' },
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
    <td className="px-3 py-2 align-top">
      <label className="inline-flex items-center gap-2 text-[color:var(--tx2)]">
        <input
          aria-label={`Grant ${toolLabel} to ${agentName}`}
          checked={checked}
          disabled={pending}
          onChange={(event) => toggle(event.target.checked)}
          type="checkbox"
        />
        <span className="text-[11px]">{checked ? 'allowed' : 'grant'}</span>
      </label>
      {error ? (
        <div className="mt-1 text-[10px] text-[var(--danger-text)]" role="alert">
          {error}
        </div>
      ) : null}
    </td>
  )
}

export const AgentGrantMatrix = ({ agents, tools }: AgentGrantMatrixProps) => {
  // Baseline per (tool, agent) from persisted, agent-scoped grants. Deny wins.
  const baselines = useMemo(() => {
    const map = new Map<string, CellBaseline>()
    for (const tool of tools) {
      for (const grant of tool.grants) {
        if (!grant.agentId) {
          continue
        }
        const key = cellKey(tool.id, grant.agentId)
        const existing = map.get(key) ?? { allowedGrantId: null, denied: false }
        if (grant.state === 'denied') {
          existing.denied = true
        } else if (grant.state === 'allowed') {
          existing.allowedGrantId = grant.id
        }
        map.set(key, existing)
      }
    }
    return map
  }, [tools])

  if (agents.length === 0 || tools.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
        Need at least one agent and one tool to build a grant matrix.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)]">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={`${TINY_LABEL} sticky left-0 bg-[var(--scrim)] px-3 py-2 text-left`} scope="col">
              Tool
            </th>
            {agents.map((agent) => (
              <th className={`${TINY_LABEL} px-3 py-2 text-left`} key={agent.id} scope="col">
                {agent.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr className="border-t border-[color:var(--sep)]" key={tool.id}>
              <th
                className={[
                  'sticky left-0 bg-[var(--scrim)] px-3 py-2 text-left',
                  'text-xs font-medium text-[var(--tx)]',
                ].join(' ')}
                scope="row"
              >
                {tool.label}
                <div className="text-[10px] text-[color:var(--tx3)]">{tool.toolId}</div>
              </th>
              {agents.map((agent) => (
                <GrantCell
                  agentId={agent.id}
                  agentName={agent.name}
                  baseline={baselines.get(cellKey(tool.id, agent.id)) ?? { allowedGrantId: null, denied: false }}
                  key={agent.id}
                  toolId={tool.id}
                  toolLabel={tool.label}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
