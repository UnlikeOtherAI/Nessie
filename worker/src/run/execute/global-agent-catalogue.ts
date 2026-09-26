import type { PrismaClient } from '@prisma/client'
import { loadConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { LedgerIdentityService } from '@nessie/runtime'
import { listExecutorCatalogueFacts } from '@nessie/executor-manage'
import {
  buildGlobalAgentCatalogueBlock,
  getGlobalAgentBlueprint,
  ledgerAgentModelCatalogRequestHeaders,
  listAgentModelOptionsForUser,
  loadAgentToolCatalog,
  resolveAgentAvatarStyleSafely,
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

  // The person this run acts as. A design run in a home DM always has one —
  // the identity gate would have withheld the write verbs otherwise — but the
  // block is also assembled for the shared-channel read-only face, where the
  // portrait style is nobody's in particular and stays unresolved.
  const requesterUserId = input.actorContext.actionContext.effectiveUserId ?? null
  const writeSurface = IDENTITY_WRITE_TOOL_IDS.some((toolId) =>
    input.resolvedToolIds.has(toolId))
    ? 'agent_tools'
    : 'read_only'

  const [catalogue, executors, modelOptions, avatarStyle] = await Promise.all([
    loadAgentToolCatalog(prisma, {
      organizationId: context.channel.organizationId,
    }),
    // Best-effort in exactly the model catalogue's sense: a design
    // conversation is still worth having when a read fails, and `null` is the
    // block's own word for "could not be read", never for "there are none".
    listExecutorCatalogueFacts(prisma, input.actorContext).catch(() => null),
    // The same two sources the model picker composes (`GET /api/agents/models`):
    // the deployment's Ledger catalogue, minus the pairs the organisation or
    // team switched off, and the person's own linked plans. Reading Ledger
    // alone here is how a person who had just linked Kimi under Connected
    // accounts was told no such connector existed. The plans are read only
    // for the face that acts as the person: in a shared room the Designer
    // advises everyone and holds no write verb, so whose plan is linked is
    // nobody's business there.
    listAgentModelOptionsForUser(prisma, {
      config: loadConfig().model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      organizationId: context.channel.organizationId,
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: input.actorContext,
        ledgerIdentity: input.ledgerIdentity,
      }).catch(() => ({})),
      teamId: input.actorContext.tenant.teamId ?? null,
      userId: writeSurface === 'agent_tools' ? requesterUserId : null,
    }).catch(() => null),
    requesterUserId
      ? resolveAgentAvatarStyleSafely(prisma, {
        organizationId: context.channel.organizationId,
        teamId: input.actorContext.tenant.teamId ?? null,
        userId: requesterUserId,
      })
      : null,
  ])

  return buildGlobalAgentCatalogueBlock({
    // What the run actually resolved, never what the blueprint hopes for: a
    // grant verb withheld for this run must not be described as available.
    protectedAccess: {
      canInspect: input.resolvedToolIds.has('agent_tool_access_inspect'),
      canSet: input.resolvedToolIds.has('agent_tool_access_set'),
      canSetDeepWater: input.resolvedToolIds.has('agent_deepwater_access_set'),
    },
    avatarStyle,
    catalogue,
    executors,
    // A restricted verb this run resolved is one of its OWN, and the block
    // must say so: the restricted list's "Personal Assistant only" label is
    // about what a designed agent may hold, and reading it as "not usable
    // here" had the Designer refuse executor grants it was holding the verbs
    // for (docs/plans/2026-09-20-agent-designer-capabilities-and-output-recovery.md).
    heldToolIds: input.resolvedToolIds,
    // A Ledger failure with the person's own plans still readable is said as
    // exactly that — the block must not call it "no models".
    ledgerCatalogueUnavailable: modelOptions?.ledgerError != null,
    models: modelOptions ? modelOptions.options : null,
    writeSurface,
  })
}
