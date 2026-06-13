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
 * list endpoint) and seed each cell's baseline, so persisted grants render
 * `allowed` with their id on first paint and can be revoked directly. Session
 * edits override the baseline: a value in `recent` (a `CellState`, or `null`
 * for a grant revoked this session) wins over `tool.grants`.
 */

type AgentGrantMatrixProps = {
  agents: AgentRecord[]
  tools: McpToolRegistryRecord[]
}

type CellState = {
  state: 'allowed'
  grantId: string | null
}

const TINY_LABEL = [
  'text-[10px] uppercase tracking-[0.18em] text-[color:var(--tx3)]',
].join(' ')

const cellKey = (toolId: string, agentId: string) => `${toolId}:${agentId}`

export const AgentGrantMatrix = ({ agents, tools }: AgentGrantMatrixProps) => {
  const createGrant = useCreateToolGrant()
  const deleteGrant = useDeleteToolGrant()
  // Absent key => use the persisted baseline; an explicit value (CellState or
  // null) is a this-session override that wins over `tool.grants`.
  const [recent, setRecent] = useState<Record<string, CellState | null>>({})
  const [cellError, setCellError] = useState<Record<string, string>>({})

  // Baseline from persisted, agent-scoped `allowed` grants on the registry rows.
  const persisted = useMemo(() => {
    const map: Record<string, CellState> = {}
    for (const tool of tools) {
      for (const grant of tool.grants) {
        if (grant.agentId && grant.state === 'allowed') {
          map[cellKey(tool.id, grant.agentId)] = {
            state: 'allowed',
            grantId: grant.id,
          }
        }
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
            <th className={`${TINY_LABEL} sticky left-0 bg-[var(--scrim)] px-3 py-2 text-left`}>
              Tool
            </th>
            {agents.map((agent) => (
              <th className={`${TINY_LABEL} px-3 py-2 text-left`} key={agent.id}>
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
              >
                {tool.label}
                <div className="text-[10px] text-[color:var(--tx3)]">
                  {tool.toolId}
                </div>
              </th>
              {agents.map((agent) => {
                const key = cellKey(tool.id, agent.id)
                const cell = key in recent ? recent[key] : persisted[key]
                const checked = cell?.state === 'allowed'
                const error = cellError[key]
                return (
                  <td className="px-3 py-2 align-top" key={key}>
                    <label className="inline-flex items-center gap-2 text-[color:var(--tx2)]">
                      <input
                        checked={checked}
                        onChange={(event) => {
                          setCellError((current) => {
                            const next = { ...current }
                            delete next[key]
                            return next
                          })
                          if (!event.target.checked) {
                            const grantId = cell?.grantId ?? null
                            if (!grantId) {
                              // Persisted and session grants both carry ids, so
                              // this only trips if a create returned no id.
                              setCellError((current) => ({
                                ...current,
                                [key]:
                                  'Grant id unavailable — reload before revoking.',
                              }))
                              return
                            }
                            deleteGrant.mutate(
                              {
                                toolRegistryEntryId: tool.id,
                                grantId,
                              },
                              {
                                onSuccess: () =>
                                  setRecent((current) => ({
                                    ...current,
                                    [key]: null,
                                  })),
                                onError: (caught) =>
                                  setCellError((current) => ({
                                    ...current,
                                    [key]:
                                      caught instanceof Error
                                        ? caught.message
                                        : 'Failed to revoke',
                                  })),
                              },
                            )
                            return
                          }
                          createGrant.mutate(
                            {
                              toolRegistryEntryId: tool.id,
                              agentId: agent.id,
                              state: 'allowed',
                            },
                            {
                              onSuccess: (grant) => {
                                const newGrantId = grant?.id ?? null
                                if (!newGrantId) {
                                  setCellError((current) => ({
                                    ...current,
                                    [key]:
                                      'Grant created but id missing in response — reload to revoke.',
                                  }))
                                  return
                                }
                                setRecent((current) => ({
                                  ...current,
                                  [key]: {
                                    state: 'allowed',
                                    grantId: newGrantId,
                                  },
                                }))
                              },
                              onError: (caught) =>
                                setCellError((current) => ({
                                  ...current,
                                  [key]:
                                    caught instanceof Error
                                      ? caught.message
                                      : 'Failed to grant',
                                })),
                            },
                          )
                        }}
                        type="checkbox"
                      />
                      <span className="text-[11px]">
                        {checked ? 'allowed' : 'grant'}
                      </span>
                    </label>
                    {error ? (
                      <div className="mt-1 text-[10px] text-[var(--danger-text)]">
                        {error}
                      </div>
                    ) : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
