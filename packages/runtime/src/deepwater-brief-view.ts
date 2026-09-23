import {
  DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS,
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefMessageAuthor,
  type DeepWaterBriefView,
  type DeepWaterPlannerTurnView,
  type DeepWaterResearchRunView,
  type DeepWaterResearchRunViewStatus,
  type DeepWaterScopeState,
  type DeepWaterStoredMessage,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

import { isPendingActionInFlight, isSettledTurnStatus } from './deepwater-brief-registers.js'
import type { DeepWaterBriefRun } from './deepwater-brief-run-record.js'
import { deepWaterLauncherCancelRoute } from './deepwater-legacy-cancel.js'
import { isDeepWaterBriefOpening } from './deepwater-local-cancel.js'
import {
  DEEP_WATER_NEEDS_OPERATOR_MESSAGE,
  deepWaterFailureSentence,
  deepWaterPendingActionErrorMessage,
  deepWaterPlannerFailureMessage,
} from './deepwater-brief-view-copy.js'

/**
 * The views of a DeepWater research (Water plan nessie.md §7.2, amendments
 * N2, N10, §7.9), built from its product run in one place so the list, the
 * detail, the brief dialog and the card show the same thing. Pure: the caller
 * supplies what the run does not hold — the report page's space, the planner's
 * display, and the viewer's standing — and decides visibility first
 * (`isDeepWaterRunVisible`). Every view is parsed through its schema, so a
 * run that cannot be shown truthfully fails here instead of reaching a client.
 */

const OPEN_STATUSES: ReadonlySet<ProductIntegrationRunStatus> = new Set(['queued', 'drafting', 'running', 'needs_setup'])

/** Contract §2.4: the status a viewer sees. */
const viewStatus = (run: DeepWaterBriefRun): DeepWaterResearchRunViewStatus => {
  switch (run.status) {
    case 'queued':
      return 'drafting'
    case 'drafting': {
      const action = run.scopeState?.pendingAction ?? null
      return isPendingActionInFlight(action) && action.kind === 'launch' ? 'starting' : 'drafting'
    }
    case 'running':
      return 'running'
    case 'needs_setup':
    case 'failed':
      return 'failed'
    case 'completed':
    case 'warning':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
  }
}

/** What the viewer may do, decided on the server (nessie.md §7.2, amendments N7.4, N8.5). */
export const deepWaterViewerActions = (
  run: DeepWaterBriefRun,
  viewer: { userId: string; canChangeTeam: boolean },
  now: Date,
): DeepWaterResearchRunView['viewer'] => {
  const isRequester = run.requestedByUserId !== null && run.requestedByUserId === viewer.userId
  const brief = run.scopeState
  // A launcher run (no brief) has nothing to edit, start or deliver here; a
  // team owner or admin may cancel one still open, so a disable or a contract
  // upgrade it blocks can be cleared (amendments N8.5, N9.6) — but only one the
  // cancel route can act on: a `running` run with no research id may have a
  // start in flight, and nothing may cancel it until that resolves.
  if (brief === null) {
    // No brief means a launcher row (the binding CHECK), which always carries its facts.
    if (run.launcher === null) throw new Error(`DeepWater run ${run.id} has neither a brief nor launcher facts`)
    const route = deepWaterLauncherCancelRoute({
      status: run.status,
      externalRunId: run.externalRunId,
      startRecorded: run.launcher.startRecorded,
    })
    return {
      canEdit: false,
      canStart: false,
      canCancel: viewer.canChangeTeam && route !== 'not_cancellable',
      canRetryDelivery: false,
    }
  }
  const editable = isRequester
    && run.originKind === 'person'
    && run.status === 'drafting'
    && !isPendingActionInFlight(brief.pendingAction)
  return {
    canEdit: editable,
    canStart: editable,
    // A brief DeepWater may be opening right now has nothing to cancel yet;
    // once it opened, or nothing can open it any more, it can be (N8.5).
    canCancel: OPEN_STATUSES.has(run.status)
      && (isRequester || viewer.canChangeTeam)
      && !isDeepWaterBriefOpening(run, now),
    canRetryDelivery: isRequester
      && run.deliveredAt === null
      && run.deliveryBlockedReason !== null
      && DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS.has(run.deliveryBlockedReason),
  }
}

/**
 * The planner's side of the conversation (N2): register (b), with the action
 * id of the person's action it answers. A reply or opening the planner has not
 * acknowledged yet is already `replying`; a settled turn is `idle`, or
 * `failed` with its own retryable flag and Nessie's words for the code.
 */
export const deepWaterPlannerTurnView = (state: DeepWaterScopeState | null): DeepWaterPlannerTurnView => {
  const turn = state?.turn ?? null
  const action = state?.pendingAction ?? null
  const talking = isPendingActionInFlight(action) && (action.kind === 'reply' || action.kind === 'scope_start')
    ? action
    : null
  const answers = (turnId: string, seq: number): boolean =>
    talking !== null && (talking.turnId === turnId || (talking.turnId === null && talking.kind === 'scope_start' && seq === 1))

  if (turn === null || isSettledTurnStatus(turn.status)) {
    // An action the planner has not taken up yet is newer than any settled turn.
    if (talking !== null && (turn === null || !answers(turn.id, turn.seq))) {
      return { status: 'replying', actionId: talking.actionId, since: talking.since }
    }
    if (turn?.status === 'failed') {
      return {
        status: 'failed',
        actionId: answers(turn.id, turn.seq) ? talking?.actionId ?? null : null,
        retryable: turn.retryable,
        message: deepWaterPlannerFailureMessage(turn.errorCode),
      }
    }
    return { status: 'idle' }
  }
  const matched = answers(turn.id, turn.seq) ? talking : null
  return { status: 'replying', actionId: matched?.actionId ?? null, since: matched?.since ?? null }
}

export type DeepWaterViewContext = {
  viewer: { userId: string; canChangeTeam: boolean }
  /** The Knowledge space of the delivered report page, or null. */
  reportSpaceId: string | null
  /** When the view is built: whether an opening can still be in flight depends on it. */
  now: Date
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

const failureOf = (run: DeepWaterBriefRun): DeepWaterResearchRunView['failure'] => {
  if (run.status === 'needs_setup') return { code: 'needs_operator', message: DEEP_WATER_NEEDS_OPERATOR_MESSAGE }
  if (run.status !== 'failed') return null
  const code = run.failureCode ?? 'failed'
  return { code, message: deepWaterFailureSentence(run.failureCode) }
}

/** The research as a list row, the detail read or the card shows it. */
export const toDeepWaterResearchRunView = (
  run: DeepWaterBriefRun,
  context: DeepWaterViewContext,
): DeepWaterResearchRunView => {
  const brief = run.scopeState?.brief ?? null
  const delivered = run.deliveredAt !== null
  return DeepWaterResearchRunViewSchema.parse({
    id: run.id,
    status: viewStatus(run),
    topic: run.input?.topic ?? run.queryPreview,
    title: run.title,
    pillarCount: brief?.pillars.length ?? run.input?.pillars?.length ?? 0,
    settings: brief?.settings ?? null,
    origin: {
      kind: run.originKind,
      agentId: run.originAgentId,
      channelId: run.channelId,
      threadId: run.threadId,
      rootMessageId: run.input?.originRootMessageId ?? null,
      cardMessageId: run.cardMessageId,
    },
    requestedByUserId: run.requestedByUserId,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.launchedAt),
    completedAt: iso(run.completedAt),
    sourceCount: run.sourceCount,
    report: run.knowledgePageId !== null && context.reportSpaceId !== null
      ? { spaceId: context.reportSpaceId, pageId: run.knowledgePageId }
      : null,
    reportKind: run.reportKind,
    truncated: run.reportTruncated,
    artifacts: delivered ? { report: run.reportFileId !== null, sources: run.sourcesFileId !== null } : null,
    publicUrl: run.publicUrl,
    failure: failureOf(run),
    delivery: {
      state: delivered ? 'delivered' : run.deliveryBlockedReason !== null ? 'blocked' : 'pending',
      blockedReason: run.deliveryBlockedReason,
    },
    viewer: deepWaterViewerActions(run, context.viewer, context.now),
  })
}

/** Who wrote a transcript row: Nessie's own record of the turn, else the brief's opener. */
const messageAuthor = (run: DeepWaterBriefRun, message: DeepWaterStoredMessage): DeepWaterBriefMessageAuthor => {
  if (message.role === 'planner') return { kind: 'planner' }
  if (message.role === 'event') return { kind: 'event' }
  const recorded = message.turnId === null ? undefined : run.scopeState?.turnAuthors[message.turnId]
  if (recorded) return recorded
  const agentId = message.authorKind === 'agent' || run.originKind === 'agent' ? run.originAgentId : null
  if (agentId) return { kind: 'agent', agentId }
  if (run.requestedByUserId) return { kind: 'person', userId: run.requestedByUserId }
  return { kind: 'event' }
}

/** The brief as the dialog shows it: the research view plus the conversation and its state. */
export const toDeepWaterBriefView = (
  run: DeepWaterBriefRun,
  context: DeepWaterViewContext & { planner: { displayName: string; iconUrl: string | null } },
): DeepWaterBriefView => {
  const state = run.scopeState
  const brief = state?.brief ?? null
  const action = state?.pendingAction ?? null
  return DeepWaterBriefViewSchema.parse({
    ...toDeepWaterResearchRunView(run, context),
    revision: brief?.revision ?? null,
    pillars: brief?.pillars ?? run.input?.pillars ?? [],
    lockedSettings: brief?.lockedSettings ?? [],
    ready: brief?.ready ?? false,
    openQuestions: brief?.openQuestions ?? [],
    analysis: brief?.analysis ?? null,
    messages: (brief?.messages ?? []).map((message) => ({
      id: message.id,
      author: messageAuthor(run, message),
      content: message.content,
      createdAt: message.createdAt,
    })),
    plannerTurn: deepWaterPlannerTurnView(state),
    pendingAction: action === null
      ? null
      : {
          kind: action.kind,
          actionId: action.actionId,
          since: action.since,
          error: action.error === null
            ? null
            : { code: action.error.code, message: deepWaterPendingActionErrorMessage(action.error.code) },
        },
    planner: context.planner,
  })
}
