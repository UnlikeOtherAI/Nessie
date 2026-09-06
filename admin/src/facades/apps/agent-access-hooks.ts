import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useIsOwner } from '../auth/hooks'
import type { AgentToolPolicyTarget } from '@nessie/schemas'

import {
  useAgentToolPolicyTargets,
  useMcpToolRegistry,
  useSetAgentToolPolicyEntry,
  type McpToolRegistryRecord,
} from '../tool-grants/hooks'
import { APPS_QUERY_KEY } from './hooks'

/**
 * Reads and writes for the app detail page's *Agents with access* tab.
 *
 * There is no apps-specific grant endpoint and there must not be one: the
 * verdict this tab edits is `Agent.toolPolicy`, and the one route that writes
 * it — `PATCH /api/mcp/tools/:toolRegistryEntryId/policy-targets/:agentId` — is
 * already in use by the Tools page. This facade wires that route to this
 * surface; it does not restate it.
 *
 * Both reads are owner-only endpoints, so a member's queries stay disabled and
 * the tab falls back to the server's own `agentsWithAccess` list, which
 * `/api/apps/:slug` already scopes by the same entitlement rule as
 * `GET /api/agents`.
 */

export type AppAgentAccessSource = {
  canManage: boolean
  isError: boolean
  isLoading: boolean
  refetch: () => void
  targets: AgentToolPolicyTarget[]
  /**
   * Null for a viewer who may not read the registry at all — distinct from an
   * empty list, which means the app projected nothing.
   */
  tools: McpToolRegistryRecord[] | null
}

export const useAppAgentAccessSource = (): AppAgentAccessSource => {
  const canManage = useIsOwner()
  const toolsQuery = useMcpToolRegistry({}, canManage)
  const targetsQuery = useAgentToolPolicyTargets(canManage)

  return {
    canManage,
    isError: canManage && (toolsQuery.isError || targetsQuery.isError),
    isLoading: canManage && (toolsQuery.isLoading || targetsQuery.isLoading),
    refetch: () => {
      void toolsQuery.refetch()
      void targetsQuery.refetch()
    },
    targets: targetsQuery.data ?? [],
    tools: canManage ? toolsQuery.data ?? null : null,
  }
}

export type SetAppAgentAccessInput = {
  agentId: string
  enabled: boolean
  /** Every callable capability this app projected, in the order they are written. */
  toolRegistryEntryIds: readonly string[]
}

export type SetAppAgentAccessResult = {
  landed: number
  total: number
}

/**
 * Thrown when the fan-out stops part way. `landed` is how many capabilities
 * actually changed, which the row needs in order to say so rather than pretend
 * the switch never moved.
 */
export class AppAgentAccessWriteError extends Error {
  override readonly name = 'AppAgentAccessWriteError'

  constructor(readonly landed: number, readonly total: number, readonly reason: string) {
    super(reason)
  }
}

/**
 * One switch, one write per capability.
 *
 * The route takes a single registry entry because that is the granularity the
 * policy is keyed at; there is no bulk form, and inventing one client-side
 * would be a second write path. The loop is sequential on purpose: each call is
 * a read-modify-write of the same agent's policy under a per-agent advisory
 * lock, so a failure leaves a prefix that landed and a suffix that did not —
 * knowable only if they went in a known order.
 */
export const useSetAppAgentAccess = () => {
  const queryClient = useQueryClient()
  const setPolicyEntry = useSetAgentToolPolicyEntry()

  return useMutation<SetAppAgentAccessResult, Error, SetAppAgentAccessInput>({
    mutationFn: async (input) => {
      const total = input.toolRegistryEntryIds.length
      let landed = 0
      for (const toolRegistryEntryId of input.toolRegistryEntryIds) {
        try {
          await setPolicyEntry.mutateAsync({
            agentId: input.agentId,
            enabled: input.enabled,
            toolRegistryEntryId,
          })
        } catch (caught) {
          throw new AppAgentAccessWriteError(
            landed,
            total,
            caught instanceof Error ? caught.message : 'the change could not be saved.',
          )
        }
        landed += 1
      }
      return { landed, total }
    },
    // Whether an agent can now *reach* the app is the server's answer, not this
    // client's: the detail record is refetched so `agentsWithAccess` and the tab
    // count come back from the same rule the worker enforces. Failures refetch
    // too — a partial fan-out changed real state.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}
