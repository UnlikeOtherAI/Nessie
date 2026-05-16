import { useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  useCreateToolGrant,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'

/**
 * Per-agent grant matrix. Each cell flips an `allowed` grant on/off for the
 * given (tool, agent) pair via POST `/api/mcp/tools/{toolId}/grants` (per
 * `api/src/routes/mcp.ts`). The current API surface does not return existing
 * grants alongside the tool list — only a write path — so this slice exposes
 * the "create grant" affordance. Reading back per-tool grants is tracked as a
 * follow-up against Slice C (see Hard constraints in the Slice E brief).
 */

type AgentGrantMatrixProps = {
  agents: AgentRecord[]
  tools: McpToolRegistryRecord[]
}

const TINY_LABEL = [
  'text-[10px] uppercase tracking-[0.18em] text-[color:var(--tx3)]',
].join(' ')

export const AgentGrantMatrix = ({ agents, tools }: AgentGrantMatrixProps) => {
  const createGrant = useCreateToolGrant()
  const [recent, setRecent] = useState<Record<string, string>>({})

  const cellKey = (toolId: string, agentId: string) => `${toolId}:${agentId}`

  if (agents.length === 0 || tools.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
        Need at least one agent and one tool to build a grant matrix.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--sep)] bg-black/10">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={`${TINY_LABEL} sticky left-0 bg-black/30 px-3 py-2 text-left`}>
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
                  'sticky left-0 bg-black/30 px-3 py-2 text-left',
                  'text-xs font-medium text-white',
                ].join(' ')}
              >
                {tool.label}
                <div className="text-[10px] text-[color:var(--tx3)]">
                  {tool.toolId}
                </div>
              </th>
              {agents.map((agent) => {
                const key = cellKey(tool.id, agent.id)
                const justGranted = recent[key] === 'allowed'
                return (
                  <td className="px-3 py-2 align-top" key={key}>
                    <label className="inline-flex items-center gap-2 text-[color:var(--tx2)]">
                      <input
                        checked={justGranted}
                        onChange={(event) => {
                          if (!event.target.checked) {
                            setRecent((current) => {
                              const next = { ...current }
                              delete next[key]
                              return next
                            })
                            return
                          }
                          createGrant.mutate(
                            {
                              toolRegistryEntryId: tool.id,
                              agentId: agent.id,
                              state: 'allowed',
                            },
                            {
                              onSuccess: () =>
                                setRecent((current) => ({
                                  ...current,
                                  [key]: 'allowed',
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
