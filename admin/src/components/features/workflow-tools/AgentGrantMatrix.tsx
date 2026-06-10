import { useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  useCreateToolGrant,
  useDeleteToolGrant,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'

/**
 * Per-agent grant matrix. Each cell flips an `allowed` grant on/off for the
 * given (tool, agent) pair via POST `/api/mcp/tools/{toolId}/grants` and
 * DELETE `/api/mcp/tools/{toolId}/grants/{grantId}` (per
 * `api/src/routes/mcp.ts`). The current `/api/mcp/tools` list response does
 * not return existing grants alongside the tool list (tracked as task #25),
 * so on uncheck we can only delete grants whose ids we captured during this
 * session (returned by the create POST). For grants created in a previous
 * session we cannot DELETE without the id and surface an inline hint asking
 * the user to reload after #25 lands.
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

export const AgentGrantMatrix = ({ agents, tools }: AgentGrantMatrixProps) => {
  const createGrant = useCreateToolGrant()
  const deleteGrant = useDeleteToolGrant()
  const [recent, setRecent] = useState<Record<string, CellState>>({})
  const [cellError, setCellError] = useState<Record<string, string>>({})

  const cellKey = (toolId: string, agentId: string) => `${toolId}:${agentId}`

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
                const cell = recent[key]
                const justGranted = cell?.state === 'allowed'
                const error = cellError[key]
                return (
                  <td className="px-3 py-2 align-top" key={key}>
                    <label className="inline-flex items-center gap-2 text-[color:var(--tx2)]">
                      <input
                        checked={justGranted}
                        onChange={(event) => {
                          setCellError((current) => {
                            const next = { ...current }
                            delete next[key]
                            return next
                          })
                          if (!event.target.checked) {
                            const grantId = cell?.grantId ?? null
                            if (!grantId) {
                              console.warn(
                                '[AgentGrantMatrix] cannot revoke grant: id unknown (see task #25)',
                                { toolId: tool.id, agentId: agent.id },
                              )
                              setCellError((current) => ({
                                ...current,
                                [key]:
                                  'Reload to see persisted grants before revoking.',
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
                                  setRecent((current) => {
                                    const next = { ...current }
                                    delete next[key]
                                    return next
                                  }),
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
                                  // Server accepted the grant (2xx) but the
                                  // response body lacked an id. Persisting a
                                  // null grantId here would later surface the
                                  // cross-session reload hint on uncheck,
                                  // which is misleading because the grant
                                  // was created in THIS session. Surface a
                                  // distinct error and leave `recent`
                                  // untouched so the checkbox falls back to
                                  // the unchecked baseline on next render
                                  // attempt while the user retries.
                                  console.warn(
                                    '[AgentGrantMatrix] create-grant succeeded without id',
                                    { toolId: tool.id, agentId: agent.id },
                                  )
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
                        {justGranted ? 'allowed' : 'grant'}
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
