import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { useDeepWaterViewerScope } from '../../../facades/deep-water/hooks'
import { deepWaterKeys } from '../../../facades/deep-water/keys'
import {
  useCancelResearchRun,
  useReplyToResearchBrief,
  useStartResearchBrief,
} from '../../../facades/deep-water/mutations'
import { Notice } from '../../primitives/Notice'
import { briefActionFailure } from './brief-action-errors'
import {
  NO_EDITS,
  editsPayload,
  effectiveBrief,
  layerEdits,
  payloadHasEdits,
  pillarCountForStart,
  pillarsProblem,
  withPillarsEdit,
  withSettingEdit,
} from './brief-edits'
import { BriefAnalysisSummary } from './BriefAnalysisSummary'
import { BriefConversation } from './BriefConversation'
import { BriefIdentityNotice } from './BriefIdentityNotice'
import { BriefPillarsEditor } from './BriefPillarsEditor'
import { BriefSettingsEditor, type SettingChange } from './BriefSettingsEditor'
import { answerShowsInFlight } from './brief-sent-action'
import { BriefStartBar } from './BriefStartBar'
import type { ResearchShownIn, StartAgain } from './research-brief-origin'
import { isResearchFinished } from './research-presentation'
import { ResearchRunOutcome } from './ResearchRunOutcome'
import { useBriefDraft } from './useBriefDraft'
import { useIntentActionId } from './useIntentActionId'

/**
 * One research brief, however far it has got (overview §1 goal 2): while it
 * is being agreed, the conversation with DeepWater's planner beside the
 * pillars and settings, with Start; once launched, where it stands and what
 * it produced. The requester of a person's brief edits and starts it; an
 * agent's brief is read-only here, and its requester may only cancel it — the
 * agent does the talking (nessie.md §7.2 `viewer`, decided by the server).
 */

export const BriefWorkspace = ({
  brief,
  meUserId,
  onStartAgain,
  shownIn,
}: {
  brief: DeepWaterBriefView
  meUserId: string
  onStartAgain: StartAgain
  shownIn: ResearchShownIn
}) => {
  const queryClient = useQueryClient()
  const scope = useDeepWaterViewerScope()
  const reply = useReplyToResearchBrief(brief.id)
  const start = useStartResearchBrief(brief.id)
  const cancel = useCancelResearchRun()
  const cancelId = useIntentActionId()
  const {
    changed,
    dismissChanged,
    draft,
    inFlightEdits,
    markSent,
    replyIds: replyId,
    sendAgain,
    setEdits,
    setMessage,
    startIds: startId,
  } = useBriefDraft(brief)
  const [publish, setPublish] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const drafting = brief.status === 'drafting'
  // A Start refused while the brief was still being agreed says so until the
  // brief leaves drafting; once the research is starting, it no longer applies.
  useEffect(() => {
    if (!drafting) setStartError(null)
  }, [drafting])
  const ownBrief = brief.origin.kind === 'person' && brief.requestedByUserId === meUserId
  // A cancel accepted by the API but not carried out yet: DeepWater stops the
  // research a moment later, and until then nothing else is offered. One
  // DeepWater refused comes back with its error and can be tried again.
  const cancelInFlight = brief.pendingAction?.kind === 'cancel' && brief.pendingAction.error === null
  const cancelling = cancel.isPending || cancelInFlight
  // The person keeps editing locally while the planner works (F8); the server
  // decides whether a reply or Start is accepted right now. A brief being
  // discarded is not edited: its unsent edits stay in the draft, and come back
  // if the discard is refused.
  const canEditLocally = ownBrief && drafting && brief.revision !== null && !cancelling
  const edits = canEditLocally ? draft.edits : NO_EDITS
  // What the person sees: DeepWater's brief, the edits of an action still in
  // flight, then their unsent edits on top. Only the unsent ones read "Not
  // sent yet" and ride on the next action.
  const effective = effectiveBrief(brief, layerEdits(inFlightEdits, edits))
  const unsent = effectiveBrief(brief, edits)
  const replying = brief.plannerTurn.status === 'replying'

  const refetchBrief = () => {
    if (scope) void queryClient.invalidateQueries({ queryKey: deepWaterKeys.brief(brief.id, scope) })
  }

  const withEdits = (): { payload: ReturnType<typeof editsPayload>; problem: string | null } => {
    const payload = editsPayload(brief, edits)
    return { payload, problem: payload.pillars ? pillarsProblem(payload.pillars) : null }
  }

  const sendReply = (text: string) => {
    setReplyError(null)
    const { payload, problem } = withEdits()
    if (problem) {
      setReplyError(problem)
      return
    }
    const body = {
      message: text,
      ...(payloadHasEdits(payload) && brief.revision !== null ? { baseRevision: brief.revision, ...payload } : {}),
    }
    const actionId = replyId.take(body)
    const sent = { actionId, edits, kind: 'reply' as const, message: text, revision: brief.revision,
      typed: text === draft.message.trim() }
    reply.mutate({ actionId, ...body }, {
      onError: (error) => {
        const failure = briefActionFailure(error, 'reply')
        replyId.settle(failure.retrySameAction)
        setReplyError(failure.message)
        if (failure.refetch) refetchBrief()
      },
      onSuccess: (answer) => {
        replyId.settle(false)
        markSent({ ...sent, seen: !answerShowsInFlight(sent, answer) })
      },
    })
  }

  const startResearch = () => {
    if (brief.revision === null) return
    setStartError(null)
    const { payload, problem } = withEdits()
    if (problem) {
      setStartError(problem)
      return
    }
    const body = { revision: brief.revision, ...payload, ...(publish ? { public: true } : {}) }
    const actionId = startId.take(body)
    const sent = { actionId, edits, kind: 'start' as const, message: '', revision: brief.revision, typed: false }
    start.mutate({ actionId, ...body }, {
      onError: (error) => {
        const failure = briefActionFailure(error, 'start')
        startId.settle(failure.retrySameAction)
        setStartError(failure.message)
        if (failure.refetch) refetchBrief()
      },
      onSuccess: (answer) => {
        startId.settle(false)
        markSent({ ...sent, seen: !answerShowsInFlight(sent, answer) })
      },
    })
  }

  const cancelResearch = () => {
    setStartError(null)
    const actionId = cancelId.take({ cancel: brief.id })
    cancel.mutate({ actionId, runId: brief.id }, {
      onError: (error) => {
        const failure = briefActionFailure(error, 'cancel')
        cancelId.settle(failure.retrySameAction)
        setStartError(failure.message)
      },
      onSuccess: () => cancelId.settle(false),
    })
  }

  const onSettingChange: SettingChange = (key, value) =>
    setEdits((current) => withSettingEdit(brief, current, key, value))

  const startBlockedReason = (): string | null => {
    if (replying) return `You can start once ${brief.planner.displayName} has replied.`
    if (!brief.viewer.canStart) return 'Wait for your last change to go through.'
    if (brief.revision === null) return `You can start once ${brief.planner.displayName} has answered.`
    if (pillarCountForStart(brief, edits) === 0) return 'Add at least one pillar.'
    return edits.pillars ? pillarsProblem(edits.pillars) : null
  }

  return (
    <div className="flex flex-col gap-4" data-testid="research-brief-workspace">
      <BriefIdentityNotice brief={brief} ownBrief={ownBrief} />
      {changed.length > 0 ? (
        <Notice size="sm" tone="info">
          <span>
            While you were editing, DeepWater changed {changed.join(', ')}. Your changes are kept on top —
            check them before you send.
          </span>{' '}
          <button className="underline" onClick={dismissChanged} type="button">OK</button>
        </Notice>
      ) : null}
      {drafting && brief.origin.kind === 'agent' ? (
        <p className="text-sm text-[color:var(--tx2)]">
          An agent is agreeing this brief with DeepWater. It will ask in the conversation if it needs anything
          from you.
        </p>
      ) : null}
      {!drafting ? (
        <ResearchRunOutcome meUserId={meUserId} onStartAgain={onStartAgain} run={brief} shownIn={shownIn} />
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <BriefConversation
          brief={brief}
          canCompose={canEditLocally}
          canSend={brief.viewer.canEdit}
          error={replyError}
          meUserId={meUserId}
          message={draft.message}
          onMessageChange={setMessage}
          onSend={sendReply}
          sendAgain={sendAgain}
          sending={reply.isPending}
        />
        <div className="flex min-w-0 flex-col gap-6">
          <BriefPillarsEditor
            editable={canEditLocally}
            edited={unsent.pillarsEdited}
            onChange={(pillars) => setEdits((current) => withPillarsEdit(brief, current, pillars))}
            onReset={() => setEdits((current) => withPillarsEdit(brief, current, brief.pillars))}
            pillars={effective.pillars}
          />
          <BriefSettingsEditor
            editable={canEditLocally}
            editedKeys={unsent.editedKeys}
            locked={effective.locked}
            onChange={onSettingChange}
            settings={effective.settings}
          />
          <BriefAnalysisSummary
            analysis={brief.analysis}
            currentDepth={effective.settings.depth}
            onUseSuggestedDepth={canEditLocally && brief.analysis
              ? () => onSettingChange('depth', brief.analysis?.recommendedDepth ?? effective.settings.depth)
              : null}
          />
        </div>
      </div>

      {drafting || (brief.viewer.canCancel && !isResearchFinished(brief.status)) ? (
        <BriefStartBar
          blockedReason={startBlockedReason()}
          brief={brief}
          canOfferStart={ownBrief && drafting}
          cancelling={cancelling}
          error={startError}
          onCancel={brief.viewer.canCancel ? cancelResearch : null}
          onPublishChange={setPublish}
          onStart={startResearch}
          publish={publish}
          starting={start.isPending}
        />
      ) : null}
    </div>
  )
}
