import {
  applyDeepWaterLaunchTicket,
  applyDeepWaterScopeResult,
  applyDeepWaterStatusRead,
  findDeepWaterBriefRunByResearchId,
  refreshDeepWaterRunIdentity,
  resolveDisclosureViewer,
  toDeepWaterBriefRun,
  unionDeepWaterRunSources,
  viewerSatisfiesBasis,
  type DeepWaterBriefRun,
  type DeepWaterProjectionOutcome,
} from '@nessie/runtime'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  LedgerResearchListSchema,
  LedgerResearchStatusDtoSchema,
  LedgerResearchTicketSchema,
  LedgerScopeResultSchema,
  deepWaterToolAsksToPublish,
  deepWaterToolEditsBrief,
  deepWaterToolResearchId,
} from '@nessie/schemas'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { runDeepWaterTransaction } from '../control/deepwater-announce.js'
import type { ExecutionDependencies, RunContext } from './execute/types.js'
import {
  deepWaterRunBinderContext,
  refused,
  structuredOf,
  withGuidance,
  type DeepWaterBoundDispatch,
  type DeepWaterRunBinderContext,
  type DeepWaterSend,
} from './deepwater-run-binder-context.js'
import { dispatchDeepWaterScopeStart } from './deepwater-run-binder-start.js'
import { plannerWorkingGuidance } from './deepwater-tool-guidance.js'

/**
 * Binds an agent's DeepWater tool calls to their product runs (Water plan
 * nessie.md §7.4, amendments N1, N2, N6, N7, N9.2, amendments-fable F4, F8).
 *
 * The handoff guard still wraps a launcher handoff turn (a message carrying
 * `integrationLaunch`); the binder wraps every other DeepWater call, and the
 * two never overlap: new runs never carry the handoff marker.
 *
 * - `research_scope_start` claims its run before the call leaves.
 * - A call naming a research is resolved to that research's run in this
 *   organisation and team, and must act for the person who asked for it.
 *   Changing a research this team never opened is refused; reading one feeds
 *   the person's own scope.
 * - Reads of a bound research first check that the person can still see
 *   everything it was built from, then feed that basis into this run's sink;
 *   content-bearing calls add this run's sources to the research (N6).
 * - Every answer is applied through the shared projection, and every call
 *   renews the requester's captured sign-in (F4).
 */

export type DeepWaterRunBinder = {
  dispatch: (
    originalToolName: string,
    toolCallId: string | undefined,
    args: Record<string, unknown>,
    send: DeepWaterSend,
  ) => Promise<DeepWaterBoundDispatch>
}

/** Calls that change a research: only the person it belongs to, through their agent, may make them. */
const MUTATIONS: ReadonlySet<string> = new Set(['research_scope_reply', 'research_scope_launch', 'research_cancel'])

/** Calls whose answer carries what the research was built from, so the reader's reach is checked first. */
const CONTENT_READS: ReadonlySet<string> = new Set([
  'research_scope_get',
  'research_scope_reply',
  'research_status',
  'research_report',
])

const plain = async (send: DeepWaterSend, toolCallId: string, args: Record<string, unknown>) =>
  ({ result: await send(toolCallId, args), transportInvoked: true })

/** Everything a research was built from, fed into the reading run (N6, `recordKnowledgeVersionRead`). */
const feedRunSources = (ctx: DeepWaterRunBinderContext, run: DeepWaterBriefRun): void => {
  ctx.consumedSources.addAll(run.sourceScopes)
  for (const source of run.disclosureSources) ctx.consumedSources.addPrivateConversationSource(source)
}

const feedRequester = (ctx: DeepWaterRunBinderContext): void => {
  if (ctx.effectiveUserId) ctx.consumedSources.add({ scopeType: 'user', scopeId: ctx.effectiveUserId })
}

/** Apply a bound call's answer to its brief run, renewing the captured sign-in with it. */
const applyAnswer = async (
  ctx: DeepWaterRunBinderContext,
  run: DeepWaterBriefRun,
  toolName: string,
  structured: unknown,
): Promise<void> => {
  const target = { organizationId: run.organizationId, runId: run.id }
  type Tx = Parameters<typeof applyDeepWaterScopeResult>[0]
  const apply = async (tx: Tx): Promise<DeepWaterProjectionOutcome | null> => {
    if (toolName === 'research_scope_get' || toolName === 'research_scope_reply') {
      const result = LedgerScopeResultSchema.safeParse(structured)
      if (!result.success) return null
      return applyDeepWaterScopeResult(tx, {
        ...target,
        result: result.data,
        ...(toolName === 'research_scope_reply'
          ? { turnAuthor: { kind: 'agent' as const, agentId: ctx.agentId } }
          : {}),
      })
    }
    if (toolName === 'research_scope_launch') {
      const ticket = LedgerResearchTicketSchema.safeParse(structured)
      return ticket.success ? applyDeepWaterLaunchTicket(tx, { ...target, ticket: ticket.data }) : null
    }
    if (toolName === 'research_cancel' || toolName === 'research_status') {
      const status = LedgerResearchStatusDtoSchema.safeParse(structured)
      return status.success ? applyDeepWaterStatusRead(tx, { ...target, status: status.data }) : null
    }
    return null
  }
  try {
    await runDeepWaterTransaction(ctx, async (tx, announce) => {
      const outcome = await apply(tx)
      if (outcome?.applied && outcome.changed) announce.run(outcome.run)
      if (ctx.requesterIdentity) await refreshDeepWaterRunIdentity(tx, { ...target, identity: ctx.requesterIdentity })
    })
  } catch (error) {
    // The call already happened at Ledger and the agent gets its answer; the
    // watch re-reads the research, so the projection catches up there.
    console.error(`[deep-water] could not apply ${toolName} to run ${run.id}; the watch will re-read it`, error)
  }
}

const NOT_OPENED_HERE = 'This research was not opened in this team, so it cannot be changed from here.'
const SOMEONE_ELSES = 'This research belongs to someone else, so it cannot be read or changed for the person you are helping.'
const PUBLISH_REQUIRES_PERSON = 'Only a person can publish research on research.deepwater.live. '
  + 'Launch it without public, or ask them to publish it themselves.'
const SOURCES_OUT_OF_REACH = 'The person you are helping can no longer see everything this research was built from, '
  + 'so it cannot be read for them.'

const dispatchBound = async (
  ctx: DeepWaterRunBinderContext,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  send: DeepWaterSend,
): Promise<DeepWaterBoundDispatch> => {
  const researchId = deepWaterToolResearchId(args)
  // Without an id Ledger refuses the call itself.
  if (!researchId) return plain(send, toolCallId, args)
  const run = ctx.teamId
    ? await findDeepWaterBriefRunByResearchId(ctx.prisma, {
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        researchId,
      })
    : null
  if (!run) {
    if (MUTATIONS.has(toolName)) return refused(DEEP_WATER_BRIEF_ERROR_CODES.RESEARCH_NOT_FOUND, NOT_OPENED_HERE)
    const answer = await plain(send, toolCallId, args)
    if (answer.result.success) feedRequester(ctx)
    return answer
  }
  if (run.requestedByUserId !== ctx.effectiveUserId) {
    return refused(DEEP_WATER_BRIEF_ERROR_CODES.RESEARCH_NOT_FOUND, SOMEONE_ELSES)
  }
  if (toolName === 'research_scope_launch' && deepWaterToolAsksToPublish(args)) {
    return refused('DEEP_WATER_PUBLISH_REQUIRES_PERSON', PUBLISH_REQUIRES_PERSON)
  }
  if (CONTENT_READS.has(toolName) && run.requestedByUserId) {
    const viewer = await resolveDisclosureViewer(ctx.prisma, ctx.organizationId, run.requestedByUserId, {
      uoaIdentity: ctx.uoaIdentity,
    })
    if (!viewerSatisfiesBasis(run.sourceScopes, viewer)) {
      return refused(DEEP_WATER_BRIEF_ERROR_CODES.SOURCE_ACCESS, SOURCES_OUT_OF_REACH)
    }
  }
  const contentBearing = toolName === 'research_scope_reply'
    || (toolName === 'research_scope_launch' && deepWaterToolEditsBrief(args))
  if (contentBearing && run.scopeState !== null) {
    await ctx.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      sourceScopes: ctx.consumedSources.list(),
      disclosureSources: ctx.consumedSources.privateConversationSources(),
    }))
  }

  const answer = await plain(send, toolCallId, args)
  if (!answer.result.success) return answer
  if (CONTENT_READS.has(toolName)) feedRunSources(ctx, run)
  // A launcher run's status belongs to its handoff until it retires (phase E).
  if (run.scopeState !== null) await applyAnswer(ctx, run, toolName, structuredOf(answer.result))
  return toolName === 'research_scope_reply'
    ? { ...answer, result: withGuidance(answer.result, plannerWorkingGuidance(researchId)) }
    : answer
}

/** `research_list`: the person's own research, and what each bound one was built from (N6). */
const dispatchList = async (
  ctx: DeepWaterRunBinderContext,
  toolCallId: string,
  args: Record<string, unknown>,
  send: DeepWaterSend,
): Promise<DeepWaterBoundDispatch> => {
  const answer = await plain(send, toolCallId, args)
  if (!answer.result.success) return answer
  feedRequester(ctx)
  const list = LedgerResearchListSchema.safeParse(structuredOf(answer.result))
  if (!list.success || !ctx.teamId || list.data.jobs.length === 0) return answer
  const rows = await ctx.prisma.productIntegrationRun.findMany({
    where: {
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      productSlug: 'deep-water',
      externalRunId: { in: list.data.jobs.map((job) => job.id) },
    },
  })
  for (const row of rows) feedRunSources(ctx, toDeepWaterBriefRun(row))
  return answer
}

export const createDeepWaterRunBinder = (ctx: DeepWaterRunBinderContext): DeepWaterRunBinder => ({
  dispatch: async (toolName, toolCallId, args, send) => {
    if (!toolCallId) throw new Error('LEDGER_TOOL_CALL_ID_REQUIRED')
    if (toolName === 'research_scope_start') return dispatchDeepWaterScopeStart(ctx, toolCallId, args, send)
    if (toolName === 'research_list') return dispatchList(ctx, toolCallId, args, send)
    // A team still on the launcher contract: ordinary calls are unchanged (N9).
    if (toolName === 'research_start') return plain(send, toolCallId, args)
    return dispatchBound(ctx, toolName, toolCallId, args, send)
  },
})

/** The binder for one agent run, built in run setup beside its toolset. */
export const createRunDeepWaterBinder = (
  deps: Pick<ExecutionDependencies, 'prisma' | 'realtimeTransport'>,
  context: RunContext,
  actorContext: AuthorizedActionContext,
): DeepWaterRunBinder => createDeepWaterRunBinder(deepWaterRunBinderContext({
  prisma: deps.prisma,
  realtime: deps.realtimeTransport,
  actorContext,
  agentId: context.agent.id,
  runId: context.run.id,
  principalUserId: context.run.principalUserId ?? null,
  channelId: context.channel.id,
  threadId: context.run.threadId,
  consumedSources: context.consumedSources,
}))
