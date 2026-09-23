import {
  DeepWaterAgentGrantMissingError,
  DeepWaterBriefNotReadyError,
  claimAgentOriginRun,
} from '@nessie/mcp-manage'
import {
  applyDeepWaterScopeResult,
  failUnstartedDeepWaterBrief,
  refreshDeepWaterRunIdentity,
  unionDeepWaterRunSources,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  DeepWaterScopeStartToolArgsSchema,
  LedgerScopeResultSchema,
  LedgerToolErrorSchema,
  type DeepWaterRequesterIdentity,
} from '@nessie/schemas'

import { runDeepWaterTransaction } from '../control/deepwater-announce.js'
import { ensureDeepWaterResearchCard } from '../control/deepwater-messages.js'
import { isTransientLedgerRefusal } from './deepwater-ledger-call.js'
import {
  refused,
  structuredOf,
  withGuidance,
  type DeepWaterBoundDispatch,
  type DeepWaterRunBinderContext,
  type DeepWaterSend,
} from './deepwater-run-binder-context.js'
import { plannerWorkingGuidance, scopeStartUncertainGuidance } from './deepwater-tool-guidance.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'

/**
 * An agent's `research_scope_start` (Water plan nessie.md §7.4, amendments N1,
 * N2, N6, N7, N8.2): the product run is claimed before the call leaves, so
 * every brief has a durable addressee — the agent, its thread, the person it
 * acts for and their captured UOA identity — even if the call never returns.
 *
 * The toolset calls this only after tool authorization allowed the call, so a
 * private-conversation refusal writes no row (N7). The claim takes the team
 * transition lock and the agent's policy lock and re-reads the grant there.
 */

const log = (run: DeepWaterBriefRun, what: string): void => {
  console.info(`[deep-water] agent brief ${run.id}: ${what}`)
}

type Claimed = { run: DeepWaterBriefRun; identity: DeepWaterRequesterIdentity }

const claim = async (
  ctx: DeepWaterRunBinderContext,
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<Claimed | DeepWaterBoundDispatch> => {
  const parsed = DeepWaterScopeStartToolArgsSchema.safeParse(args)
  if (!parsed.success) {
    return refused('DEEP_WATER_BRIEF_INVALID', 'The brief arguments are not valid: '
      + parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'} ${issue.message}`).join('; '))
  }
  const requester = ctx.effectiveUserId
  const identity = ctx.requesterIdentity
  if (!requester || !identity || !ctx.teamId) {
    return refused('LEDGER_UOA_IDENTITY_REQUIRED', 'DeepWater research needs the person you act for to be signed in. '
      + 'Tell them to start it themselves with the Research button in this chat.')
  }
  try {
    const claimed = await claimAgentOriginRun(ctx.prisma, {
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      requestedByUserId: requester,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      identity,
      input: { schemaVersion: 1, ...parsed.data, originRootMessageId: null },
      agentId: ctx.agentId,
      originRunId: ctx.runId,
      toolCallId,
      principalUserId: ctx.principalUserId,
      sourceScopes: ctx.consumedSources.list(),
      disclosureSources: ctx.consumedSources.privateConversationSources(),
    })
    if (!claimed.created) {
      // A retried call: whatever this run has read since is part of the brief too.
      await ctx.prisma.$transaction((tx) => unionDeepWaterRunSources(tx, {
        organizationId: ctx.organizationId,
        runId: claimed.run.id,
        sourceScopes: ctx.consumedSources.list(),
        disclosureSources: ctx.consumedSources.privateConversationSources(),
      }))
    }
    return { run: claimed.run, identity }
  } catch (error) {
    if (error instanceof DeepWaterBriefNotReadyError) {
      return refused(error.code, `DeepWater research is not available in this team right now (${error.reason}).`)
    }
    if (error instanceof DeepWaterAgentGrantMissingError) {
      return refused(error.code, 'You are no longer allowed to open DeepWater research briefs here.')
    }
    throw error
  }
}

/** Apply Ledger's answer: attach the research, record this agent as the turn's author, post its card. */
const applyStart = async (ctx: DeepWaterRunBinderContext, claimed: Claimed, structured: unknown) => {
  const result = LedgerScopeResultSchema.safeParse(structured)
  if (!result.success) return null
  const target = { organizationId: ctx.organizationId, runId: claimed.run.id }
  await runDeepWaterTransaction(ctx, async (tx, announce) => {
    const outcome = await applyDeepWaterScopeResult(tx, {
      ...target,
      result: result.data,
      turnAuthor: { kind: 'agent', agentId: ctx.agentId },
    })
    if (!outcome.applied) return log(claimed.run, `start answer not applied (${outcome.reason})`)
    if (outcome.changed) announce.run(outcome.run)
    if (outcome.attached) await ensureDeepWaterResearchCard(tx, announce, target)
    await refreshDeepWaterRunIdentity(tx, { ...target, identity: claimed.identity })
  })
  return result.data.id
}

export const dispatchDeepWaterScopeStart = async (
  ctx: DeepWaterRunBinderContext,
  toolCallId: string,
  args: Record<string, unknown>,
  send: DeepWaterSend,
): Promise<DeepWaterBoundDispatch> => {
  const claimed = await claim(ctx, toolCallId, args)
  if (!('run' in claimed)) return claimed

  let result
  try {
    result = await send(toolCallId, args)
  } catch (error) {
    if (isFatalToolExecutionError(error)) throw error
    // The row stays queued: the watch replays this very call and attaches
    // whatever Ledger keyed to it (N1).
    console.warn(`[deep-water] agent brief ${claimed.run.id}: research_scope_start threw; the watch will replay it`, error)
    return { result: { success: false, output: scopeStartUncertainGuidance, raw: null }, transportInvoked: true }
  }

  if (result.success) {
    const researchId = await applyStart(ctx, claimed, structuredOf(result))
    if (researchId) return { result: withGuidance(result, plannerWorkingGuidance(researchId)), transportInvoked: true }
    console.error(`[deep-water] agent brief ${claimed.run.id}: research_scope_start answered outside the contract`)
    return { result: withGuidance(result, scopeStartUncertainGuidance), transportInvoked: true }
  }

  const refusal = LedgerToolErrorSchema.safeParse(structuredOf(result))
  if (!refusal.success || isTransientLedgerRefusal(refusal.data)) {
    log(claimed.run, 'start not confirmed; the watch will replay it')
    return { result: withGuidance(result, scopeStartUncertainGuidance), transportInvoked: true }
  }
  // Ledger definitively refused: the brief never opened.
  const failureCode = refusal.data.code.replace(/[^a-z_]/g, '_').slice(0, 64) || 'start_rejected'
  await runDeepWaterTransaction(ctx, async (tx, announce) => {
    const failed = await failUnstartedDeepWaterBrief(tx, {
      organizationId: ctx.organizationId,
      runId: claimed.run.id,
      failureCode,
      actionErrorCode: 'rejected',
    })
    if (failed) announce.run(claimed.run)
  })
  log(claimed.run, `start refused (${refusal.data.code})`)
  return { result, transportInvoked: true }
}
