import type { PrismaClient } from '@prisma/client'
import type { AgentConfigView, ResolvedAgentTool } from '@nessie/schemas'

import { readAgentRecordForActor } from './agent-read.js'
import {
  loadAgentToolCatalog,
  type AgentToolCatalog,
} from './agent-tool-catalog.js'
import { getGlobalAgentBlueprint } from './global-agent-blueprints.js'

/**
 * One agent's configuration, for a reader who may look but not touch (D7).
 *
 * `readAgentRecordForActor` already answers the "what is this agent" half under
 * exactly the list entitlement, and answers config-only for a `systemManaged`
 * row. What this adds is the half a person actually reads on a detail page: the
 * tools the agent *has*, resolved against this organisation's live catalogue
 * rather than left as a sparse policy map nobody can interpret.
 *
 * The resolution is the same rule the worker applies at run setup: built-in
 * tools are on unless the policy says `false`; connector and explicit-grant
 * tools are off unless it says `true`. A global agent additionally carries its
 * blueprint's identity-delegated tools, which no policy can grant and which it
 * may only exercise inside its own home conversation — so they are listed as
 * `reserved`, not as something an editor could have switched on.
 */

const resolveTools = (
  catalogue: AgentToolCatalog,
  input: {
    reservedToolIds: readonly string[]
    toolPolicy: Record<string, boolean> | undefined
  },
): ResolvedAgentTool[] => {
  const policy = input.toolPolicy ?? {}
  const reserved = new Set(input.reservedToolIds)
  const tools: ResolvedAgentTool[] = []

  for (const entry of catalogue.togglable) {
    const explicit = policy[entry.key]
    const enabled = explicit ?? entry.defaultEnabled
    if (!enabled) continue
    tools.push({
      group: entry.group,
      key: entry.key,
      label: entry.label,
      source: explicit === undefined ? 'default' : 'policy',
    })
  }

  for (const entry of catalogue.restricted) {
    if (!reserved.has(entry.key)) continue
    tools.push({
      group: entry.group,
      key: entry.key,
      label: entry.label,
      source: 'reserved',
    })
  }

  return tools.sort((left, right) => left.label.localeCompare(right.label))
}

export const readAgentConfigView = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    /** The organization owner role, re-read live by the caller. */
    isOwner: boolean
    organizationId: string
    userId: string
  },
): Promise<AgentConfigView | null> => {
  const read = await readAgentRecordForActor(prisma, input)
  if (!read) return null

  const row = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: { systemSlug: true },
  })
  const blueprint = getGlobalAgentBlueprint(row?.systemSlug)

  const catalogue = await loadAgentToolCatalog(prisma, {
    organizationId: input.organizationId,
  })

  return {
    config: read.config,
    systemSlug: row?.systemSlug ?? null,
    tools: resolveTools(catalogue, {
      reservedToolIds: blueprint?.identityToolIds ?? [],
      toolPolicy: read.config.toolPolicy,
    }),
  }
}
