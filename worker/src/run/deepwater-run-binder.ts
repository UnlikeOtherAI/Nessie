import {
  applyDeepWaterLaunchTicket,
  applyDeepWaterScopeResult,
  applyDeepWaterStatusRead,
  findDeepWaterBriefRunByResearchId,
  refreshDeepWaterRunIdentity,
  resolveDisclosureViewer,
  revertDeepWaterAgentLaunch,
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
  LedgerToolErrorSchema,
  deepWaterToolAsksToPublish,
  deepWaterToolEditsBrief,
  deepWaterToolResearchId,
} from '@nessie/schemas'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { runDeepWaterTransaction } from '../control/deepwater-announce.js'
import { revertsLaunch } from '../control/deepwater-brief-action-errors.js'
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
import {
  deepWaterToolRefusal,
  launchRefusedGuidance,
  plannerWorkingGuidance,
} from './deepwater-tool-guidance.js'

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

/**
 * Ledger's answer to a bound call is outside its contract: nothing is applied
 * (the watch's own read brings the run up to date) and the drift is logged.
 */
const outsideContract = (run: DeepWaterBriefRun, toolName: string): null => {
  console.error(`[deep-water] ${toolName} for run ${run.id} answered outside the contract; not applied`)
  return null
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
      if (!result.success) return outsideContract(run, toolName)
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
      return ticket.success
        ? applyDeepWaterLaunchTicket(tx, { ...target, ticket: ticket.data })
        : outsideContract(run, toolName)
    }
    if (toolName === 'research_cancel' || toolName === 'research_status') {
      const status = LedgerResearchStatusDtoSchema.safeParse(structured)
      return status.success
        ? applyDeepWaterStatusRead(tx, { ...target, status: status.data })
        : outsideContract(run, toolName)
    }
    // `research_report` changes nothing the run records; delivery reads it itself.
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

/**
 * Ledger refused the agent's launch. A `scope_*` refusal comes after Ledger
 * put the brief back to drafting (amendments L3), and nothing else here knows
 * it: a read moves a brief on only with proof of launch
 * (`statusStepForLedger`), and the projection never moves back. So a run that
 * is `running` returns to drafting here — the watch's next read moves it on
 * again if Ledger shows it was launched after all — and the agent reads the
 * refusal with what to do next.
 */
const revertRefusedLaunch = async (
  ctx: DeepWaterRunBinderContext,
  run: DeepWaterBriefRun,
  answer: DeepWaterBoundDispatch,
): Promise<DeepWaterBoundDispatch> => {
  const refusal = LedgerToolErrorSchema.safeParse(structuredOf(answer.result))
  if (!refusal.success || !revertsLaunch(refusal.data.code)) return answer
  try {
    await runDeepWaterTransaction(ctx, async (tx, announce) => {
      const reverted = await revertDeepWaterAgentLaunch(tx, { organizationId: run.organizationId, runId: run.id })
      if (!reverted) return
      announce.run(reverted)
      console.info(`[deep-water] run ${run.id}: launch refused (${refusal.data.code}); back to drafting`)
    })
  } catch (error) {
    // The agent still reads Ledger's refusal; the run keeps showing the
    // research as running until a launch lands or the brief ends.
    console.error(`[deep-water] run ${run.id}: could not move a refused launch back to drafting`, error)
  }
  return { ...answer, result: withGuidance(answer.result, launchRefusedGuidance) }
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
  if (!answer.result.success) {
    return toolName === 'research_scope_launch' && run.scopeState !== null
      ? revertRefusedLaunch(ctx, run, answer)
      : answer
  }
  if (CONTENT_READS.has(toolName)) feedRunSources(ctx, run)
  // A launcher run's status belongs to its handoff until it retires (phase E).
  if (run.scopeState !== null) await applyAnswer(ctx, run, toolName, structuredOf(answer.result))
  return toolName === 'research_scope_reply'
    ? { ...answer, result: withGuidance(answer.result, plannerWorkingGuidance(researchId)) }
    : answer
}

const LIST_UNREADABLE = 'DeepWater answered the research list in a form Nessie cannot read, '
  + 'so it was not shown. Read a research by its id instead.'

/**
 * `research_list`: the person's own research, and what each bound one was
 * built from (N6). Every listed research's topic is in the answer, so the
 * answer reaches the agent only once each listed run's basis is in its sink:
 * one Nessie cannot read is withheld, never passed through unbound.
 */
const dispatchList = async (
  ctx: DeepWaterRunBinderContext,
  toolCallId: string,
  args: Record<string, unknown>,
  send: DeepWaterSend,
): Promise<DeepWaterBoundDispatch> => {
  const answer = await plain(send, toolCallId, args)
  if (!answer.result.success) return answer
  const list = LedgerResearchListSchema.safeParse(structuredOf(answer.result))
  if (!list.success) {
    console.error(`[deep-water] research_list for run ${ctx.runId} answered outside the contract; withheld`)
    return {
      result: { success: false, output: deepWaterToolRefusal('DEEP_WATER_LIST_UNREADABLE', LIST_UNREADABLE), raw: null },
      transportInvoked: true,
    }
  }
  feedRequester(ctx)
  if (list.data.jobs.length === 0) return answer
  // Research ids are unique across Nessie, so a listed research bound in any
  // team of this organisation is one of the person's runs.
  const rows = await ctx.prisma.productIntegrationRun.findMany({
    where: {
      organizationId: ctx.organizationId,
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
