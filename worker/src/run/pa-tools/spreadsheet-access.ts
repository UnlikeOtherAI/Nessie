import {
  canReadSpace,
  canWriteSpace,
  createSpreadsheetService,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
  type SpreadsheetWriteActor,
} from '@nessie/knowledge'
import { attributionFromActorContext, type LedgerAttribution } from '@nessie/runtime'
import { fallbackAgentBackgroundColor } from '@nessie/schemas'

import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { buildSpaceViewerPrincipal } from './access.js'
import { createWorkerKnowledgeProvider } from './knowledge-provider.js'
import {
  canReadPageVersions,
  recordPageVersionRead,
  resolveKnowledgeAccessViewers,
} from './knowledge.js'
import { recordKnowledgeSpaceRead } from './knowledge-basis.js'

/**
 * Who an agent is when it edits a spreadsheet, and what it may reach.
 *
 * Every rule here is the knowledge base's own — `resolveKnowledgeAccessViewers`,
 * `canReadSpace` / `canWriteSpace`, the restricted-tier refusal, the
 * every-version-readable check. A spreadsheet is a document, so a tool that
 * decided any of it differently would be a second, weaker answer to a question
 * the platform already answers, and the difference would be exactly the kind
 * nobody notices until an agent reads something it should not have.
 *
 * The one thing this adds is **the actor's colour**, resolved from the agent
 * record so the cursor a person sees in the grid is the colour of that agent's
 * avatar everywhere else.
 */

/** One answer for "no such page" and "not one this agent can reach". */
export const PAGE_UNREACHABLE = 'Spreadsheet not found, or not one this agent can use.'

export type SpreadsheetToolService = ReturnType<typeof createSpreadsheetService>

/**
 * Built per tool call, like `fileServiceFor`.
 *
 * The model cache is closure state of the factory, so a per-call service means
 * a per-call cache: the first read in a call pays one `fromBytes` plus the
 * journal tail, and the rest of the call reuses it. That is the honest trade —
 * the alternative is module-scope state the worker's replicas may not hold
 * (AGENTS.md), and the cache is explicitly never an authority: it is
 * fast-forwarded from the journal under the page lock before every use.
 */
export const spreadsheetServiceFor = (
  context: BuiltinToolRuntimeContext,
): SpreadsheetToolService => {
  const provider = createWorkerKnowledgeProvider(context)
  return createSpreadsheetService({
    prisma: context.prisma,
    fileService: fileServiceFor(context.prisma),
    // The run's own provider, so a version an agent's edit produces carries the
    // run's disclosure basis and is indexed exactly as any other page's is.
    createPage: (input) => provider.createPage(input),
    addFileVersion: (input) => provider.addFileVersion(input),
    publish: async (event, input) => {
      await context.realtimeTransport.publishDocumentEphemeral(
        input.pageId,
        input.organizationId,
        event,
        input.data,
      )
    },
  })
}

export const spreadsheetAttributionFor = (
  context: BuiltinToolRuntimeContext,
): LedgerAttribution =>
  attributionFromActorContext(context.actorContext, {
    agentId: context.agentId,
    agentKind: context.agentKind,
    runId: context.run.id,
  })

/**
 * The agent, as the journal, the audit row and the presence lane record it.
 *
 * `runId` is what the write door keys the automatic "before: <agent> started
 * editing" version off, so it is not optional decoration: without it an
 * agent's first write to a page takes no safety-net version and the whole
 * no-approval-gate design loses its floor.
 */
export const spreadsheetActorFor = async (
  context: BuiltinToolRuntimeContext,
): Promise<SpreadsheetWriteActor> => {
  const agent = await context.prisma.agent.findFirst({
    where: { id: context.agentId, organizationId: String(context.channel.organizationId) },
    select: { name: true, avatarBackgroundColor: true },
  })
  return {
    type: 'agent',
    id: context.agentId,
    displayName: agent?.name ?? 'Agent',
    agentId: context.agentId,
    runId: context.run.id,
    color: agent?.avatarBackgroundColor ?? fallbackAgentBackgroundColor(context.agentId),
  }
}

export type OpenedSpreadsheet = {
  page: KnowledgePageRecord
  space: KnowledgeSpaceRecord
  canWrite: boolean
}

/**
 * Open a spreadsheet page for this run, or refuse.
 *
 * `mode: 'write'` refuses a restricted space before the general write gate, so
 * an agent is told the actual reason rather than the generic one — the same
 * order `kb_draft_write` uses, and for the same reason: "agents may not write
 * to a restricted knowledge space" is actionable and "you do not have write
 * access" is not.
 */
export const openSpreadsheetPage = async (
  context: BuiltinToolRuntimeContext,
  pageId: string,
  mode: 'read' | 'write',
): Promise<OpenedSpreadsheet> => {
  if (!pageId) throw new Error('pageId is required.')
  const organizationId = String(context.channel.organizationId)
  const provider = createWorkerKnowledgeProvider(context)
  const page = await provider.getPage(organizationId, pageId)
  // A page that is not a spreadsheet is answered the same way a missing one
  // is: which it was is not something to learn by walking ids.
  if (!page || page.kind !== 'spreadsheet') throw new Error(PAGE_UNREACHABLE)

  const space = await provider.getSpace(organizationId, page.spaceId)
  if (!space) throw new Error(PAGE_UNREACHABLE)

  const principal = buildSpaceViewerPrincipal(context)
  const { disclosureViewer, viewer } = await resolveKnowledgeAccessViewers(context)
  if (!canReadSpace(space, viewer)) throw new Error(PAGE_UNREACHABLE)
  if (!(await canReadPageVersions(context, page, disclosureViewer))) {
    throw new Error(PAGE_UNREACHABLE)
  }

  if (mode === 'write') {
    if (principal.actorType === 'agent' && space.sensitivityTier === 'restricted') {
      throw new Error('Agents may not write to a restricted knowledge space.')
    }
    if (!canWriteSpace(space, viewer)) {
      throw new Error('This agent does not have write access to that knowledge space.')
    }
  }

  // Disclosure: what the agent reads here is privileged by the space it came
  // from and by every retained version's own basis, so anything the run says
  // afterwards inherits that boundary.
  recordKnowledgeSpaceRead(context, [space])
  recordPageVersionRead(context, page)

  return { page, space, canWrite: mode === 'write' || canWriteSpace(space, viewer) }
}

/** The space a `sheet_create` is asked for, with the same rules. */
export const openSpreadsheetSpace = async (
  context: BuiltinToolRuntimeContext,
  spaceId: string,
): Promise<KnowledgeSpaceRecord> => {
  if (!spaceId) throw new Error('spaceId is required.')
  const organizationId = String(context.channel.organizationId)
  const provider = createWorkerKnowledgeProvider(context)
  const space = await provider.getSpace(organizationId, spaceId)
  if (!space) throw new Error('Knowledge space not found, or not one this agent can use.')

  const principal = buildSpaceViewerPrincipal(context)
  const { viewer } = await resolveKnowledgeAccessViewers(context)
  if (principal.actorType === 'agent' && space.sensitivityTier === 'restricted') {
    throw new Error('Agents may not write to a restricted knowledge space.')
  }
  if (!canWriteSpace(space, viewer)) {
    throw new Error('This agent does not have write access to that knowledge space.')
  }
  recordKnowledgeSpaceRead(context, [space])
  return space
}
