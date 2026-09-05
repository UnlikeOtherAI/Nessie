import type { PrismaClient } from '@prisma/client'
import { loadConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { LedgerIdentityService } from '@nessie/runtime'
import {
  buildGlobalAgentCatalogueBlock,
  getGlobalAgentBlueprint,
  ledgerAgentModelCatalogRequestHeaders,
  listLedgerAgentModels,
  loadAgentToolCatalog,
} from '@nessie/team-admin'

import type { RunContext } from './types.js'

/**
 * The worker's half of the generated capability catalogue (D5).
 *
 * The block itself is built in `@nessie/team-admin` so the Agent Designer
 * page's sidebar renders from the same definition (D9) — what lives here is the
 * run-shaped half: resolving the blueprint from the run's agent, and reading
 * this organisation's live tool and model catalogues.
 *
 * Assembled for agent-DESIGNING runs only: it is large, and no other agent
 * designs agents.
 */

/** The tool ids whose presence means this run can actually write agents. */
const IDENTITY_WRITE_TOOL_IDS = ['agent_create', 'agent_update']

/**
 * Assemble the block for a run, or null when the run's agent does not design
 * agents. Best-effort throughout: the model catalogue is a network read, and a
 * design conversation is still worth having without it.
 */
export const loadGlobalAgentCatalogueBlock = async (
  prisma: PrismaClient,
  context: RunContext,
  input: {
    actorContext: AuthorizedActionContext
    ledgerIdentity: LedgerIdentityService | null
    resolvedToolIds: ReadonlySet<string>
  },
): Promise<string | null> => {
  const blueprint = getGlobalAgentBlueprint(context.agent.systemSlug)
  if (!blueprint) return null
  // "Global agent" is the tier, not the subject. The block is eighteen thousand
  // characters about what an agent can be, and it closes by telling its reader
  // where agents get built — true for the Agent Designer, and false in both
  // halves for a specialist that designs dashboards: it drowned Dashboard
  // Designer's own persona 2.6 to 1 and told it, inside its own home DM, that
  // it was in a shared channel. The blueprint's `identityToolIds` are the
  // structural statement of which specialist may ever hold the design verbs,
  // so they decide who gets the catalogue — `resolvedToolIds` below still
  // decides what this particular run can DO with it.
  if (!IDENTITY_WRITE_TOOL_IDS.some((toolId) => blueprint.identityToolIds.includes(toolId))) {
    return null
  }

  const [catalogue, models] = await Promise.all([
    loadAgentToolCatalog(prisma, {
      organizationId: context.channel.organizationId,
    }),
    listLedgerAgentModels({
      config: loadConfig().model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: input.actorContext,
        ledgerIdentity: input.ledgerIdentity,
      }).catch(() => ({})),
    }).catch(() => null),
  ])

  return buildGlobalAgentCatalogueBlock({
    catalogue,
    models,
    writeSurface: IDENTITY_WRITE_TOOL_IDS.some((toolId) =>
      input.resolvedToolIds.has(toolId))
      ? 'agent_tools'
      : 'read_only',
  })
}
