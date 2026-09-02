import type { PrismaClient } from '@prisma/client'
import type {
  AgentEffort,
  AgentOwner,
  AgentRecord,
  AgentRunLimits,
} from '@nessie/schemas'

import { findEntitledAgent, type AgentEntitlementScope } from './agent-list.js'

/**
 * Reading ONE agent's record, for the person asking.
 *
 * There is no per-agent record route to mirror — the admin detail page reads
 * the record out of the entitled list — so this applies exactly that list
 * entitlement (`buildVisibleAgentWhere` + `buildAgentVisibilityWhere`, plus the
 * organization owner's unbound arm) to a single id and returns the same
 * `AgentRecord` projection. An agent the caller could not have listed reads as
 * absent.
 *
 * A `systemManaged` target answers with **configuration only**. A global agent
 * is an organization-wide singleton whose activity spans every member's private
 * DM, so its runs, messages, children and other people's bindings stay closed;
 * what it *is* — name, role, instructions, policy, model, effort, limits — is
 * app-provided vendor configuration and is exactly what the read-only global
 * detail view renders.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D4, D7).
 */

export type AgentConfigProjection = {
  agentKind?: 'personal_assistant' | 'shared'
  effort?: AgentEffort
  id: string
  model?: string
  name: string
  owner: AgentOwner | null
  provider?: string
  role: string
  runLimits?: AgentRunLimits
  systemManaged: boolean
  systemPrompt?: string
  todosEnabled: boolean
  toolPolicy?: Record<string, boolean>
  visibility: 'private' | 'workspace'
}

export type AgentReadResult = {
  /**
   * Always present: the configuration half, which every reader of the agent may
   * see.
   */
  config: AgentConfigProjection
  /**
   * The full record, including activity and the bindings this caller can see.
   * Null for a blueprint-managed agent — deliberately, not incidentally.
   */
  record: AgentRecord | null
}

/** The configuration half of a record. Never the activity half. */
export const toAgentConfigProjection = (
  record: AgentRecord,
): AgentConfigProjection => ({
  ...(record.agentKind ? { agentKind: record.agentKind } : {}),
  ...(record.effort ? { effort: record.effort } : {}),
  id: record.id,
  ...(record.model ? { model: record.model } : {}),
  name: record.name,
  owner: record.owner ?? null,
  ...(record.provider ? { provider: record.provider } : {}),
  role: record.role,
  ...(record.runLimits ? { runLimits: record.runLimits } : {}),
  systemManaged: record.systemManaged === true,
  ...(record.systemPrompt ? { systemPrompt: record.systemPrompt } : {}),
  todosEnabled: record.todosEnabled,
  ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
  visibility: record.visibility,
})

export const readAgentRecordForActor = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    /** The organization owner role, re-read live by the caller. */
    isOwner: boolean
    organizationId: string
    userId: string
  },
): Promise<AgentReadResult | null> => {
  const scope: AgentEntitlementScope = {
    // A global agent is reachable to read, and answers config-only below.
    includeSystemManaged: true,
    includeUnbound: input.isOwner,
    organizationId: input.organizationId,
    userId: input.userId,
  }
  const record = await findEntitledAgent(prisma, input.agentId, scope)
  if (!record) return null

  return {
    config: toAgentConfigProjection(record),
    record: record.systemManaged ? null : record,
  }
}
